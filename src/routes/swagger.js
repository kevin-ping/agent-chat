'use strict';
const fs = require('fs');
const path = require('path');
const router = require('express').Router();

// Read api-guide.md once at startup and cache the content
const guideContent = fs.readFileSync(
  path.join(__dirname, '../../docs/api-guide.md'),
  'utf8'
);

// GET /api/swagger
// Returns the full API reference (api-guide.md) as Markdown text.
// Requires auth — applied globally via requireAuth in routes/index.js.
router.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.send(guideContent);
});

module.exports = router;
