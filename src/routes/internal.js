'use strict';
const router = require('express').Router();
const { broadcast, setThinking, clearThinking } = require('../realtime/broadcaster');

// POST /api/internal/agent-thinking  { room_id, agent_id }
router.post('/agent-thinking', (req, res) => {
  const roomId = parseInt(req.body.room_id, 10);
  const agentId = parseInt(req.body.agent_id, 10);
  if (!roomId || !agentId) return res.status(400).json({ error: 'room_id and agent_id required' });
  setThinking(roomId, agentId);
  broadcast({ type: 'agent_thinking', room_id: roomId, agent_id: agentId });
  res.json({ ok: true });
});

// POST /api/internal/agent-thinking-done  { room_id, agent_id }
router.post('/agent-thinking-done', (req, res) => {
  const roomId = parseInt(req.body.room_id, 10);
  const agentId = parseInt(req.body.agent_id, 10);
  if (!roomId || !agentId) return res.status(400).json({ error: 'room_id and agent_id required' });
  clearThinking(roomId, agentId);
  broadcast({ type: 'agent_thinking_done', room_id: roomId, agent_id: agentId });
  res.json({ ok: true });
});

module.exports = router;
