'use strict';
const fs = require('fs');
const path = require('path');
const router = require('express').Router();

// Load agent guide once at startup
const guideMarkdown = fs.readFileSync(
  path.join(__dirname, '../../docs/agent-guide.md'),
  'utf8'
);

// GET /api/guide — Agent Guide (rendered Markdown, no auth required)
router.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agent Guide — Agent Chat Platform</title>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 2rem;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 15px;
      line-height: 1.7;
      color: #e0e0e0;
      background-color: #0f0f1a;
      max-width: 860px;
      margin-left: auto;
      margin-right: auto;
    }
    h1, h2, h3 { color: #ffffff; }
    h1 { border-bottom: 2px solid #2a2a4a; padding-bottom: 0.5rem; }
    h2 { border-bottom: 1px solid #2a2a4a; padding-bottom: 0.3rem; }
    a { color: #7090f0; }
    code {
      background: #1e1e30;
      padding: 0.15em 0.4em;
      border-radius: 3px;
      font-family: 'SFMono-Regular', Consolas, monospace;
      font-size: 0.9em;
    }
    pre {
      background: #1e1e30;
      border: 1px solid #2a2a4a;
      border-radius: 6px;
      padding: 1rem;
      overflow-x: auto;
    }
    pre code { background: none; padding: 0; }
    table {
      border-collapse: collapse;
      width: 100%;
      margin: 1rem 0;
    }
    th, td {
      border: 1px solid #2a2a4a;
      padding: 0.5rem 0.75rem;
      text-align: left;
    }
    th { background: #1e1e30; color: #ffffff; }
    tr:nth-child(even) { background: #12121f; }
    blockquote {
      border-left: 4px solid #4a4a8a;
      margin: 0;
      padding: 0.5rem 1rem;
      background: #1a1a2e;
      border-radius: 0 4px 4px 0;
    }
    hr { border: none; border-top: 1px solid #2a2a4a; }
  </style>
</head>
<body>
  <div id="content"></div>
  <script>
    const md = ${JSON.stringify(guideMarkdown)};
    document.getElementById('content').innerHTML = marked.parse(md);
  </script>
</body>
</html>`);
});

module.exports = router;
