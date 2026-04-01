'use strict';
const fs = require('fs');
const path = require('path');

/**
 * 创建支持日志轮转的写入流
 * 当文件大小超过限制时，自动归档旧日志并创建新文件
 *
 * @param {string} filePath - 日志文件路径
 * @param {Object} options - 配置选项
 * @param {number} options.maxSize - 最大文件大小（字节），默认 10MB
 * @param {number} options.maxFiles - 保留的归档文件数量，默认 5
 * @returns {fs.WriteStream} 写入流
 */
function createRotatingFileStream(filePath, options = {}) {
  const {
    maxSize = 10 * 1024 * 1024,  // 默认 10MB
    maxFiles = 5,                  // 默认保留 5 个归档
  } = options;

  const logDir = path.dirname(filePath);
  const baseName = path.basename(filePath);
  const nameWithoutExt = baseName.replace(/\.[^.]+$/, '');

  // 确保日志目录存在
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  // 获取当前文件大小
  function getFileSize() {
    try {
      return fs.statSync(filePath).size;
    } catch {
      return 0;
    }
  }

  // 获取现有的归档文件数量
  function getArchiveCount() {
    let count = 0;
    for (let i = 1; i <= maxFiles + 10; i++) {
      const archivePath = path.join(logDir, `${nameWithoutExt}.${i}.log`);
      if (fs.existsSync(archivePath)) {
        count = i;
      } else {
        break;
      }
    }
    return count;
  }

  // 归档当前日志文件
  function rotateFile() {
    if (!fs.existsSync(filePath)) return;

    const currentCount = getArchiveCount();

    // 删除最旧的归档（如果超过 maxFiles）
    if (currentCount >= maxFiles) {
      const oldestArchive = path.join(logDir, `${nameWithoutExt}.${currentCount}.log`);
      try {
        fs.unlinkSync(oldestArchive);
      } catch (err) {
        console.error(`Failed to delete old log archive: ${err.message}`);
      }
    }

    // 重命名现有归档文件（递增序号）
    for (let i = currentCount; i >= 1; i--) {
      const oldPath = path.join(logDir, `${nameWithoutExt}.${i}.log`);
      const newPath = path.join(logDir, `${nameWithoutExt}.${i + 1}.log`);
      try {
        if (fs.existsSync(oldPath)) {
          fs.renameSync(oldPath, newPath);
        }
      } catch (err) {
        console.error(`Failed to rotate log archive: ${err.message}`);
      }
    }

    // 将当前日志文件重命名为 .1.log
    const archivePath = path.join(logDir, `${nameWithoutExt}.1.log`);
    try {
      fs.renameSync(filePath, archivePath);
    } catch (err) {
      console.error(`Failed to archive current log: ${err.message}`);
    }
  }

  // 检查并执行轮转
  function checkRotation() {
    if (getFileSize() >= maxSize) {
      rotateFile();
    }
  }

  // 初始检查
  checkRotation();

  // 创建写入流（追加模式）
  const stream = fs.createWriteStream(filePath, { flags: 'a' });

  // 重写 write 方法，在每次写入前检查轮转
  const originalWrite = stream.write.bind(stream);
  stream.write = function(chunk, ...args) {
    checkRotation();
    return originalWrite(chunk, ...args);
  };

  return stream;
}

module.exports = { createRotatingFileStream };
