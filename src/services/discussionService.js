'use strict';
const stmts = require('../db/statements');
const { getAgentsWithStatus } = require('./roomService');

function getDiscussionStatus(roomId) {
  const room = stmts.getRoomDiscussion.get(roomId);
  if (!room) return null;

  // getAllAgentsInRoom returns {agent_id, room_id, no_comments} rows (agent_id is INTEGER)
  const agentsInRoom = stmts.getAllAgentsInRoom.all(roomId);
  const noCommentsMap = {};
  let agreedCount = 0;

  for (const agent of agentsInRoom) {
    const noComments = agent.no_comments || 0;
    noCommentsMap[agent.agent_id] = noComments;
    if (noComments >= 1) agreedCount++;
  }

  const totalAgents = agentsInRoom.length;
  let timeoutRemaining = null;
  if (room.discussion === 1) {
    const elapsed = (Date.now() - new Date(room.last_activity_at)) / 1000;
    timeoutRemaining = Math.max(0, (room.discussion_timeout || 300) - elapsed);
  }

  return {
    discussion: room.discussion === 1,
    moderator_id: room.moderator_id,
    no_comments: noCommentsMap,
    shouldContinue: agreedCount < totalAgents,
    lastActivity: room.last_activity_at,
    timeoutRemaining
  };
}

function startDiscussion(roomId, moderatorId, timeoutSeconds, topicTitle) {
  stmts.resetAllAgentsInRoom.run(roomId);
  stmts.setRoomDiscussion.run(1, moderatorId, timeoutSeconds || 300, new Date().toISOString(), roomId);

  let topic = null;
  if (topicTitle) {
    stmts.insertTopic.run(roomId, topicTitle);
    // Get the newly created topic
    const topics = stmts.listTopics.all(roomId);
    topic = topics[0];
  }

  return {
    success: true,
    message: 'Discussion started',
    agentsWithStatus: getAgentsWithStatus(roomId),
    roomStatus: { discussion: true, moderator_id: moderatorId, timeout: timeoutSeconds || 300 },
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

function stopDiscussion(roomId, reason) {
  // Close any open topic for this room before stopping discussion
  const openTopic = stmts.getOpenTopicForRoom.get(roomId);
  if (openTopic) {
    stmts.closeTopic.run(openTopic.id);
  }

  stmts.stopRoomDiscussion.run(roomId);
  randomizeNextTurn(roomId);
  return {
    success: true,
    message: 'Discussion stopped: ' + reason,
    reason,
    agentsWithStatus: getAgentsWithStatus(roomId)
  };
}

// agentId is INTEGER (agents.id)
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
      stmts.stopRoomDiscussion.run(roomId);
      randomizeNextTurn(roomId);
      consensusEvent = { type: 'discussion_stopped', reason: 'consensus' };
    }
  }

  return { agentsWithStatus: getAgentsWithStatus(roomId), consensusEvent };
}

function checkTimeout(roomId) {
  const room = stmts.getRoomDiscussion.get(roomId);
  if (!room) return null;

  if (room.discussion !== 1) {
    return { shouldReset: false, reason: 'not in discussion', elapsed: 0 };
  }

  const timeout = room.discussion_timeout || 300;
  const elapsed = (Date.now() - new Date(room.last_activity_at)) / 1000;

  if (elapsed > timeout) {
    const openTopic = stmts.getOpenTopicForRoom.get(roomId);
    if (openTopic) stmts.closeTopic.run(openTopic.id);

    stmts.resetAllAgentsInRoom.run(roomId);
    stmts.stopRoomDiscussion.run(roomId);
    randomizeNextTurn(roomId);
    return {
      shouldReset: true,
      reason: `timeout after ${elapsed}s (timeout: ${timeout}s)`,
      elapsed,
      resetDetails: { agentsReset: true, discussionStopped: true }
    };
  }

  return { shouldReset: false, reason: 'active', elapsed };
}

module.exports = { getDiscussionStatus, startDiscussion, stopDiscussion, setAgentNoComments, checkTimeout };
