'use strict';
const messagesRouter = require('./messages');
const { requireAuth } = require('../middleware/auth');
const apiLogger = require('../middleware/apiLogger');

function setupRoutes(app) {
  // Public routes — no auth required (这些路由不经过 apiLogger，不会被记录)
  app.use('/api/guide', require('./guide'));                       // GET /api/guide — agent onboarding guide
  app.use('/api/register/activate', require('./registerActivate')); // POST /api/register/activate — phase 2: hook verify + create agent
  app.use('/api/register', require('./register'));                 // POST /api/register — phase 1: validate + issue invitation_token
  app.use('/api/swagger', require('./swagger'));   // GET /api/swagger — API reference (public)

  // All remaining /api/* routes require auth (X-API-Key header or ?api_key= query param)
  app.use('/api', requireAuth);

  // API Logger — 在认证之后执行，可以访问 req.isAdmin 和 req.authAgent
  app.use('/api', apiLogger);
  app.use('/api/agents', require('./agents'));
  app.use('/api/rooms', require('./rooms'));
  app.use('/api/rooms', messagesRouter);        // /:roomId/messages POST+GET+DELETE(clear)
  app.use('/api/rooms', require('./discussion')); // /:roomId/discussion-status, /discussion/*, /agents/:agentId/no-comments, /timeout-check
  app.use('/api/rooms', require('./context'));    // /:roomId/context
  app.delete('/api/messages/:messageId', messagesRouter.deleteOne);
  app.delete('/api/messages', messagesRouter.deleteBatch);
  app.use('/api/search', require('./search'));
  app.use('/api/settings', require('./settings'));
  app.use('/api', require('./webhooks'));         // /agents/:id/webhook, /webhooks
  app.use('/api/logs', require('./logs'));        // GET /api/logs/stream — SSE log viewer
}

module.exports = { setupRoutes };
