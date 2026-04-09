import { state } from './state.js';
import { api, getAdminKey } from './api.js';
import { renderSidebar, renderMainView, renderMessages, updateTurnBadge } from './render.js';
import { closeModals } from './modals.js';
import { esc } from './utils.js';
import { scrollToBottom } from './utils.js';

// roomId from dataset is string, convert to integer
export async function selectRoom(roomId) {
  const id = parseInt(roomId, 10);
  state.currentRoom = id;
  const room = state.rooms.find(r => r.id === id);
  document.getElementById('roomTitle').textContent = room ? room.name : id;
  state.messages = [];
  renderMainView();
  renderMessages();
  renderSidebar();

  try {
    const roomData = await api.get(`/rooms/${id}`);
    if (state.currentRoom !== id) return;
    const roomIndex = state.rooms.findIndex(r => r.id === id);
    if (roomIndex !== -1 && Array.isArray(roomData.agents)) {
      state.rooms[roomIndex].agents = roomData.agents;
      if ('current_turn' in roomData) {
        state.rooms[roomIndex].current_turn = roomData.current_turn;
      }
      renderSidebar();
    }

    const data = await api.get(`/rooms/${id}/messages`);
    if (state.currentRoom !== id) return;
    state.messages = Array.isArray(data.messages) ? [...data.messages].reverse() : [];
    renderMessages();
    updateTurnBadge(id, data.room?.current_turn || null);
    scrollToBottom();
  } catch (e) {
    if (state.currentRoom !== id) return;
    console.error('Failed to load room:', e);
    state.messages = [];
    renderMessages();
    updateTurnBadge(id, null);
    alert(`Failed to load room messages: ${e.message}. Please check your API key in Settings.`);
  }
}

export async function clearRoom() {
  if (!state.currentRoom) return;
  if (!confirm('Clear all messages in this room?')) return;
  try {
    await api.del(`/rooms/${state.currentRoom}/messages`);
    state.messages = [];
    renderMessages();
  } catch (error) {
    alert(`清空消息失败: ${error.message}`);
  }
}

export async function resetRoom() {
  if (!state.currentRoom) return;
  if (!confirm('Reset room discussion status? This will enable discussion mode.')) return;

  const roomId = state.currentRoom;

  try {
    await api.post(`/rooms/${roomId}/discussion/start`, {
      moderator_id: '',
      timeout_seconds: 3600
    });

    const roomData = await api.get(`/rooms/${roomId}`);
    for (const agent of roomData.agents || []) {
      // Discussion route expects agent.id for the :agentId param
      await api.post(`/rooms/${roomId}/agents/${agent.id}/no-comments`, {
        no_comments: false
      });
    }

    const updatedRoom = await api.get(`/rooms/${roomId}`);
    const idx = state.rooms.findIndex(r => r.id === roomId);
    if (idx !== -1) {
      state.rooms[idx] = { ...state.rooms[idx], ...updatedRoom };
    }
    renderSidebar();
    alert('Room reset! Discussion enabled, all agents ready.');
  } catch (error) {
    alert(`重置房间失败: ${error.message}`);
  }
}

export async function stopDiscussion() {
  if (!state.currentRoom) return;
  if (!confirm('Stop discussion? Agents will no longer be triggered.')) return;

  const roomId = state.currentRoom;

  try {
    await api.post(`/rooms/${roomId}/discussion/stop`);

    const updatedRoom = await api.get(`/rooms/${roomId}`);
    const idx = state.rooms.findIndex(r => r.id === roomId);
    if (idx !== -1) {
      state.rooms[idx] = { ...state.rooms[idx], ...updatedRoom };
    }
    renderSidebar();
    alert('Discussion stopped.');
  } catch (e) {
    console.error('Failed to stop discussion:', e);
    alert('Failed to stop discussion: ' + e.message);
  }
}

export async function deleteRoom() {
  if (!state.currentRoom) return;
  if (!confirm('Delete this room and all messages?')) return;
  try {
    await api.del(`/rooms/${state.currentRoom}`);
    state.currentRoom = null;
    state.rooms = state.rooms.filter(r => r.id !== state.currentRoom);
    renderSidebar();
    renderMainView();
  } catch (error) {
    alert(`删除房间失败: ${error.message}`);
  }
}

export async function deleteRoomFromEdit() {
  // editRoomId stores room id (integer)
  const roomId = document.getElementById('editRoomId').value;
  if (!roomId) return;
  if (!confirm('Delete this room and all messages?')) return;
  try {
    await api.del(`/rooms/${roomId}`);
    state.rooms = state.rooms.filter(r => r.id !== parseInt(roomId, 10));
    if (state.currentRoom === parseInt(roomId, 10)) {
      state.currentRoom = null;
      renderMainView();
    }
    renderSidebar();
    closeModals();
  } catch (error) {
    alert(`删除房间失败: ${error.message}`);
  }
}

export function showEditRoom(roomId) {
  // roomId from dataset is string, convert to integer for comparison
  const id = parseInt(roomId, 10);
  const room = state.rooms.find(r => r.id === id);
  if (!room) return;
  closeModals();
  // Store id in hidden input
  document.getElementById('editRoomId').value = room.id;
  document.getElementById('editRoomNameInput').value = room.name;
  document.getElementById('editRoomDescInput').value = room.description || '';
  document.getElementById('editRoomTurnMode').value = room.turn_mode || 'round_robin';
  document.getElementById('editRoomOwnerInput').value = room.owner || '';
  document.getElementById('editRoomPasswordInput').value = '';
  document.getElementById('editRoomClearPassword').checked = false;

  // Use integer a.id for membership check and checkbox values
  const memberIds = new Set((room.agents || []).map(a => a.id));
  const container = document.getElementById('editRoomAgentCheckboxes');
  container.innerHTML = state.agents.length === 0
    ? '<span style="font-size:12px;color:var(--text-muted)">No agents available</span>'
    : state.agents.map(a => `
        <label style="display:flex;align-items:center;gap:10px;padding:8px;border-radius:8px;cursor:pointer;transition:background 0.2s" onmouseover="this.style.background='var(--bg-hover)'" onmouseout="this.style.background='transparent'">
          <input type="checkbox" value="${a.id}" ${memberIds.has(a.id) ? 'checked' : ''} style="width:18px;height:18px">
          ${a.avatar_url
            ? `<img src="${a.avatar_url}" style="width:32px;height:32px;border-radius:50%;object-fit:cover;border:2px solid ${a.color || 'var(--border)'}">`
            : `<div style="width:32px;height:32px;border-radius:50%;background:${a.color || '#6366f1'};display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:600;color:#fff">${esc(a.name.charAt(0).toUpperCase())}</div>`
          }
          <span style="font-weight:500">${esc(a.name)}</span>
        </label>`).join('');

  document.getElementById('editRoomModal').classList.add('visible');
}

export async function saveEditRoom() {
  // id is room id (integer) from editRoomId input
  const id = parseInt(document.getElementById('editRoomId').value, 10);
  const name = document.getElementById('editRoomNameInput').value.trim();
  const description = document.getElementById('editRoomDescInput').value.trim();
  const turn_mode = document.getElementById('editRoomTurnMode').value;
  const checks = document.querySelectorAll('#editRoomAgentCheckboxes input:checked');
  // checkbox values are integer agent ids (as strings), parse to integer
  const agent_ids = Array.from(checks).map(c => parseInt(c.value, 10));
  const owner = document.getElementById('editRoomOwnerInput').value.trim();
  const newPassword = document.getElementById('editRoomPasswordInput').value;
  const clearPassword = document.getElementById('editRoomClearPassword').checked;

  if (!name) return alert('Room name is required');

  const payload = { name, description, turn_mode, agent_ids, owner: owner || null };
  if (clearPassword) {
    payload.room_password = '';
  } else if (newPassword) {
    payload.room_password = newPassword;
  }

  try {
    const updated = await api.patch(`/rooms/${id}`, payload);

    // Find agents by integer id
    const selectedAgents = agent_ids
      .map(aid => state.agents.find(a => a.id === aid))
      .filter(Boolean);
    const idx = state.rooms.findIndex(r => r.id === id);
    if (idx !== -1) state.rooms[idx] = { ...updated, agents: selectedAgents };

    renderSidebar();
    closeModals();

    if (state.currentRoom === id) {
      const room = await api.get(`/rooms/${id}`);
      state.currentRoom = room.id;
      renderMainView();
    }
  } catch (error) {
    alert(`保存房间失败: ${error.message}`);
  }
}

export async function showHistory() {
  if (!state.currentRoom) return;
  const roomId = state.currentRoom;

  try {
    const data = await api.get(`/rooms/${roomId}/topics`);
    const topics = data.topics || [];

    const list = document.getElementById('historyList');
    if (topics.length === 0) {
      list.innerHTML = '<p style="color:var(--text-muted);font-size:13px;text-align:center;padding:24px 0">No discussion topics yet.</p>';
    } else {
      list.innerHTML = topics.map(t => {
        const statusColor = t.status === 'open' ? '#22c55e' : '#94a3b8';
        const countLabel = t.message_count === 1 ? '1 message' : `${t.message_count} messages`;
        return `
        <div style="border:1px solid var(--border);border-radius:8px;padding:12px 14px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
            <span style="flex:1;font-weight:600;font-size:14px">${esc(t.title)}</span>
            <span style="font-size:11px;padding:2px 8px;border-radius:12px;background:${statusColor}22;color:${statusColor};font-weight:600">${t.status}</span>
          </div>
          <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px">${countLabel} &middot; ${t.created_at}</div>
          <div style="display:flex;gap:6px;align-items:center">
            <button
               data-action="export-md"
               data-room="${roomId}"
               data-topic="${t.id}"
               data-title="${esc(t.title)}"
               style="font-size:12px;padding:4px 10px;border:1px solid var(--border);border-radius:5px;cursor:pointer;color:var(--text-primary);background:var(--bg-secondary)"
            >MD</button>
            <button
               data-action="export-html"
               data-room="${roomId}"
               data-topic="${t.id}"
               data-title="${esc(t.title)}"
               style="font-size:12px;padding:4px 10px;border:1px solid var(--border);border-radius:5px;cursor:pointer;color:var(--text-primary);background:var(--bg-secondary)"
            >HTML</button>
            <button
               data-action="delete-topic"
               data-room="${roomId}"
               data-topic="${t.id}"
               data-title="${esc(t.title)}"
               style="font-size:12px;padding:4px 10px;border:1px solid #ef4444;border-radius:5px;cursor:pointer;color:#ef4444;background:rgba(239,68,68,0.1);margin-left:auto"
            >Delete</button>
          </div>
        </div>`;
      }).join('');
    }

    document.getElementById('historyModal').classList.add('visible');
  } catch (e) {
    alert('Failed to load history: ' + e.message);
  }
}

function topicFilename(title, ext) {
  return `${title.replace(/[^a-z0-9\-_ ]/gi, '_')}.${ext}`;
}

export async function exportTopicMd(roomId, topicId, title) {
  try {
    const res = await fetch(`/api/rooms/${roomId}/topics/${topicId}/export?format=md`, {
      headers: { 'X-API-Key': getAdminKey() }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const blob = new Blob([text], { type: 'text/markdown; charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = topicFilename(title, 'md');
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    alert('MD export failed: ' + e.message);
  }
}

export async function exportTopicHtml(roomId, topicId, title) {
  try {
    const res = await fetch(`/api/rooms/${roomId}/topics/${topicId}/export?format=html`, {
      headers: { 'X-API-Key': getAdminKey() }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const blob = new Blob([html], { type: 'text/html; charset=utf-8' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) {
    alert('HTML export failed: ' + e.message);
  }
}


export async function createRoom() {
  const name = document.getElementById('roomNameInput').value.trim();
  const desc = document.getElementById('roomDescInput').value.trim();
  const mode = document.getElementById('roomTurnMode').value;
  const password = document.getElementById('roomPasswordInput').value;
  const checks = document.querySelectorAll('#roomAgentCheckboxes input:checked');
  // checkbox values are integer agent ids (as strings)
  const agentIds = Array.from(checks).map(c => parseInt(c.value, 10));

  if (!name) return alert('Room name is required');

  try {
    const room = await api.post('/rooms', {
      name, description: desc, turn_mode: mode, agent_ids: agentIds, password
    });
    closeModals();
    document.getElementById('roomNameInput').value = '';
    document.getElementById('roomDescInput').value = '';
    document.getElementById('roomPasswordInput').value = '';
    // Navigate to the new room using its id
    selectRoom(room.id);
  } catch (error) {
    alert(`创建房间失败: ${error.message}\n\n请检查是否已设置 Admin API Key`);
  }
}
