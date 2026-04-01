'use strict';
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const avatarsDir = path.join(__dirname, '..', '..', 'public', 'avatars');
if (!fs.existsSync(avatarsDir)) {
  fs.mkdirSync(avatarsDir, { recursive: true });
}

const ALLOWED_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, avatarsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const safeId = (req.params.id || 'agent').replace(/[^a-zA-Z0-9-_]/g, '');
    cb(null, `${safeId}${ext}`);
  }
});

function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (!ALLOWED_EXTS.has(ext)) {
    return cb(new Error('Only image files are allowed (.jpg, .jpeg, .png, .gif, .webp)'));
  }
  cb(null, true);
}

const avatarUpload = multer({ storage, limits: { fileSize: 200 * 1024 }, fileFilter });

module.exports = { avatarUpload };
