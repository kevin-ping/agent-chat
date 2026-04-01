'use strict';
const router = require('express').Router();
const stmts = require('../db/statements');

router.get('/', (req, res) => {
  const { q, room_id } = req.query;
  if (!q) return res.status(400).json({ error: 'q (query) is required' });
  const pattern = `%${q}%`;

  if (room_id) {
    // room_id query param is an integer id
    const roomId = parseInt(room_id, 10);
    const roomRow = stmts.getRoom.get(roomId);
    if (!roomRow) return res.status(404).json({ error: 'Room not found' });
    const messages = stmts.searchMessages.all(roomRow.id, pattern);
    return res.json({ query: q, results: messages });
  }

  const messages = stmts.searchAllMessages.all(pattern);
  res.json({ query: q, results: messages });
});

module.exports = router;
