import { initTheme, toggleTheme } from './theme.js';
import { connectWS, pollRoomParticipants } from './websocket.js';
import { toggleLogPanel, clearLogPanel, scrollLogToBottom, renderLogEntries, updateLogCount } from './logs.js';
import { state, logState } from './state.js';
import { renderSidebar } from './render.js';
import { showModal, showSettings, closeModals, saveAdminKey } from './modals.js';
import { toggleSearch, handleSearch } from './search.js';
import { toggleSelectMode, deleteSelectedMessages, deleteMessage, toggleMessageSelect, handleCheckboxChange } from './messages.js';
import { selectRoom, clearRoom, resetRoom, stopDiscussion, deleteRoom, deleteRoomFromEdit, showEditRoom, saveEditRoom, createRoom, showHistory } from './rooms.js';
import { createAgent, showEditAgent, saveEditAgent, previewAvatar, uploadAvatar } from './agents.js';
import { api } from './api.js';

// ─── Init ─────────────────────────────────────────────────────────────────
initTheme();

// Check for API Key on startup
checkApiKeyAndShowPrompt();

connectWS();

// ─── Polling ─────────────────────────────────────────────────────────────
setInterval(pollRoomParticipants, 10000);
pollRoomParticipants();

// ─── Log Auto-scroll Listener ────────────────────────────────────────────
document.getElementById('logAutoScroll').addEventListener('change', (e) => {
  logState.autoScroll = e.target.checked;
  if (logState.autoScroll) scrollLogToBottom();
});

// ─── Modal Overlay: click outside to close ───────────────────────────────
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModals();
  });
});

// ─── Header Buttons ──────────────────────────────────────────────────────
document.getElementById('themeToggle').addEventListener('click', toggleTheme);

document.querySelector('[data-btn="settings"]').addEventListener('click', showSettings);
document.querySelector('[data-btn="new-room"]').addEventListener('click', () => showModal('room'));
document.querySelector('[data-btn="new-agent"]').addEventListener('click', () => showModal('agent'));

document.querySelector('[data-btn="select-mode"]').addEventListener('click', toggleSelectMode);
document.querySelector('[data-btn="search"]').addEventListener('click', toggleSearch);
document.querySelector('[data-btn="show-history"]').addEventListener('click', showHistory);
document.querySelector('[data-btn="stop-discussion"]').addEventListener('click', stopDiscussion);
document.querySelector('[data-btn="clear-room"]').addEventListener('click', clearRoom);
document.querySelector('[data-btn="reset-room"]').addEventListener('click', resetRoom);

document.querySelector('[data-btn="delete-selected"]').addEventListener('click', deleteSelectedMessages);
document.querySelector('[data-btn="cancel-select"]').addEventListener('click', toggleSelectMode);

// ─── Log Panel Bar ───────────────────────────────────────────────────────
document.getElementById('logPanelBar').addEventListener('click', toggleLogPanel);
document.querySelector('[data-btn="clear-log"]').addEventListener('click', clearLogPanel);
document.getElementById('logSearchInput').addEventListener('input', (e) => {
  logState.searchQuery = e.target.value.trim().toLowerCase();
  renderLogEntries();
  if (logState.autoScroll) scrollLogToBottom();
});

// ─── Search Input ────────────────────────────────────────────────────────
document.getElementById('searchInput').addEventListener('input', (e) => handleSearch(e.target.value));

// ─── Settings Modal Buttons ───────────────────────────────────────────────
document.querySelector('[data-btn="save-admin-key"]').addEventListener('click', saveAdminKey);

// ─── Agent Modal Buttons ─────────────────────────────────────────────────
document.querySelector('[data-btn="create-agent"]').addEventListener('click', createAgent);
document.querySelector('[data-btn="save-edit-agent"]').addEventListener('click', saveEditAgent);
document.getElementById('editAgentAvatarInput').addEventListener('change', previewAvatar);
document.querySelector('[data-btn="upload-avatar"]').addEventListener('click', uploadAvatar);

// ─── Room Modal Buttons ───────────────────────────────────────────────────
document.querySelector('[data-btn="create-room"]').addEventListener('click', createRoom);
document.querySelector('[data-btn="save-edit-room"]').addEventListener('click', saveEditRoom);
document.querySelector('[data-btn="delete-room-from-edit"]').addEventListener('click', deleteRoomFromEdit);

// ─── "Cancel" buttons in all modals ──────────────────────────────────────
document.querySelectorAll('[data-btn="close-modal"]').forEach(btn => {
  btn.addEventListener('click', closeModals);
});

// ─── Event Delegation: Room List ─────────────────────────────────────────
document.getElementById('roomList').addEventListener('click', (e) => {
  const editBtn = e.target.closest('[data-action="edit-room"]');
  if (editBtn) {
    e.stopPropagation();
    showEditRoom(editBtn.dataset.roomId);
    return;
  }
  const roomItem = e.target.closest('[data-action="select-room"]');
  if (roomItem) {
    selectRoom(roomItem.dataset.roomId);
  }
});

// ─── Event Delegation: Agent List (right panel) ───────────────────────────
document.getElementById('agentList').addEventListener('click', (e) => {
  const toggleLabel = e.target.closest('[data-action="toggle-group"]');
  if (toggleLabel) {
    const key = toggleLabel.dataset.groupKey;
    if (state.collapsedGroups.has(key)) {
      state.collapsedGroups.delete(key);
    } else {
      state.collapsedGroups.add(key);
    }
    renderSidebar();
    return;
  }
  const editBtn = e.target.closest('[data-action="edit-agent"]');
  if (editBtn) {
    showEditAgent(editBtn.dataset.agentId);
  }
});

// ─── Event Delegation: History Modal ─────────────────────────────────────
document.getElementById('historyList').addEventListener('click', async (e) => {
  const mdBtn = e.target.closest('[data-action="export-md"]');
  if (mdBtn) {
    const { room, topic, title } = mdBtn.dataset;
    mdBtn.disabled = true;
    mdBtn.textContent = '...';
    try {
      const { exportTopicMd } = await import('./rooms.js');
      await exportTopicMd(room, topic, title);
    } catch (err) {
      alert('MD export failed: ' + err.message);
    } finally {
      mdBtn.disabled = false;
      mdBtn.textContent = 'MD';
    }
    return;
  }

  const htmlBtn = e.target.closest('[data-action="export-html"]');
  if (htmlBtn) {
    const { room, topic, title } = htmlBtn.dataset;
    htmlBtn.disabled = true;
    htmlBtn.textContent = '...';
    try {
      const { exportTopicHtml } = await import('./rooms.js');
      await exportTopicHtml(room, topic, title);
    } catch (err) {
      alert('HTML export failed: ' + err.message);
    } finally {
      htmlBtn.disabled = false;
      htmlBtn.textContent = 'HTML';
    }
    return;
  }

const deleteBtn = e.target.closest('[data-action="delete-topic"]');
  if (deleteBtn) {
    const { room, topic, title } = deleteBtn.dataset;
    if (!confirm(`Delete topic "${title}" and all its messages? This action cannot be undone.`)) return;
    deleteBtn.disabled = true;
    deleteBtn.textContent = '...';
    try {
      await api.del(`/rooms/${room}/topics/${topic}`);
      // Refresh the history list
      const { showHistory } = await import('./rooms.js');
      await showHistory();
      // Also refresh the current room messages if we're in that room
      if (state.currentRoom === room) {
        await selectRoom(room);
      }
    } catch (err) {
      alert('Failed to delete topic: ' + err.message);
      deleteBtn.disabled = false;
      deleteBtn.textContent = 'Delete';
    }
    return;
  }
});

// ─── Event Delegation: Messages Area ─────────────────────────────────────
document.getElementById('messagesArea').addEventListener('click', (e) => {
  // Delete button
  const deleteBtn = e.target.closest('[data-action="delete-message"]');
  if (deleteBtn) {
    e.stopPropagation();
    deleteMessage(deleteBtn.dataset.messageId);
    return;
  }

  // Checkbox select (stop propagation to prevent toggle-select from firing)
  const checkbox = e.target.closest('[data-action="checkbox-select"]');
  if (checkbox) {
    e.stopPropagation();
    handleCheckboxChange(checkbox);
    return;
  }

  // Toggle message selection
  const messageEl = e.target.closest('[data-action="toggle-select"]');
  if (messageEl) {
    toggleMessageSelect(messageEl.dataset.messageId);
  }
});

// ─── API Key Check ───────────────────────────────────────────────────────────
function checkApiKeyAndShowPrompt() {
  const apiKey = localStorage.getItem('admin_api_key');
  if (!apiKey) {
    alert('请先设置 Admin API Key\n\n点击右上角 Settings 按钮，输入 API Key 后保存。\n\n测试 Key: test-admin-key-12345');
  }
}
