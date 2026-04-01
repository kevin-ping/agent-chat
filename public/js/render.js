import { state, ICONS } from './state.js';
import { esc, escRegex, formatTime } from './utils.js';

// Professional color palette for room accents (Soft UI Evolution style)
const ROOM_COLORS = [
  '#6366F1', // Indigo (主品牌色)
  '#10B981', // Emerald (成功/活跃)
  '#8B5CF6', // Violet (优雅/神秘)
  '#0EA5E9', // Sky (冷静/专业)
  '#F59E0B', // Amber (温暖/注意)
  '#F43F5E', // Rose (强调/热情)
  '#14B8A6', // Teal (平衡/稳定)
  '#EC4899', // Pink (友好/亲和)
  '#3B82F6', // Blue (信任/可靠)
  '#84CC16', // Lime (活力/清新)
];

// Get a consistent color from room id using the curated palette
function getRoomColor(id) {
  const num = typeof id === 'number' ? id : parseInt(String(id), 10) || 0;
  const index = (num - 1) % ROOM_COLORS.length; // Room IDs start at 1
  return ROOM_COLORS[Math.abs(index)];
}

// Cache #emptyState once — renderMessages() wipes innerHTML which removes it from the DOM,
// so document.getElementById('emptyState') returns null on subsequent calls.
const _emptyStateEl = document.getElementById('emptyState');

// ─── Sidebar ─────────────────────────────────────────────────────────────
export function renderSidebar() {
  console.log('[renderSidebar] Called, state.rooms:', state.rooms);
  const roomList = document.getElementById('roomList');
  if (!roomList) {
    console.error('[renderSidebar] roomList element not found!');
    return;
  }
  roomList.innerHTML = state.rooms.map(r => {
    // Sort agents by integer id
    const agents = (r.agents || []).slice().sort((a, b) => a.id - b.id);
    const avatarsHtml = agents.map(a => {
      const isActive = a.no_comments !== 0;
      // current_turn is integer agents.id; a.id is also integer — direct comparison
      const isTurn = r.current_turn === a.id;
      const avatarCls = ['room-agent-avatar', isActive ? '' : 'inactive'].filter(Boolean).join(' ');
      const wrapCls = ['avatar-ring-wrap', isTurn ? 'current-turn' : ''].filter(Boolean).join(' ');
      const inner = a.avatar_url
        ? `<img src="${a.avatar_url}" class="${avatarCls}" title="${esc(a.name)}" alt="${esc(a.name)}">`
        : `<div class="${avatarCls}" style="background:${a.color || '#6366f1'}" title="${esc(a.name)}">${esc(a.name.charAt(0).toUpperCase())}</div>`;
      const confirmedBar = a.no_comments === 2 ? '<div class="confirmed-bar"></div>' : '';
      return `<div class="${wrapCls}">${inner}${confirmedBar}</div>`;
    }).join('');

    const placeholderCount = Math.max(0, 7 - agents.length);
    const placeholdersHtml = Array.from({ length: placeholderCount })
      .map(() => `<div class="avatar-ring-wrap"><div class="room-agent-avatar room-agent-avatar--placeholder"></div></div>`)
      .join('');

    const isDiscussionActive = r.discussion === 1;
    const inConfirmation = r.in_confirmation === 1;
    let statusDotCls = 'status-dot status-dot--idle';
    if (r.discussion === 1) {
      statusDotCls = inConfirmation ? 'status-dot status-dot--confirming' : 'status-dot status-dot--active';
    }
    const statusDot = `<span class="${statusDotCls}"></span>`;

    // state.currentRoom is room.id (UUID string); r.id is the room UUID
    const roomColor = getRoomColor(r.id);
    return `
    <div class="room-item ${state.currentRoom === r.id ? 'active' : ''} ${isDiscussionActive ? 'discussion-active' : ''}"
         data-action="select-room" data-room-id="${r.id}"
         style="border-left: 3px solid ${roomColor};">
      <div class="room-info">
        <div class="room-name">${statusDot}${esc(r.name)}${r.has_password ? ' <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.5;vertical-align:middle;margin-left:2px"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>' : ''}</div>
        <div class="room-id" data-action="copy-id" data-id="${esc(r.id)}" title="Click to copy">${esc(r.id)}</div>
        <div class="room-meta">${r.message_count || 0} msgs · ${r.turn_mode}</div>
        <div class="room-agents">${avatarsHtml}${placeholdersHtml}</div>
      </div>
      <button class="icon-btn room-edit-btn" data-action="edit-room" data-room-id="${r.id}" title="Edit room">${ICONS.pencil}</button>
    </div>
  `}).join('');

  const agentList = document.getElementById('agentList');
  const groups = {};
  for (const a of state.agents) {
    const key = a.agent_hook_url || '__no_hook__';
    if (!groups[key]) groups[key] = [];
    groups[key].push(a);
  }
  agentList.innerHTML = Object.entries(groups).map(([key, groupAgents]) => {
    let label;
    if (key === '__no_hook__') {
      label = 'No Hook';
    } else {
      try { label = new URL(key).hostname; } catch { label = key; }
    }
    const items = groupAgents.map(a => {
      const avatarHtml = a.avatar_url
        ? `<img src="${a.avatar_url}" class="agent-avatar-img" alt="${esc(a.name)}">`
        : `<div class="agent-avatar" style="background:${a.color || '#6366f1'}">${esc(a.name.charAt(0).toUpperCase())}</div>`;
      return `
      <div class="agent-item">
        ${avatarHtml}
        <div style="flex:1;min-width:0">
          <div class="agent-name" style="color:${a.color}">${esc(a.name)}</div>
          <div class="agent-id">${esc(a.agent_id)}</div>
        </div>
        <button class="icon-btn agent-edit-btn" data-action="edit-agent" data-agent-id="${a.agent_id}" title="Edit agent">${ICONS.pencil}</button>
      </div>`;
    }).join('');
    const collapsed = state.collapsedGroups.has(key);
    return `<div class="agent-group${collapsed ? ' collapsed' : ''}" data-group-key="${esc(key)}">
      <div class="agent-group-label" data-action="toggle-group" data-group-key="${esc(key)}">
        <span class="agent-group-chevron">${ICONS.chevronDown}</span>${esc(label)}
      </div>
      <div class="agent-group-items">${items}</div>
    </div>`;
  }).join('');
}

// ─── Main View ───────────────────────────────────────────────────────────
export function renderMainView() {
  const header = document.getElementById('chatHeader');

  if (!state.currentRoom) {
    header.style.display = 'none';
    _emptyStateEl.style.display = 'flex';
    const area = document.getElementById('messagesArea');
    area.innerHTML = '';
    area.appendChild(_emptyStateEl);
    return;
  }

  header.style.display = 'flex';
  _emptyStateEl.style.display = 'none';
}

// ─── Messages ────────────────────────────────────────────────────────────
export function renderMessages(highlight = null) {
  const area = document.getElementById('messagesArea');
  if (state.messages.length === 0) {
    area.innerHTML = `
      <div class="empty-state">
        <div class="icon">${ICONS.messageSquare}</div>
        <h3>No messages yet</h3>
        <p>Agents can post via the API, or you can send a test message below.</p>
      </div>`;
    return;
  }

  area.innerHTML = state.messages.map(m => {
    if (m.msg_type === 'system') {
      return `<div class="message system"><div class="message-content">${esc(m.content)}</div></div>`;
    }

    let content = esc(m.content);
    if (highlight) {
      const re = new RegExp(`(${escRegex(highlight)})`, 'gi');
      content = content.replace(re, '<span class="search-highlight">$1</span>');
    }

    // Use m.id for message identity (m.id is now integer, m.id is UUID string)
    const isSelected = state.selectedMessages.includes(m.id);

    return `
      <div class="message ${state.selectMode ? 'selectable' : ''} ${isSelected ? 'selected' : ''}"
           data-message-id="${m.id}"
           ${state.selectMode ? 'data-action="toggle-select"' : ''}>
        <div class="message-avatar" style="background:${m.color || '#333'}22">
          ${m.avatar_url
            ? `<img src="${m.avatar_url}" class="message-avatar-img" alt="${esc(m.agent_name)}">`
            : `<span style="color:${m.color || '#6366f1'};font-weight:600">${m.agent_name ? esc(m.agent_name.charAt(0).toUpperCase()) : '?'}</span>`}
        </div>
        <div class="message-body">
          <div class="message-header">
            <span class="message-author" style="color:${m.color || '#e4e4e8'}">${esc(m.agent_name || 'Unknown')}</span>
            <span class="message-seq">#${m.sequence}</span>
            <span class="message-time">${formatTime(m.created_at)}</span>
            <button class="message-delete-btn" data-action="delete-message" data-message-id="${m.id}" title="Delete this message">${ICONS.trash}</button>
            ${state.selectMode ? `<input type="checkbox" class="message-checkbox" data-action="checkbox-select" data-id="${m.id}" ${isSelected ? 'checked' : ''}>` : ''}
          </div>
          <div class="message-content">${content}</div>
        </div>
      </div>`;
  }).join('');
}

// ─── Turn Badge ──────────────────────────────────────────────────────────
// roomId is guid (UUID string); currentTurn is integer agents.id
export function updateTurnBadge(roomId, currentTurn) {
  const roomIdx = state.rooms.findIndex(r => r.id === roomId);
  if (roomIdx !== -1) {
    state.rooms[roomIdx].current_turn = currentTurn !== undefined ? currentTurn : null;
  }
  renderSidebar();
  const badge = document.getElementById('turnBadge');
  if (badge) badge.style.display = 'none';
}
