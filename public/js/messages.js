import { state } from './state.js';
import { api } from './api.js';
import { renderMessages } from './render.js';

// messageId is m.id (integer)
export async function deleteMessage(messageId) {
  if (!confirm('Delete this message?')) return;
  try {
    await api.del(`/messages/${messageId}`);
    state.messages = state.messages.filter(m => m.id !== messageId);
    renderMessages();
  } catch (error) {
    alert(`删除消息失败: ${error.message}`);
  }
}

export function toggleSelectMode() {
  state.selectMode = !state.selectMode;
  state.selectedMessages = [];
  document.getElementById('selectModeBar').classList.toggle('visible', state.selectMode);
  renderMessages();
}

// messageId is m.id (integer)
export function toggleMessageSelect(messageId) {
  if (state.selectedMessages.includes(messageId)) {
    state.selectedMessages = state.selectedMessages.filter(id => id !== messageId);
  } else {
    state.selectedMessages.push(messageId);
  }
  document.getElementById('selectedCount').textContent = `已选 ${state.selectedMessages.length} 条消息`;
  renderMessages();
}

export function handleCheckboxChange(checkbox) {
  // data-id stores m.id (integer)
  const id = parseInt(checkbox.dataset.id, 10);
  if (checkbox.checked) {
    if (!state.selectedMessages.includes(id)) state.selectedMessages.push(id);
  } else {
    state.selectedMessages = state.selectedMessages.filter(mid => mid !== id);
  }
  document.getElementById('selectedCount').textContent = `已选 ${state.selectedMessages.length} 条消息`;
}

export async function deleteSelectedMessages() {
  if (state.selectedMessages.length === 0) return;
  if (!confirm(`删除 ${state.selectedMessages.length} 条消息?`)) return;

  try {
    // selectedMessages contains message ids (integers); room_id is state.currentRoom (room id)
    await api.batchDelete('/messages', {
      ids: state.selectedMessages,
      room_id: state.currentRoom
    });

    state.messages = state.messages.filter(m => !state.selectedMessages.includes(m.id));
    state.selectedMessages = [];
    toggleSelectMode();
    renderMessages();
  } catch (error) {
    alert(`批量删除消息失败: ${error.message}`);
  }
}
