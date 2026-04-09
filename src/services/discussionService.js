'use strict';
const stmts = require('../db/statements');
const { getAgentsWithStatus } = require('./roomService');

function getDiscussionStatus(roomId) {
  const room = stmts.getRoomDiscussion.get(roomId);
  if (!room) return null;

  const agentsInRoom = stmts.getAllAgentsInRoom.all(roomId);
  const noCommentsMap = {};
  let agreedCount = 0;

  for (const agent of agentsInRoom) {
    const noComments = agent.no_comments || 0;
    noCommentsMap[agent.agent_id] = noComments;
    if (noComments >= 1) agreedCount++;
  }

  const totalAgents = agentsInRoom.length;

  return {
    discussion: room.discussion === 1,
    moderator_id: room.moderator_id,
    no_comments: noCommentsMap,
    shouldContinue: agreedCount < totalAgents,
    lastActivity: room.last_activity_at
  };
}

function startDiscussion(roomId, moderatorId, topicId) {
  stmts.resetAllAgentsInRoom.run(roomId);
  stmts.setRoomDiscussion.run(1, moderatorId, new Date().toISOString(), topicId, roomId);

  const topic = stmts.getTopic.get(topicId);

  return {
    success: true,
    message: 'Discussion started',
    agentsWithStatus: getAgentsWithStatus(roomId),
    roomStatus: { discussion: true, moderator_id: moderatorId, topic_id: topicId },
    topic: topic || null
  };
}

function randomizeNextTurn(roomId) {
  const room = stmts.getRoomDiscussion.get(roomId);
  if (!room) return;
  let order = [];
  try { order = JSON.parse(room.turn_order || '[]'); } catch { return; }
  if (order.length === 0) return;
  const picked = order[Math.floor(Math.random() * order.length)];
  stmts.updateRoomTurn.run(picked, roomId);
}

function randomizeNextModerator(roomId) {
  const agents = stmts.getAllAgentsInRoom.all(roomId);
  if (!agents || agents.length === 0) return;
  const picked = agents[Math.floor(Math.random() * agents.length)];
  stmts.setRoomModerator.run(picked.agent_id, roomId);
}

function stopDiscussion(roomId, reason) {
  const openTopic = stmts.getOpenTopicForRoom.get(roomId);
  const roomRow   = stmts.getRoomDiscussion.get(roomId);
  const moderatorId = roomRow ? roomRow.moderator_id : null;

  // Topic is NOT closed here — the moderator closes it after writing the summary.
  stmts.setAllAgentsConfirmed.run(roomId);
  stmts.stopRoomDiscussion.run(roomId);
  randomizeNextTurn(roomId);
  randomizeNextModerator(roomId);
  return {
    success: true,
    message: 'Discussion stopped: ' + reason,
    reason,
    agentsWithStatus: getAgentsWithStatus(roomId),
    moderatorId,
    topicId: openTopic ? openTopic.id : null
  };
}

function setAgentNoComments(agentId, roomId, value) {
  const room = stmts.getRoomDiscussion.get(roomId);
  if (!room || room.discussion !== 1) {
    return { agentsWithStatus: getAgentsWithStatus(roomId), consensusEvent: null };
  }

  const noCommentsValue = value ? (1 + room.in_confirmation) : 0;
  stmts.setAgentNoComments.run(agentId, roomId, noCommentsValue);
  stmts.updateRoomActivity.run(roomId);

  if (!value && room.in_confirmation === 1) {
    stmts.exitConfirmationRound.run(roomId);
  }

  const agentsStatus = stmts.getAllAgentsInRoom.all(roomId);
  const totalCount = agentsStatus.length;
  if (totalCount === 0) {
    return { agentsWithStatus: getAgentsWithStatus(roomId), consensusEvent: null };
  }

  const updatedRoom = stmts.getRoomDiscussion.get(roomId);
  let consensusEvent = null;

  if (updatedRoom.in_confirmation === 0) {
    const allFirstRoundAgree = agentsStatus.every(a => a.no_comments >= 1);
    if (allFirstRoundAgree) {
      stmts.enterConfirmationRound.run(roomId);
      consensusEvent = { type: 'confirmation_round_started' };
    }
  } else {
    const allConfirmed = agentsStatus.every(a => a.no_comments >= 2);
    if (allConfirmed) {
      const oldModeratorId = updatedRoom.moderator_id;
      const openTopic = stmts.getOpenTopicForRoom.get(roomId);
      // Topic is NOT closed here — the moderator closes it after writing the summary.
      stmts.stopRoomDiscussion.run(roomId);
      randomizeNextTurn(roomId);
      randomizeNextModerator(roomId);
      consensusEvent = {
        type: 'discussion_stopped',
        reason: 'consensus',
        moderator_id: oldModeratorId,
        topic_id: openTopic ? openTopic.id : null
      };
    }
  }

  return { agentsWithStatus: getAgentsWithStatus(roomId), consensusEvent };
}

module.exports = { getDiscussionStatus, startDiscussion, stopDiscussion, setAgentNoComments };
