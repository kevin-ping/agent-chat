'use strict';

const agentWebhooks = new Map();

function registerWebhook(agentId, url) {
  agentWebhooks.set(agentId, url);
}

function unregisterWebhook(agentId) {
  agentWebhooks.delete(agentId);
}

function listWebhooks() {
  const hooks = {};
  for (const [id, url] of agentWebhooks) hooks[id] = url;
  return hooks;
}

async function notifyAgent(agentId, payload) {
  const url = agentWebhooks.get(agentId);
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000)
    });
  } catch (e) {
    console.log(`[webhook] Failed to notify ${agentId} at ${url}: ${e.message}`);
  }
}

module.exports = { registerWebhook, unregisterWebhook, listWebhooks, notifyAgent };
