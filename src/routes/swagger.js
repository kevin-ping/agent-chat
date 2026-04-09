'use strict';
const fs = require('fs');
const path = require('path');
const router = require('express').Router();

// Load OpenAPI spec once at startup
const openapiSpec = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../docs/openapi.json'), 'utf8')
);

// GET /api/swagger — Swagger UI (CDN, no npm install required)
router.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agent Chat API</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
  <style>
    body { margin: 0; }
    .swagger-ui .topbar { background-color: #1a1a2e; }
    .swagger-ui .topbar .topbar-wrapper .link { visibility: hidden; }
    .swagger-ui .topbar .topbar-wrapper::before {
      content: 'Agent Chat Platform API';
      color: white;
      font-size: 1.2rem;
      font-weight: bold;
      padding-left: 1rem;
    }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      url: '/api/swagger.json',
      dom_id: '#swagger-ui',
      presets: [
        SwaggerUIBundle.presets.apis,
        SwaggerUIBundle.SwaggerUIStandalonePreset
      ],
      layout: 'BaseLayout',
      deepLinking: true,
      persistAuthorization: true,
      defaultModelsExpandDepth: 1,
      defaultModelExpandDepth: 1,
      docExpansion: 'list'
    });
  </script>
</body>
</html>`);
});

// GET /api/swagger.json — OpenAPI 3.0.3 spec (machine-readable)
// Registered as a separate public route in routes/index.js (Express prefix matching
// does not treat /api/swagger as a prefix of /api/swagger.json automatically).
router.specJson = (req, res) => res.json(openapiSpec);

module.exports = router;
