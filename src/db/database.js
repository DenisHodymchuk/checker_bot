const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const dbPath = path.resolve(__dirname, '../../bot.db');
const db = new DatabaseSync(dbPath);

function initDatabase() {
  // Вмикаємо foreign keys та WAL режим (якщо підтримується)
  db.exec('PRAGMA foreign_keys = ON;');

  // Таблиця користувачів
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      first_name TEXT NOT NULL,
      username TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );
  `);

  // Таблиця щоденних кроків
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      steps INTEGER NOT NULL,
      source TEXT DEFAULT 'photo',
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      UNIQUE(user_id, date) ON CONFLICT REPLACE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_daily_steps_date ON daily_steps(date);
    CREATE INDEX IF NOT EXISTS idx_daily_steps_user_date ON daily_steps(user_id, date);
  `);

  // Таблиця системних налаштувань
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Початкові налаштування за замовчуванням
  const defaultSettings = [
    ['reminder_time', '20:30'],
    ['report_time', '22:00'],
    ['daily_goal', '10000'],
    ['timezone', 'Europe/Kyiv'],
    ['reminders_enabled', '1'],
    ['reports_enabled', '1'],
    ['group_chat_id', '']
  ];

  const insertSetting = db.prepare(`
    INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?);
  `);

  for (const [key, value] of defaultSettings) {
    insertSetting.run(key, value);
  }
}

module.exports = {
  db,
  initDatabase,
};
