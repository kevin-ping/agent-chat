'use strict';
const fs = require('fs');
const path = require('path');
const { Router } = require('express');

const router = Router();

const LOGS_DIR = path.join(__dirname, '../../logs');
const TAIL_BYTES = 20000; // read at most last 20KB per file on connect
const MAX_LINE_LENGTH = 2000;

// PM2 log_date_format: 'YYYY-MM-DD HH:mm:ss' produces lines like:
//   "2026-03-27 10:30:01: <message>"
const PM2_TS_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}):\s*/;

function parseLogLine(line) {
  const m = line.match(PM2_TS_RE);
  if (m) {
    const ts = new Date(m[1]);
    if (!isNaN(ts.getTime())) {
      return { timestamp: ts.toISOString(), message: line.slice(m[0].length), tsFromLine: true };
    }
  }
  return { timestamp: new Date().toISOString(), message: line, tsFromLine: false };
}

const LOG_SOURCES = [
  { file: 'api-sys.log',              service: 'api-sys',           level: 'info'  },
  { file: 'api-agents.log',           service: 'api-agents',        level: 'info'  },
  { file: 'server.log',               service: 'agent-chat-server', level: 'info'  },
  { file: 'server-error.log',         service: 'agent-chat-server', level: 'error' },
  { file: 'agent-monitor.log',        service: 'agent-monitor',     level: 'info'  },
  { file: 'agent-monitor-error.log',  service: 'agent-monitor',     level: 'error' },
];

/**
 * Read approximately the last `lineCount` lines from a file
 * by seeking to (size - TAIL_BYTES) and reading from there.
 * Calls callback(null, lines[]) — empty array if file missing.
 */
function readTail(filePath, lineCount, callback) {
  fs.open(filePath, 'r', (openErr, fd) => {
    if (openErr) return callback(null, []); // file not found → skip

    fs.fstat(fd, (statErr, stat) => {
      if (statErr) {
        fs.close(fd, () => {});
        return callback(null, []);
      }

      const start = Math.max(0, stat.size - TAIL_BYTES);
      const length = stat.size - start;

      if (length === 0) {
        fs.close(fd, () => {});
        return callback(null, []);
      }

      const buf = Buffer.allocUnsafe(length);
      fs.read(fd, buf, 0, length, start, (readErr, bytesRead) => {
        fs.close(fd, () => {});
        if (readErr) return callback(null, []);

        const lines = buf
          .toString('utf8', 0, bytesRead)
          .split('\n')
          .map(l => l.trim())
          .filter(l => l.length > 0)
          .slice(-lineCount);

        callback(null, lines);
      });
    });
  });
}

/**
 * SSE: stream all log files in real-time.
 * GET /api/logs/stream
 * Auth handled by requireAuth middleware upstream.
 */
router.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
  res.flushHeaders();

  let closed = false;
  const watchers = [];

  function send(service, level, rawLine, historical = false) {
    if (closed) return;
    const { timestamp, message, tsFromLine } = parseLogLine(rawLine);
    const entry = JSON.stringify({
      source: service,
      level,
      timestamp,
      historical,
      tsFromLine,
      message: message.slice(0, MAX_LINE_LENGTH),
    });
    res.write(`data: ${entry}\n\n`);
  }

  // Keepalive ping every 25s to prevent proxy timeouts
  const keepalive = setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, 25000);

  function startWatcher(src) {
    const filePath = path.join(LOGS_DIR, src.file);

    // Determine initial lastPosition (start from current EOF)
    fs.stat(filePath, (statErr, stat) => {
      let lastPos = statErr ? 0 : stat.size;

      let watcher;
      try {
        watcher = fs.watch(filePath, (eventType) => {
          if (closed) return;

          fs.stat(filePath, (err2, stat2) => {
            if (err2) return; // file deleted/inaccessible

            if (stat2.size < lastPos) {
              // Log rotation / truncation — restart from beginning
              lastPos = 0;
            }

            if (stat2.size === lastPos) return; // no new bytes

            const readLen = stat2.size - lastPos;
            const buf = Buffer.allocUnsafe(readLen);

            fs.open(filePath, 'r', (openErr, fd) => {
              if (openErr) return;
              fs.read(fd, buf, 0, readLen, lastPos, (readErr, bytesRead) => {
                fs.close(fd, () => {});
                if (readErr || bytesRead === 0) return;

                lastPos += bytesRead;

                buf
                  .toString('utf8', 0, bytesRead)
                  .split('\n')
                  .map(l => l.trim())
                  .filter(l => l.length > 0)
                  .forEach(line => send(src.service, src.level, line));
              });
            });
          });
        });

        watchers.push(watcher);
      } catch (_) {
        // fs.watch may throw if file doesn't exist on some platforms; ignore
      }
    });
  }

  // Phase 1: send tail history for all sources, then start watchers
  let pending = LOG_SOURCES.length;

  LOG_SOURCES.forEach(src => {
    const filePath = path.join(LOGS_DIR, src.file);

    readTail(filePath, 100, (err, lines) => {
      if (!closed) {
        lines.forEach(line => send(src.service, src.level, line, true));
      }

      pending -= 1;
      if (pending === 0 && !closed) {
        // Phase 2: start watching all files
        LOG_SOURCES.forEach(s => startWatcher(s));
      }
    });
  });

  req.on('close', () => {
    closed = true;
    clearInterval(keepalive);
    watchers.forEach(w => {
      try { w.close(); } catch (_) {}
    });
  });
});

module.exports = router;
