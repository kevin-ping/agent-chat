'use strict';
const crypto = require('crypto');
const router = require('express').Router();
const axios = require('axios');
const stmts = require('../db/statements');
const { broadcast } = require('../realtime/broadcaster');
const { toPublicAgent, toPublicAgentWithKey } = require('../lib/agentView');
const config = require('../config');

// POST /api/register/activate
// Phase 2 of two-phase registration — public, no auth required.
// Consumes the invitation_token issued by POST /api/register,
// verifies the agent's hook endpoint, creates the agent, and returns the permanent api_key.
router.post('/', async (req, res) => {
  const { invitation_token } = req.body;

  if (!invitation_token) return res.status(400).json({ error: 'invitation_token is required' });

  const pending = stmts.getPendingReg.get(invitation_token);
  if (!pending) return res.status(401).json({ error: 'Invalid invitation token' });
  if (new Date(pending.expires_at) < new Date()) {
    return res.status(410).json({ error: 'Invitation token expired' });
  }

  const { agent_id: agentId, name, color, avatar_url, agent_hook_url,
          webhook_token, session_key, channel_type, channel_id } = pending;

  // Double-check duplicate (in case another activation raced in)
  const existing = stmts.getAgentByOpenClawId.get(agentId);
  if (existing) {
    stmts.deletePendingReg.run(invitation_token);
    return res.status(409).json({ error: 'Agent ID already exists' });
  }

  // Generate 22-char random API key (11 bytes hex encoded)
  const generatedApiKey = crypto.randomBytes(11).toString('hex');
  const hookUrl = `${agent_hook_url.replace(/\/$/, '')}/hooks/agent`;

  const hookPayload = {
    agent_id: agentId,
    name,
    agent_hook_url,
    webhook_token,
    session_key,
    channel_type,
    channel_id,
    api_key: generatedApiKey,
    message: `hi, this is agent chat platform, your api_key is: ${generatedApiKey}, please use this to authenticate with the platform`
  };

  let hookResponse;
  try {
    hookResponse = await axios.post(hookUrl, hookPayload, {
      timeout: config.HOOK_TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${webhook_token}`
      }
    });
  } catch (err) {
    if (err.code === 'ECONNABORTED' || err.message.includes('timeout')) {
      return res.status(408).json({
        error: `Hook verification timed out after ${config.HOOK_TIMEOUT_MS / 1000}s`,
        hook_url: hookUrl
      });
    }
    if (err.response) {
      return res.status(502).json({
        error: `Hook verification failed — endpoint returned ${err.response.status}`,
        hook_url: hookUrl,
        detail: err.message
      });
    }
    return res.status(502).json({
      error: 'Hook verification failed — could not reach hook endpoint',
      hook_url: hookUrl,
      detail: err.message
    });
  }

  if (hookResponse.status !== 200 || !hookResponse.data?.ok || !hookResponse.data?.runId) {
    return res.status(502).json({
      error: 'Hook verification failed — unexpected response',
      hook_url: hookUrl,
      detail: `Expected {ok: true, runId: "..."}, got: ${JSON.stringify(hookResponse.data)}`
    });
  }

  // Hook verified — create agent and delete pending record
  try {
    stmts.createAgent.run(
      agentId, name, color, avatar_url,
      agent_hook_url, generatedApiKey, webhook_token, session_key,
      channel_type, channel_id
    );
    stmts.deletePendingReg.run(invitation_token);
    const agent = stmts.getAgentByOpenClawId.get(agentId);
    broadcast({ type: 'agent_created', agent: toPublicAgent(agent) });
    return res.status(201).json({
      ok: true,
      run_id: hookResponse.data.runId,
      agent: toPublicAgentWithKey(agent),
      api_key_notice: '请妥善保存此 API Key，它已通过 hook 发送给你，系统不会再次返回。'
    });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Agent ID already exists' });
    return res.status(500).json({ error: e.message });
  }
});

module.exports = router;
