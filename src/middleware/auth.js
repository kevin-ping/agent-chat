'use strict';
const config = require('../config');
const stmts = require('../db/statements');

function requireAuth(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.api_key || req.body?.api_key;
  if (!key) return res.status(401).json({ error: 'Unauthorized: api_key required' });
  if (config.ADMIN_KEY && key === config.ADMIN_KEY) {
    req.isAdmin = true;
    return next();
  }
  const row = stmts.getAgentByApiKey.get(key);
  if (row) {
    req.authAgent = stmts.getAgent.get(row.id);
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized: invalid api_key' });
}

module.exports = { requireAuth };
