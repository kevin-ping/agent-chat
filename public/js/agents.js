import { state } from './state.js';
import { api, authHeaders } from './api.js';
import { renderSidebar, renderMessages } from './render.js';
import { closeModals } from './modals.js';

export async function createAgent() {
  const agent_id = document.getElementById('agentIdInput').value.trim();
  const name = document.getElementById('agentNameInput').value.trim();
  const color = document.getElementById('agentColorInput').value.trim();
  const channel_type = document.getElementById('agentChannelTypeInput').value.trim();
  const channel_id = document.getElementById('agentChannelIdInput').value.trim();
  const channel_name = document.getElementById('agentChannelNameInput').value.trim();
  if (!agent_id || !name) return alert('ID and Name are required');

  try {
    await api.post('/agents', { agent_id, name, color, channel_type, channel_id, channel_name });
    closeModals();
    document.getElementById('agentColorInput').value = '#7c6bf0';
  } catch (error) {
    alert(`创建 Agent 失败: ${error.message}\n\n请检查是否已设置 Admin API Key`);
  }
}

export function showEditAgent(agentId) {
  const agent = state.agents.find(a => a.agent_id === agentId);
  if (!agent) return;
  closeModals();
  document.getElementById('editAgentId').value = agent.agent_id;
  document.getElementById('editAgentIdDisplay').value = agent.agent_id;
  document.getElementById('editAgentNameInput').value = agent.name;
  document.getElementById('editAgentChannelTypeInput').value = agent.channel_type || '';
  document.getElementById('editAgentChannelIdInput').value = agent.channel_id || '';
  document.getElementById('editAgentChannelNameInput').value = agent.channel_name || '';
  document.getElementById('editAgentColorInput').value = agent.color || '#7c6bf0';
  document.getElementById('editAgentAvatarInput').value = '';

  const preview = document.getElementById('avatarPreview');
  const previewImg = document.getElementById('avatarPreviewImg');
  if (agent.avatar_url) {
    previewImg.src = agent.avatar_url;
    preview.style.display = 'block';
  } else {
    preview.style.display = 'none';
  }

  document.getElementById('editAgentModal').classList.add('visible');
  document.getElementById('editAgentNameInput').focus();
}

export function previewAvatar() {
  const fileInput = document.getElementById('editAgentAvatarInput');
  const file = fileInput.files[0];
  const preview = document.getElementById('avatarPreview');
  const previewImg = document.getElementById('avatarPreviewImg');

  if (!file) {
    preview.style.display = 'none';
    return;
  }

  if (file.size > 200 * 1024) {
    alert('File too large. Maximum size is 200KB.');
    fileInput.value = '';
    preview.style.display = 'none';
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    previewImg.src = e.target.result;
    preview.style.display = 'block';
  };
  reader.readAsDataURL(file);
}

export async function uploadAvatar() {
  const fileInput = document.getElementById('editAgentAvatarInput');
  const file = fileInput.files[0];
  if (!file) return;

  const agentId = document.getElementById('editAgentId').value;
  const formData = new FormData();
  formData.append('avatar', file);

  try {
    const response = await fetch(`/api/agents/${agentId}/avatar`, {
      method: 'POST',
      headers: authHeaders(),
      body: formData
    });

    if (!response.ok) {
      const err = await response.json();
      alert('Upload failed: ' + err.error);
      return;
    }

    const updated = await response.json();
    const idx = state.agents.findIndex(a => a.agent_id === agentId);
    if (idx !== -1) state.agents[idx] = updated;
    renderSidebar();
    renderMessages();
    document.getElementById('avatarPreview').style.display = 'none';
    document.getElementById('editAgentAvatarInput').value = '';
  } catch (e) {
    alert('Upload failed: ' + e.message);
  }
}

export async function saveEditAgent() {
  const id = document.getElementById('editAgentId').value;
  const name = document.getElementById('editAgentNameInput').value.trim();
  const color = document.getElementById('editAgentColorInput').value.trim();
  const channel_type = document.getElementById('editAgentChannelTypeInput').value.trim();
  const channel_id = document.getElementById('editAgentChannelIdInput').value.trim();
  const channel_name = document.getElementById('editAgentChannelNameInput').value.trim();
  if (!name) return alert('Name is required');

  try {
    const updated = await api.patch(`/agents/${id}`, { name, color, channel_type, channel_id, channel_name });
    const idx = state.agents.findIndex(a => a.agent_id === id);
    if (idx !== -1) state.agents[idx] = updated;
    renderSidebar();
    closeModals();
  } catch (error) {
    alert(`保存 Agent 失败: ${error.message}`);
  }
}
