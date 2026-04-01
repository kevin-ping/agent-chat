'use strict';

const PRIVATE_FIELDS = ['api_key', 'webhook_token', 'session_key'];

function toPublicAgent(agent) {
  if (!agent) return agent;
  const pub = { ...agent };
  for (const f of PRIVATE_FIELDS) delete pub[f];
  return pub;
}

function toPublicAgents(agents) {
  return agents.map(toPublicAgent);
}

// Used only in POST /api/register/activate response — includes api_key for one-time delivery
function toPublicAgentWithKey(agent) {
  if (!agent) return agent;
  const pub = { ...agent };
  delete pub.webhook_token;
  delete pub.session_key;
  return pub;
}

module.exports = { toPublicAgent, toPublicAgents, toPublicAgentWithKey };
