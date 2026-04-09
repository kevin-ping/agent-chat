'use strict';
const messagesRouter = require('./messages');
const { requireAuth } = require('../middleware/auth');
const apiLogger = require('../middleware/apiLogger');

function setupRoutes(app) {
  // Public routes
  const swaggerRouter = require('./swagger');
  app.use('/api/swagger', swaggerRouter);
  app.get('/api/swagger.json', swaggerRouter.specJson);
  app.use('/api/guide', require('./guide'));

  // All remaining /api/* routes require auth (X-API-Key header or ?api_key= query param)
  app.use('/api', requireAuth);

  // API Logger
  app.use('/api', apiLogger);
  app.use('/api/agents', require('./agents'));
  app.use('/api/rooms', require('./rooms'));
  app.use('/api/rooms', messagesRouter);
  app.use('/api/rooms', require('./discussion'));
  app.use('/api/rooms', require('./context'));
  app.delete('/api/messages/:messageId', messagesRouter.deleteOne);
  app.delete('/api/messages', messagesRouter.deleteBatch);
  app.use('/api/search', require('./search'));
  app.use('/api/logs', require('./logs'));
  app.use('/api/internal', require('./internal'));
}

module.exports = { setupRoutes };
