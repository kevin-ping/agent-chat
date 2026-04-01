'use strict';
const router = require('express').Router();
const stmts = require('../db/statements');
const config = require('../config');

router.get('/', (req, res) => {
  const settings = stmts.getAllSettings.all();
  const result = {};
  for (const s of settings) result[s.key] = s.value;
  result.context_default_limit = result.context_default_limit || String(config.DEFAULT_LAST_N);
  result.context_max_limit = result.context_max_limit || String(config.MAX_LAST_N);
  result.context_min_limit = result.context_min_limit || String(config.MIN_LAST_N);
  res.json(result);
});

router.post('/', (req, res) => {
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ error: 'key is required' });

  const allowedKeys = ['context_default_limit', 'context_max_limit', 'context_min_limit'];
  if (!allowedKeys.includes(key)) {
    return res.status(400).json({ error: `Invalid key. Allowed: ${allowedKeys.join(', ')}` });
  }

  const numValue = parseInt(value);
  if (isNaN(numValue)) return res.status(400).json({ error: 'value must be a number' });

  stmts.setSetting.run(key, String(numValue));
  res.json({ ok: true, key, value: numValue });
});

module.exports = router;
