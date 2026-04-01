'use strict';
const crypto = require('crypto');
const router = require('express').Router();
const stmts = require('../db/statements');
const config = require('../config');

// POST /api/register
// Phase 1 of two-phase registration — public, no auth required.
// Validates agent info and issues a one-time invitation_token (valid 30 min).
// The agent must then call POST /api/register/activate with the token to complete registration.
router.post('/', (req, res) => {
  const { name, color, avatar_url, agent_hook_url, webhook_token, session_key, channel_id } = req.body;
  const channel_type = req.body.channel_type || 'telegram';
  const agentId = req.body.agent_id || req.body.id;

  // Required field validation
  if (!agentId)        return res.status(400).json({ error: 'agent_id is required' });
  if (!name)           return res.status(400).json({ error: 'name is required' });
  if (!agent_hook_url) return res.status(400).json({ error: 'agent_hook_url is required (OpenClaw base URL)' });
  if (!webhook_token)  return res.status(400).json({ error: 'webhook_token is required (OpenClaw token)' });
  if (!session_key)    return res.status(400).json({ error: 'session_key is required (OpenClaw default key — prevents infinite hook loops)' });
  if (!channel_id)     return res.status(400).json({ error: 'channel_id is required (e.g. Telegram chat ID)' });

  // Platform-wide agent limit
  const totalAgents = stmts.countAllAgents.get();
  if (totalAgents.count >= config.MAX_AGENTS) {
    return res.status(403).json({ error: `Platform agent limit reached (max: ${config.MAX_AGENTS})` });
  }

  // Per-OpenClaw-server agent limit
  const normalizedHookUrl = agent_hook_url.replace(/\/$/, '');
  const serverAgents = stmts.countAgentsByHookUrl.get(normalizedHookUrl);
  if (serverAgents.count >= config.AGENT_PER_SERVER) {
    return res.status(403).json({
      error: `Agent limit reached for this OpenClaw server: ${serverAgents.count}/${config.AGENT_PER_SERVER}`
    });
  }

  // Per-OpenClaw-server pending registration limit (prevents flooding the pending_registrations table)
  const pendingCount = stmts.countPendingRegsByHookUrl.get(normalizedHookUrl);
  if (pendingCount.count >= config.PENDING_PER_SERVER) {
    return res.status(429).json({
      error: `Too many pending registrations for this OpenClaw server (max: ${config.PENDING_PER_SERVER}). Contact admin to clear expired tokens.`
    });
  }

  // Duplicate agent_id check
  const existing = stmts.getAgentByOpenClawId.get(agentId);
  if (existing) return res.status(409).json({ error: 'Agent ID already exists' });

  const invitationToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

  try {
    stmts.createPendingReg.run(
      invitationToken, agentId, name, color || '#6366f1', avatar_url || '',
      normalizedHookUrl, webhook_token, session_key, channel_type, channel_id,
      expiresAt
    );
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Agent ID already has a pending registration' });
    return res.status(500).json({ error: e.message });
  }

  return res.status(201).json({
    ok: true,
    invitation_token: invitationToken,
    expires_at: expiresAt,
    message: '请在 30 分钟内使用此 invitation_token 调用 POST /api/register/activate 完成注册'
  });
});

module.exports = router;
