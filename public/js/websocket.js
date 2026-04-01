import { state, logState } from './state.js';
import { renderLogBarStatus } from './logs.js';
import { api, authHeaders } from './api.js';
import { renderSidebar, renderMainView, renderMessages, updateTurnBadge } from './render.js';
import { scrollToBottom } from './utils.js';
import { selectRoom } from './rooms.js';

let ws = null;

export function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.onopen = () => {
    console.log('[WS] Connected');
    logState.wsConnected = true;
    renderLogBarStatus();
  };

  ws.onclose = () => {
    logState.wsConnected = false;
    renderLogBarStatus();
    setTimeout(connectWS, 2000);
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    console.log('[WS] Message:', data.type, data);
    handleWSMessage(data);
  };
}

// NOTE: state.currentRoom stores room.id (integer).
// WS events use room_id as integer id. Messages use id field for identity.
async function handleWSMessage(data) {
  switch (data.type) {
    case 'connected':
      console.log('[WS] Connected event - rooms:', data.rooms?.length, 'agents:', data.agents?.length);
      state.rooms = data.rooms;
      state.agents = data.agents;
      console.log('[WS] state.rooms after set:', state.rooms);
      renderSidebar();
      break;

    case 'new_message': {
      if (state.currentRoom === data.room_id) {
        state.messages.push(data.message);
        renderMessages();
        scrollToBottom();
      }
      const nmRoomIdx = state.rooms.findIndex(r => r.id === data.room_id);
      if (nmRoomIdx !== -1) {
        state.rooms[nmRoomIdx].message_count = (state.rooms[nmRoomIdx].message_count || 0) + 1;
      }
      updateTurnBadge(data.room_id, data.current_turn);
      break;
    }

    case 'room_created':
      if (!state.rooms.find(r => r.id === data.room.id)) {
        state.rooms.push(data.room);
        renderSidebar();
      }
      break;

    case 'room_deleted':
      state.rooms = state.rooms.filter(r => r.id !== data.room_id);
      if (state.currentRoom === data.room_id) {
        state.currentRoom = null;
        state.messages = [];
        renderMainView();
      }
      renderSidebar();
      break;

    case 'room_updated': {
      const idx = state.rooms.findIndex(r => r.id === data.room.id);
      if (idx !== -1) {
        const prevAgents = state.rooms[idx].agents || [];
        state.rooms[idx] = data.room;
        if (!state.rooms[idx].agents) state.rooms[idx].agents = prevAgents;
        renderSidebar();
      }
      break;
    }

    case 'room_agents_updated': {
      const roomIdx = state.rooms.findIndex(r => r.id === data.room_id);
      if (roomIdx !== -1) {
        state.rooms[roomIdx].agents = data.agents || [];
        renderSidebar();
      }
      break;
    }

    case 'agents_rooms_updated': {
      const arRoomIdx = state.rooms.findIndex(r => r.id === data.room_id);
      if (arRoomIdx !== -1) {
        state.rooms[arRoomIdx].agents = data.agents || [];
        renderSidebar();
      }
      break;
    }

    case 'discussion_started': {
      const dsRoomIdx = state.rooms.findIndex(r => r.id === data.room_id);
      if (dsRoomIdx !== -1) {
        state.rooms[dsRoomIdx].discussion = 1;
        state.rooms[dsRoomIdx].agents = data.agents || [];
        renderSidebar();
      }
      break;
    }

    case 'discussion_stopped': {
      const dsStopRoomIdx = state.rooms.findIndex(r => r.id === data.room_id);
      if (dsStopRoomIdx !== -1) {
        state.rooms[dsStopRoomIdx].discussion = 0;
        state.rooms[dsStopRoomIdx].agents = data.agents || [];
        renderSidebar();
      }
      break;
    }

    case 'agent_created':
      if (!state.agents.find(a => a.agent_id === data.agent.agent_id)) {
        state.agents.push(data.agent);
        renderSidebar();
      }
      break;

    case 'messages_cleared':
      if (state.currentRoom === data.room_id) {
        state.messages = [];
        renderMessages();
      }
      break;

    case 'message_deleted':
      if (state.currentRoom === data.room_id) {
        // messages use guid for identity in WS events
        state.messages = state.messages.filter(m => m.id !== data.message_id);
        renderMessages();
      }
      break;

    case 'messages_deleted':
      if (state.currentRoom === data.room_id) {
        state.messages = state.messages.filter(m => !data.message_ids.includes(m.id));
        renderMessages();
      }
      break;

    case 'topic_deleted': {
      // Reload messages if we're in the affected room
      if (state.currentRoom === data.room_id) {
        await selectRoom(data.room_id);
      }
      // If history modal is open, refresh it
      const historyModal = document.getElementById('historyModal');
      if (historyModal && historyModal.classList.contains('visible')) {
        const { showHistory } = await import('./rooms.js');
        await showHistory();
      }
      break;
    }

    case 'turn_changed':
      updateTurnBadge(data.room_id, data.current_turn);
      break;
  }
}

export function pollRoomParticipants() {
  if (!state.currentRoom) return;

  // state.currentRoom is an integer id, which is what the API expects
  fetch(`/api/rooms/${state.currentRoom}`, { headers: authHeaders() })
    .then(async (res) => {
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      return json;
    })
    .then(roomData => {
      if (roomData && Array.isArray(roomData.agents)) {
        const idx = state.rooms.findIndex(r => r.id === state.currentRoom);
        if (idx !== -1) {
          state.rooms[idx].agents = roomData.agents;
          if ('current_turn' in roomData) {
            state.rooms[idx].current_turn = roomData.current_turn;
          }
          renderSidebar();
        }
      }
    })
    .catch(err => {
      console.error('Failed to poll room participants:', err);
    });
}
