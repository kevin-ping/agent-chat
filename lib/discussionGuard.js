'use strict';

/**
 * 检查当前讨论是否应该终止。
 * @param {string} roomId
 * @param {object} queries     来自 lib/dbReader.js 的 queries 对象
 * @param {string} [myAgentId] 可选，如果指定则也检查自己的 no_comments 状态
 * @returns {boolean}  true 表示应该停止
 */
function shouldStopDiscussion(roomId, queries, myAgentId) {
  try {
    const room = queries.getRoom.get(roomId);
    if (!room || room.discussion !== 1) {
      console.log(`   🛑 Discussion not active (discussion=${room?.discussion})`);
      return true;
    }

    if (myAgentId) {
      const agentsStatus = queries.getAgentsNoComments.all(roomId);
      if (agentsStatus && agentsStatus.length > 0) {
        const myStatus = agentsStatus.find(a => a.agent_id === myAgentId);
        if (myStatus && myStatus.no_comments >= 1) {
          console.log(`   🛑 ${myAgentId} already agreed (no_comments=${myStatus.no_comments})`);
          return true;
        }
      }
    }

    return false;
  } catch (e) {
    console.log(`   Warning: ${e.message}`);
    return false;
  }
}

module.exports = { shouldStopDiscussion };
