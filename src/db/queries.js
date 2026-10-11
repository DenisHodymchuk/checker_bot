const { db } = require('./database');
const { getTodayDateString } = require('../utils/date');

// Користувачі
function upsertUser(id, firstName, username) {
  const stmt = db.prepare(`
    INSERT INTO users (id, first_name, username, is_active)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(id) DO UPDATE SET
      first_name = excluded.first_name,
      username = excluded.username;
  `);
  stmt.run(id, firstName, username || null);
}

function getUser(id) {
  const stmt = db.prepare(`SELECT * FROM users WHERE id = ?`);
  return stmt.get(id);
}

function getAllActiveUsers() {
  const stmt = db.prepare(`SELECT * FROM users WHERE is_active = 1 ORDER BY first_name ASC`);
  return stmt.all();
}

function getAllUsers() {
  const stmt = db.prepare(`SELECT * FROM users ORDER BY is_active DESC, first_name ASC`);
  return stmt.all();
}

function setUserActive(id, isActive) {
  const stmt = db.prepare(`UPDATE users SET is_active = ? WHERE id = ?`);
  stmt.run(isActive ? 1 : 0, id);
}

// Кроки
function saveDailySteps(userId, date, steps, source = 'photo', notes = '') {
  const stmt = db.prepare(`
    INSERT INTO daily_steps (user_id, date, steps, source, notes, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now', 'localtime'))
    ON CONFLICT(user_id, date) DO UPDATE SET
      steps = excluded.steps,
      source = excluded.source,
      notes = excluded.notes,
      created_at = excluded.created_at;
  `);
  stmt.run(userId, date, steps, source, notes || null);
}

function getUserStepsForDate(userId, date) {
  const stmt = db.prepare(`SELECT * FROM daily_steps WHERE user_id = ? AND date = ?`);
  return stmt.get(userId, date);
}

function getUserWeeklyHistory(userId, days = 7) {
  const stmt = db.prepare(`
    SELECT date, steps, source
    FROM daily_steps
    WHERE user_id = ?
    ORDER BY date DESC
    LIMIT ?
  `);
  return stmt.all(userId, days);
}

function getUserSummaryStats(userId) {
  const stmt = db.prepare(`
    SELECT
      COUNT(*) AS total_days,
      COALESCE(SUM(steps), 0) AS total_steps,
      COALESCE(ROUND(AVG(steps)), 0) AS avg_steps,
      COALESCE(MAX(steps), 0) AS max_steps
    FROM daily_steps
    WHERE user_id = ?
  `);
  return stmt.get(userId);
}

// Рейтинги та нагадування
function getLeaderboard(date) {
  const stmt = db.prepare(`
    SELECT 
      u.id AS user_id,
      u.first_name,
      u.username,
      s.steps,
      s.source,
      s.created_at
    FROM users u
    LEFT JOIN daily_steps s ON u.id = s.user_id AND s.date = ?
    WHERE u.is_active = 1
    ORDER BY 
      CASE WHEN s.steps IS NOT NULL THEN 0 ELSE 1 END ASC,
      s.steps DESC,
      u.first_name ASC
  `);
  return stmt.all(date);
}

function getMissingUsersForDate(date) {
  const stmt = db.prepare(`
    SELECT 
      u.id AS user_id,
      u.first_name,
      u.username
    FROM users u
    LEFT JOIN daily_steps s ON u.id = s.user_id AND s.date = ?
    WHERE u.is_active = 1 AND (s.steps IS NULL OR s.steps = 0)
    ORDER BY u.first_name ASC
  `);
  return stmt.all(date);
}

// Налаштування
function getSetting(key, defaultValue = '') {
  const stmt = db.prepare(`SELECT value FROM settings WHERE key = ?`);
  const row = stmt.get(key);
  return row ? row.value : defaultValue;
}

function setSetting(key, value) {
  const stmt = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value;
  `);
  stmt.run(key, String(value));
}

function getAllSettings() {
  const stmt = db.prepare(`SELECT key, value FROM settings`);
  const rows = stmt.all();
  const result = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

module.exports = {
  upsertUser,
  getUser,
  getAllActiveUsers,
  getAllUsers,
  setUserActive,
  saveDailySteps,
  getUserStepsForDate,
  getUserWeeklyHistory,
  getUserSummaryStats,
  getLeaderboard,
  getMissingUsersForDate,
  getSetting,
  setSetting,
  getAllSettings,
};
