// ─── XSS Protection ──────────────────────────────────────────────────────
export function esc(str) {
  if (!str && str !== 0) return '';
  str = String(str);  // Convert to string to handle numbers and other types
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Regex Safety ────────────────────────────────────────────────────────
export function escRegex(str) {
  if (!str && str !== 0) return '';
  str = String(str);
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Time Formatting ─────────────────────────────────────────────────────
export function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts + 'Z');
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ─── Scroll Messages to Bottom ───────────────────────────────────────────
export function scrollToBottom() {
  const area = document.getElementById('messagesArea');
  requestAnimationFrame(() => { area.scrollTop = area.scrollHeight; });
}
