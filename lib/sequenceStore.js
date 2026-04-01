'use strict';
const fs = require('fs');

/**
 * 创建一个序列号持久化存储，将最后处理的 sequence 保存到 /tmp 文件。
 * @param {string} agentId  agent 标识，用于文件名区分
 * @param {string} [suffix] 文件名后缀（默认 'webhook'）
 * @returns {{ load: function(): number, save: function(number): void }}
 */
function createSequenceStore(agentId, suffix = 'webhook') {
  const filePath = `/tmp/${agentId}_${suffix}_seq.json`;

  function load() {
    try {
      if (fs.existsSync(filePath)) {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return data.sequence || -1;
      }
    } catch (e) {
      // ignore
    }
    return -1;
  }

  function save(seq) {
    try {
      fs.writeFileSync(filePath, JSON.stringify({ sequence: seq }), 'utf8');
    } catch (e) {
      // ignore
    }
  }

  return { load, save };
}

module.exports = { createSequenceStore };
