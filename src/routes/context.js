'use strict';
const router = require('express').Router();
const stmts = require('../db/statements');
const config = require('../config');
const { toPublicAgents } = require('../lib/agentView');

// GET /api/rooms/:roomId/context (roomId = integer)
router.get('/:roomId/context', (req, res) => {
  const roomId = parseInt(req.params.roomId, 10);
  const roomRow = stmts.getRoom.get(roomId);
  if (!roomRow) return res.status(404).json({ error: 'Room not found' });

  // agent_id query param: accept integer agents.id
  const { last_n, agent_id } = req.query;

  const room = stmts.getRoom.get(roomId);

  const settings = stmts.getAllSettings.all();
  const settingsMap = {};
  for (const s of settings) settingsMap[s.key] = parseInt(s.value) || config.DEFAULT_LAST_N;

  const minLimit = settingsMap.context_min_limit || config.MIN_LAST_N;
  const maxLimit = settingsMap.context_max_limit || config.MAX_LAST_N;
  const defaultLimit = settingsMap.context_default_limit || config.DEFAULT_LAST_N;

  const allMessages = stmts.getMessages.all(roomId);
  let effectiveLimit = defaultLimit;
  if (last_n) {
    effectiveLimit = Math.min(Math.max(parseInt(last_n), minLimit), maxLimit);
  }
  const messages = allMessages.slice(-effectiveLimit);

  const agents = toPublicAgents(stmts.getRoomAgents.all(roomId));

  // agent_id param: match by integer id
  let currentAgent = null;
  if (agent_id !== undefined && agent_id !== null) {
    const parsedId = parseInt(agent_id, 10);
    if (!isNaN(parsedId)) {
      currentAgent = agents.find(a => a.id === parsedId) || null;
    }
  }
  const otherAgents = currentAgent ? agents.filter(a => a.id !== currentAgent.id) : agents;

  const transcript = messages.map(m => ({
    role: m.agent_name || 'system',
    content: m.content,
    sequence: m.sequence,
    timestamp: m.created_at
  }));

  let systemPrompt = '';
  if (currentAgent) {
    const otherNames = otherAgents.map(a => a.name).join(', ') || 'another agent';
    systemPrompt = `你 [${currentAgent.name}] 正在和 ${otherNames} 讨论问题。\n请根据以下对话历史，回复对方的消息。\n\n对话历史：`;
  }

  res.json({
    room: { id: room.id, name: room.name, current_turn: room.current_turn, turn_mode: room.turn_mode },
    agents,
    total_messages: allMessages.length,
    effective_limit: effectiveLimit,
    current_agent: currentAgent,
    system_prompt: systemPrompt,
    transcript
  });
});

module.exports = router;
