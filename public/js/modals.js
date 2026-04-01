import { state } from './state.js';
import { esc } from './utils.js';

export function closeModals() {
  document.querySelectorAll('.modal-overlay').forEach(m => m.classList.remove('visible'));
}

export function showModal(type) {
  closeModals();
  if (type === 'agent') {
    document.getElementById('agentModal').classList.add('visible');
    document.getElementById('agentIdInput').focus();
  } else if (type === 'room') {
    const container = document.getElementById('roomAgentCheckboxes');
    container.innerHTML = state.agents.length === 0
      ? '<span style="font-size:12px;color:var(--text-muted)">Create agents first</span>'
      : state.agents.map(a => `
          <label style="display:flex;align-items:center;gap:10px;padding:8px;border-radius:8px;cursor:pointer;transition:background 0.2s" onmouseover="this.style.background='var(--bg-hover)'" onmouseout="this.style.background='transparent'">
            <input type="checkbox" value="${a.id}" checked style="width:18px;height:18px">
            ${a.avatar_url
              ? `<img src="${a.avatar_url}" style="width:32px;height:32px;border-radius:50%;object-fit:cover;border:2px solid ${a.color || 'var(--border)'}">`
              : `<div style="width:32px;height:32px;border-radius:50%;background:${a.color || '#6366f1'};display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:600;color:#fff">${esc(a.name.charAt(0).toUpperCase())}</div>`
            }
            <span style="font-weight:500">${esc(a.name)}</span>
          </label>`).join('');
    document.getElementById('roomModal').classList.add('visible');
    document.getElementById('roomNameInput').focus();
  }
}

export function showSettings() {
  closeModals();
  const existing = localStorage.getItem('admin_api_key') || '';
  const input = document.getElementById('adminKeyInput');
  if (input) input.value = existing;
  const status = document.getElementById('adminKeyStatus');
  if (status) status.textContent = existing ? 'API Key is set.' : 'No API Key configured — all API calls will be rejected.';
  document.getElementById('settingsModal').classList.add('visible');
}

export function saveAdminKey() {
  const val = document.getElementById('adminKeyInput').value.trim();
  if (val) {
    localStorage.setItem('admin_api_key', val);
    document.getElementById('adminKeyStatus').textContent = 'API Key saved.';
    // Dispatch event for banner to dismiss
    window.dispatchEvent(new CustomEvent('adminApiKeySet', { detail: { key: val } }));
  } else {
    localStorage.removeItem('admin_api_key');
    document.getElementById('adminKeyStatus').textContent = 'API Key cleared.';
  }
}
