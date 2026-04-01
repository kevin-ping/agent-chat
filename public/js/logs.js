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

    const trackedServices = ['room-trigger', 'timeout-daemon'];
    if (trackedServices.includes(entry.source)) {
      logState.serviceLastSeen[entry.source] = Date.now();
    }

    if (!logState.isOpen) {
      logState.newCount += 1;
      updateLogBar(entry);
    } else {
      if (!logState.hiddenServices.has(entry.source)) {
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

  const badge = document.createElement('span');
  badge.className = 'log-source-badge';
  badge.style.background = color;
  const label = entry.source === 'agent-chat-server' ? 'server'
              : entry.source === 'timeout-daemon'    ? 'daemon'
              : entry.source === 'api-sys'           ? 'sys'
              : entry.source === 'api-agents'        ? 'agent'
              : entry.source;
  badge.textContent = label;

  const msg = document.createElement('span');
  msg.className = 'log-message';
  msg.textContent = entry.message;
  msg.title = entry.message;

  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = (isHistorical && !entry.tsFromLine) ? '--:--:--' : logFormatTime(entry.timestamp);

  div.appendChild(badge);
  div.appendChild(msg);
  div.appendChild(time);
  return div;
}

export function appendLogEntry(entry) {
  const container = document.getElementById('logEntries');
  container.appendChild(makeLogEntryEl(entry));
}

export function renderLogEntries() {
  const container = document.getElementById('logEntries');
  container.innerHTML = '';
  const frag = document.createDocumentFragment();
  logState.entries.forEach(entry => {
    if (!logState.hiddenServices.has(entry.source)) {
      frag.appendChild(makeLogEntryEl(entry));
    }
  });
  container.appendChild(frag);
}

export function renderLogFilters() {
  const services = Object.keys(LOG_SERVICE_COLORS);
  const container = document.getElementById('logFilters');
  container.innerHTML = '';
  services.forEach(service => {
    const label = document.createElement('label');
    label.className = 'log-filter-label';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
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
               : service === 'timeout-daemon'    ? 'daemon'
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
      label: 'room-trigger',
      getSvcState: () => (logState.serviceLastSeen['room-trigger'] && now - logState.serviceLastSeen['room-trigger'] < ACTIVE_MS) ? 'active' : 'idle',
    },
    {
      label: 'daemon',
      getSvcState: () => (logState.serviceLastSeen['timeout-daemon'] && now - logState.serviceLastSeen['timeout-daemon'] < ACTIVE_MS) ? 'active' : 'idle',
    },
  ];

  container.innerHTML = '';
  services.forEach(({ label, getSvcState }) => {
    const svcState = getSvcState();
    const item = document.createElement('span');
    item.className = 'log-bar-status-item';
    const dot = document.createElement('span');
    dot.className = `log-bar-status-dot ${svcState}`;
    const text = document.createElement('span');
    text.textContent = `${label}: ${svcState}`;
    item.appendChild(dot);
    item.appendChild(text);
    container.appendChild(item);
  });
}
