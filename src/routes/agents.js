'use strict';
const router = require('express').Router();
const stmts = require('../db/statements');
const { broadcast } = require('../realtime/broadcaster');
const { avatarUpload } = require('../middleware/upload');
const { toPublicAgent, toPublicAgents } = require('../lib/agentView');

router.get('/', (req, res) => {
  res.json(toPublicAgents(stmts.listAgents.all()));
});

// POST /api/agents — create a new agent directly
router.post('/', (req, res) => {
  const { agent_id, name, color, avatar_url, channel_type, channel_id, channel_name } = req.body;
  if (!agent_id || !name) return res.status(400).json({ error: 'agent_id and name are required' });

  const existing = stmts.getAgentByOpenClawId.get(agent_id);
  if (existing) return res.status(409).json({ error: 'Agent with this agent_id already exists' });

  stmts.createAgent.run(
    agent_id,
    name,
    color || '#6366f1',
    avatar_url || '',
    channel_type || null,
    channel_id || null,
    channel_name || null
  );

  const agent = stmts.getAgentByOpenClawId.get(agent_id);
  broadcast({ type: 'agent_created', agent: toPublicAgent(agent) });
  res.status(201).json(toPublicAgent(agent));
});

router.get('/:id', (req, res) => {
  const agent = stmts.getAgentByOpenClawId.get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  res.json(toPublicAgent(agent));
});

router.patch('/:id', (req, res) => {
  const { name, color, avatar_url, channel_type, channel_id, channel_name } = req.body;
  const existing = stmts.getAgentByOpenClawId.get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Agent not found' });
  stmts.updateAgent.run(
    name || null, color || null, avatar_url || null,
    channel_type || null, channel_id || null, channel_name || null,
    existing.id
  );
  const agent = stmts.getAgent.get(existing.id);
  broadcast({ type: 'agent_updated', agent: toPublicAgent(agent) });
  res.json(toPublicAgent(agent));
});

// DELETE /api/agents/:id — delete agent by openclaw agent_id
router.delete('/:id', (req, res) => {
  const existing = stmts.getAgentByOpenClawId.get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Agent not found' });
  stmts.deleteAgent.run(existing.id);
  broadcast({ type: 'agent_deleted', agent_id: existing.agent_id });
  res.json({ ok: true });
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
