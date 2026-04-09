import { logState, LOG_SERVICE_COLORS } from './state.js';
import { getAdminKey } from './api.js';

export function logServiceColor(service) {
  return LOG_SERVICE_COLORS[service] || '#6b7280';
}

export function logFormatTime(isoStr) {
  const d = new Date(isoStr);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

// ── Unified visibility filter ─────────────────────────────────────────────
function isEntryVisible(entry) {
  if (logState.hiddenServices.has(entry.source)) return false;
  if (logState.errorOnly && entry.level !== 'error') return false;
  if (logState.searchQuery && !entry.message.toLowerCase().includes(logState.searchQuery)) return false;
  return true;
}

// ── Smart message parser ──────────────────────────────────────────────────
function parseLogMessage(message) {
  const frag = document.createDocumentFragment();

  // Branch 1: API request line — [AgentName] METHOD URL STATUS
  const apiMatch = message.match(/^(?:\[([^\]]+)\] )?(GET|POST|PUT|PATCH|DELETE) (\S+)(?: (\d{3}))?(.*)$/);
  if (apiMatch) {
    const [, agentName, method, url, status, rest] = apiMatch;
    if (agentName) {
      const a = document.createElement('span');
      a.className = 'log-token-agent';
      a.textContent = `[${agentName}] `;
      frag.appendChild(a);
    }
    const m = document.createElement('span');
    m.className = `log-token-method log-method-${method}`;
    m.textContent = method;
    frag.appendChild(m);
    frag.appendChild(document.createTextNode(' ' + url));
    if (status) {
      const s = document.createElement('span');
      const bucket = status[0] + 'xx';
      s.className = `log-token-status log-status-${bucket}`;
      s.textContent = status;
      frag.appendChild(s);
    }
    if (rest) frag.appendChild(document.createTextNode(rest));
    return frag;
  }

  // Branch 2: WebSocket event
  if (message.startsWith('[ws] ')) {
    const s = document.createElement('span');
    s.className = 'log-token-ws';
    s.textContent = message;
    frag.appendChild(s);
    return frag;
  }

  // Branch 3: Trigger boundary
  if (message.includes('--- TRIGGER')) {
    const s = document.createElement('span');
    s.className = 'log-token-trigger';
    s.textContent = message;
    frag.appendChild(s);
    return frag;
  }

  // Branch 4: [AgentName] prefix (non-API lines)
  const agentPrefixMatch = message.match(/^(\[[^\]]+\])(.*)/);
  if (agentPrefixMatch) {
    const a = document.createElement('span');
    a.className = 'log-token-agent';
    a.textContent = agentPrefixMatch[1];
    frag.appendChild(a);
    frag.appendChild(document.createTextNode(agentPrefixMatch[2]));
    return frag;
  }

  // Branch 5: Default
  frag.appendChild(document.createTextNode(message));
  return frag;
}

// ── Search highlight ──────────────────────────────────────────────────────
function highlightText(el, query) {
  if (!query) return;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let node;
  while ((node = walker.nextNode())) nodes.push(node);
  nodes.forEach(textNode => {
    const text = textNode.textContent;
    const idx = text.toLowerCase().indexOf(query);
    if (idx === -1) return;
    const mark = document.createElement('mark');
    mark.className = 'log-highlight';
    mark.textContent = text.slice(idx, idx + query.length);
    const after = document.createTextNode(text.slice(idx + query.length));
    textNode.textContent = text.slice(0, idx);
    textNode.after(mark, after);
  });
}

// ── Log count ─────────────────────────────────────────────────────────────
export function updateLogCount() {
  const el = document.getElementById('logCount');
  if (!el) return;
  const visible = document.getElementById('logEntries').children.length;
  el.textContent = `${visible} / ${logState.entries.length}`;
}

export function toggleLogPanel() {
  logState.isOpen = !logState.isOpen;
  document.getElementById('logPanel').classList.toggle('expanded', logState.isOpen);

  if (logState.isOpen) {
    logState.newCount = 0;
    document.getElementById('logBadge').style.display = 'none';

    if (!logState.filtersRendered) {
      renderLogFilters();
      logState.filtersRendered = true;
    }

    if (!logState.eventSource) {
      connectLogStream();
    }

    renderLogEntries();
    if (logState.autoScroll) scrollLogToBottom();
  }
}

export function connectLogStream() {
  const key = getAdminKey();
  const url = '/api/logs/stream' + (key ? `?api_key=${encodeURIComponent(key)}` : '');
  const es = new EventSource(url);

  es.onmessage = (evt) => {
    let entry;
    try { entry = JSON.parse(evt.data); } catch (_) { return; }

    logState.entries.push(entry);
    if (logState.entries.length > logState.MAX_ENTRIES) {
      logState.entries.shift();
    }

    const trackedServices = ['agent-monitor'];
    if (trackedServices.includes(entry.source)) {
      logState.serviceLastSeen[entry.source] = Date.now();
    }

    if (!logState.isOpen) {
      logState.newCount += 1;
      updateLogBar(entry);
    } else {
      if (isEntryVisible(entry)) {
        appendLogEntry(entry);
      }
      if (logState.autoScroll) scrollLogToBottom();
    }

    renderLogBarStatus();
  };

  es.onerror = () => {
    // EventSource auto-reconnects; no manual action needed
  };

  logState.eventSource = es;
}

export function makeLogEntryEl(entry) {
  const color = logServiceColor(entry.source);
  const isError = entry.level === 'error';
  const isHistorical = entry.historical === true;
  const isCurl = entry.message.includes('[curl] ');
  const div = document.createElement('div');
  div.className = 'log-entry' + (isError ? ' log-error' : '') + (isHistorical ? ' log-historical' : '') + (isCurl ? ' log-curl' : '');

  // Source badge
  const badge = document.createElement('span');
  badge.className = 'log-source-badge';
  badge.style.background = color;
  const label = entry.source === 'agent-chat-server' ? 'server'
              : entry.source === 'agent-monitor'     ? 'monitor'
              : entry.source === 'api-sys'           ? 'sys'
              : entry.source === 'api-agents'        ? 'agent'
              : entry.source;
  badge.textContent = label;

  // Expand chevron
  const chevron = document.createElement('span');
  chevron.className = 'log-expand-chevron';
  chevron.textContent = '›';

  // Message
  const msg = document.createElement('span');
  msg.className = 'log-message';
  msg.title = entry.message;
  msg.appendChild(parseLogMessage(entry.message));
  if (logState.searchQuery) highlightText(msg, logState.searchQuery);

  // Expand click on message
  msg.addEventListener('click', (e) => {
    e.stopPropagation();
    const expanded = div.classList.toggle('log-entry-expanded');
    chevron.classList.toggle('rotated', expanded);
  });

  // Timestamp
  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = (isHistorical && !entry.tsFromLine) ? '--:--:--' : logFormatTime(entry.timestamp);
  time.title = new Date(entry.timestamp).toLocaleString('sv-SE');

  // Copy button
  const copyBtn = document.createElement('button');
  copyBtn.className = 'log-copy-btn';
  copyBtn.title = 'Copy';
  copyBtn.textContent = '⎘';
  copyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const timeStr = logFormatTime(entry.timestamp);
    const text = `[${timeStr}] [${label}] ${entry.message}`;
    navigator.clipboard.writeText(text).then(() => {
      copyBtn.textContent = '✓';
      setTimeout(() => { copyBtn.textContent = '⎘'; }, 1200);
    });
  });

  div.appendChild(badge);
  div.appendChild(chevron);
  div.appendChild(msg);
  div.appendChild(time);
  div.appendChild(copyBtn);
  return div;
}

export function appendLogEntry(entry) {
  const container = document.getElementById('logEntries');
  container.appendChild(makeLogEntryEl(entry));
  updateLogCount();
}

export function renderLogEntries() {
  const container = document.getElementById('logEntries');
  container.innerHTML = '';
  const frag = document.createDocumentFragment();
  logState.entries.forEach(entry => {
    if (isEntryVisible(entry)) {
      frag.appendChild(makeLogEntryEl(entry));
    }
  });
  container.appendChild(frag);
  updateLogCount();
}

export function renderLogFilters() {
  const services = Object.keys(LOG_SERVICE_COLORS);
  const container = document.getElementById('logFilters');
  container.innerHTML = '';

  // ERROR-only filter
  const errLabel = document.createElement('label');
  errLabel.className = 'log-filter-label log-filter-error';
  const errCb = document.createElement('input');
  errCb.type = 'checkbox';
  errCb.checked = logState.errorOnly;
  errCb.onchange = () => {
    logState.errorOnly = errCb.checked;
    renderLogEntries();
    if (logState.autoScroll) scrollLogToBottom();
  };
  errLabel.appendChild(errCb);
  errLabel.appendChild(document.createTextNode('ERROR'));
  container.appendChild(errLabel);

  // Service filters
  services.forEach(service => {
    const label = document.createElement('label');
    label.className = 'log-filter-label';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !logState.hiddenServices.has(service);
    cb.onchange = () => {
      if (cb.checked) logState.hiddenServices.delete(service);
      else logState.hiddenServices.add(service);
      renderLogEntries();
      if (logState.autoScroll) scrollLogToBottom();
    };

    const dot = document.createElement('span');
    dot.className = 'log-filter-dot';
    dot.style.background = logServiceColor(service);

    const abbr = service === 'agent-chat-server' ? 'server'
               : service === 'agent-monitor'     ? 'monitor'
               : service === 'api-sys'           ? 'sys'
               : service === 'api-agents'        ? 'agent'
               : service;

    label.appendChild(cb);
    label.appendChild(dot);
    label.appendChild(document.createTextNode(abbr));
    container.appendChild(label);
  });
}

export function updateLogBar(entry) {
  const badge = document.getElementById('logBadge');
  if (logState.newCount > 0) {
    badge.textContent = logState.newCount > 99 ? '99+' : String(logState.newCount);
    badge.style.display = 'inline';
  } else {
    badge.style.display = 'none';
  }
  if (entry) {
    const snippet = document.getElementById('logSnippet');
    snippet.textContent = entry.message.slice(0, 80);
  }
}

export function clearLogPanel() {
  logState.entries = [];
  document.getElementById('logEntries').innerHTML = '';
  updateLogCount();
}

export function scrollLogToBottom() {
  const el = document.getElementById('logEntries');
  requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
}

export function renderLogBarStatus() {
  const container = document.getElementById('logBarStatus');
  if (!container) return;

  const ACTIVE_MS = 5 * 60 * 1000;
  const now = Date.now();

  const services = [
    {
      label: 'server',
      getSvcState: () => logState.wsConnected ? 'connected' : 'disconnected',
    },
    {
      label: 'monitor',
      getSvcState: () => (logState.serviceLastSeen['agent-monitor'] && now - logState.serviceLastSeen['agent-monitor'] < ACTIVE_MS) ? 'active' : 'idle',
    },
  ];

  container.innerHTML = '';
  services.forEach(({ label, getSvcState }) => {
    const svcState = getSvcState();
    const item = document.createElement('span');
    item.className = 'log-bar-status-item';
    item.title = `${label}: ${svcState}`;
    const dot = document.createElement('span');
    dot.className = `log-bar-status-dot ${svcState}`;
    const text = document.createElement('span');
    text.textContent = label;
    item.appendChild(dot);
    item.appendChild(text);
    container.appendChild(item);
  });
}
