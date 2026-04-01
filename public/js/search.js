import { state } from './state.js';
import { api } from './api.js';
import { renderMessages } from './render.js';

let searchTimeout = null;

export function toggleSearch() {
  const container = document.getElementById('searchContainer');
  container.classList.toggle('visible');
  if (container.classList.contains('visible')) {
    document.getElementById('searchInput').focus();
  } else {
    document.getElementById('searchInput').value = '';
    renderMessages();
  }
}

export async function handleSearch(query) {
  clearTimeout(searchTimeout);
  if (!query.trim()) {
    renderMessages();
    return;
  }
  searchTimeout = setTimeout(async () => {
    try {
      const data = await api.get(`/search?q=${encodeURIComponent(query)}&room_id=${state.currentRoom}`);
      state.messages = data.results;
      renderMessages(query);
    } catch (error) {
      // Silently fail - search errors shouldn't block the UI
      console.error('Search failed:', error);
      state.messages = [];
      renderMessages(query);
    }
  }, 300);
}
