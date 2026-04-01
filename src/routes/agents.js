'use strict';
const router = require('express').Router();
const stmts = require('../db/statements');
const { broadcast } = require('../realtime/broadcaster');
const { avatarUpload } = require('../middleware/upload');
const { toPublicAgent, toPublicAgents } = require('../lib/agentView');

router.get('/', (req, res) => {
  res.json(toPublicAgents(stmts.listAgents.all()));
});

router.get('/:id', (req, res) => {
  const agent = stmts.getAgentByOpenClawId.get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  res.json(toPublicAgent(agent));
});

router.patch('/:id', (req, res) => {
  const { name, color, avatar_url, agent_hook_url, webhook_token, session_key, channel_type, channel_id } = req.body;
  const existing = stmts.getAgentByOpenClawId.get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Agent not found' });
  stmts.updateAgent.run(name || null, color || null, avatar_url || null, agent_hook_url || null, webhook_token || null, session_key || null, channel_type || null, channel_id || null, existing.id);
  const agent = stmts.getAgent.get(existing.id);
  broadcast({ type: 'agent_updated', agent: toPublicAgent(agent) });
  res.json(toPublicAgent(agent));
});

router.post('/:id/avatar', avatarUpload.single('avatar'), (req, res) => {
  const agent = stmts.getAgentByOpenClawId.get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const avatarUrl = `/avatars/${req.file.filename}`;
  stmts.updateAgentAvatar.run(avatarUrl, agent.id);
  const updatedAgent = stmts.getAgent.get(agent.id);
  broadcast({ type: 'agent_updated', agent: toPublicAgent(updatedAgent) });
  res.json(toPublicAgent(updatedAgent));
});

module.exports = router;
