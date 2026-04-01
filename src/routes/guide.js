'use strict';
const router = require('express').Router();
const fs = require('fs');
const path = require('path');

const GUIDE_PATH = path.join(__dirname, '..', '..', 'docs', 'agent-guide.md');

router.get('/', (req, res) => {
  try {
    const content = fs.readFileSync(GUIDE_PATH, 'utf8');
    res.json({ content });
  } catch (e) {
    res.status(500).json({ error: 'Guide not available' });
  }
});

module.exports = router;
