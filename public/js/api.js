// ─── Admin API Key ───────────────────────────────────────────────────────
export function getAdminKey() {
  return localStorage.getItem('admin_api_key') || '';
}

export function authHeaders(extra) {
  return Object.assign({ 'X-API-Key': getAdminKey() }, extra);
}

// ─── API Helpers ─────────────────────────────────────────────────────────
export const api = {
  async get(path) {
    const res = await fetch(`/api${path}`, { headers: authHeaders() });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  },
  async post(path, data) {
    const res = await fetch(`/api${path}`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(data)
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  },
  async patch(path, data) {
    const res = await fetch(`/api${path}`, {
      method: 'PATCH',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(data)
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  },
  async del(path) {
    const res = await fetch(`/api${path}`, {
      method: 'DELETE',
      headers: authHeaders()
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  },
  async batchDelete(path, data) {
    const res = await fetch(`/api${path}`, {
      method: 'DELETE',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(data)
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  }
};
