'use strict';
const db = require('../db');
const stmts = require('../db/statements');
const { advanceTurn } = require('./turnService');

function postMessage(roomId, room, { agentId, content, msgType, metadata }) {
  let noCommentsUpdated = false;

  const sendMessage = db.transaction(() => {
    const { max_seq } = stmts.getMaxSequence.get(roomId);
    const seq = max_seq + 1;

    const activeTopic = stmts.getOpenTopicForRoom.get(roomId);
    const topicId = activeTopic ? activeTopic.id : null;

    stmts.insertMessage.run(
      roomId, agentId || null, content, seq,
      msgType || 'message', JSON.stringify(metadata || {}), topicId
    );

    if (agentId) advanceTurn(room, agentId);

    if (agentId) {
      const agentRoom = stmts.getAgentRoom.get(agentId, roomId);
      noCommentsUpdated = (agentRoom ? agentRoom.no_comments : 0) === 1;
    }

    const messages = stmts.getMessagesAfterSeq.all(roomId, seq - 1);
    return messages[0];
  });

  const message = sendMessage();
  const updatedRoom = stmts.getRoom.get(roomId);
  return { message, updatedRoom, noCommentsUpdated };
}

module.exports = { postMessage };
