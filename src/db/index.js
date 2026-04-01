'use strict';
const Database = require('better-sqlite3');
const config = require('../config');

const db = new Database(config.DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Run schema and migrations immediately so prepared statements can be created safely
const { initSchema } = require('./schema');
const { runMigrations } = require('./migrations');
initSchema(db);
runMigrations(db);

module.exports = db;
