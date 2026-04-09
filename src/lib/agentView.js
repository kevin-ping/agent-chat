'use strict';

// No private fields to strip in the new architecture (api_key, webhook_token, session_key removed)
function toPublicAgent(agent) {
  return agent || null;
}

function toPublicAgents(agents) {
  return agents || [];
}

module.exports = { toPublicAgent, toPublicAgents };
