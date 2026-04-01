import { ICONS } from './state.js';

export function toggleTheme() {
  const html = document.documentElement;
  const current = html.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  html.setAttribute('data-theme', next);
  localStorage.setItem('agent-chat-theme', next);
  updateThemeIcon(next);
}

export function updateThemeIcon(theme) {
  const btn = document.getElementById('themeToggle');
  btn.innerHTML = theme === 'dark' ? ICONS.moon : ICONS.sun;
}

export function initTheme() {
  const saved = localStorage.getItem('agent-chat-theme') || 'light';
  document.documentElement.setAttribute('data-theme', saved);
  updateThemeIcon(saved);
}
