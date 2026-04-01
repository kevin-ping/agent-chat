'use strict';
const router = require('express').Router();
const stmts = require('../db/statements');
const { registerWebhook, unregisterWebhook, listWebhooks } = require('../realtime/webhookNotifier');

router.post('/agents/:id/webhook', (req, res) => {
  const { callback_url } = req.body;
  if (!callback_url) return res.status(400).json({ error: 'callback_url is required' });
  const agent = stmts.getAgent.get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  registerWebhook(req.params.id, callback_url);
  res.json({ ok: true, agent_id: req.params.id, callback_url });
});

router.delete('/agents/:id/webhook', (req, res) => {
  unregisterWebhook(req.params.id);
  res.json({ ok: true });
});

router.get('/webhooks', (req, res) => {
  res.json(listWebhooks());
});


module.exports = router;
