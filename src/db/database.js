const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');
const { config } = require('../config');

let isSupabase = false;
let supabase = null;
let sqliteDb = null;

if (config.supabaseUrl && config.supabaseKey) {
  isSupabase = true;
  supabase = createClient(config.supabaseUrl, config.supabaseKey, {
    auth: { persistSession: false },
  });
} else {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const dbPath = path.resolve(__dirname, '../../bot.db');
    sqliteDb = new DatabaseSync(dbPath);
  } catch (err) {
    console.error('⚠️ Для локальної бази даних SQLite потрібен Node.js v22+. Вкажіть змінні SUPABASE_URL та SUPABASE_KEY або оновіть Node.js.');
  }
}

const defaultSettings = [
  ['reminder_time', '11:00'],
  ['deadline_time', '12:00'],
  ['report_time', '13:00'],
  ['daily_goal', '10000'],
  ['grace_days_limit', '2'],
  ['penalty_amount', '100'],
  ['timezone', 'Europe/Kyiv'],
  ['reminders_enabled', '1'],
  ['reports_enabled', '1'],
  ['group_chat_id', ''],
  ['steps_topic_id', ''],
  ['reports_topic_id', ''],
  ['penalties_topic_id', ''],
  ['reminders_topic_id', ''],
  ['known_topics', '{}'],
  ['google_sheet_id', config.googleSheetId || '1qWVTXOfVQzn9VLEUWdZvIOvZt_omcd8j0Yr5QilzNt4'],
  ['google_sheet_gid', config.googleSheetGid || '1261303835'],
  ['google_script_url', config.googleScriptUrl || 'https://script.google.com/macros/s/AKfycbwT1PR4M55Ck_KhT9L-CNe7-a7kf-OcAwefGS8xdhGEzlN_dQv8T-8yAzqafhIcedwk/exec'],
];

async function initDatabase() {
  if (isSupabase) {
    console.log('⚡ Підключення до хмарної бази даних Supabase (PostgreSQL)...');
    try {
      const { data: existingSettings, error } = await supabase.from('settings').select('key, value');
      if (error && error.code === '42P01') {
        console.warn('⚠️ Таблиці у Supabase ще не створено!');
        console.warn('👉 Відкрийте Supabase -> SQL Editor, скопіюйте вміст файлу supabase_schema.sql та запустіть його.');
      } else if (error) {
        console.warn('⚠️ Помилка з\'єднання з Supabase:', error.message);
      } else {
        console.log('✅ Успішно підключено до Supabase!');
        const existingMap = new Map((existingSettings || []).map(s => [s.key, s.value]));
        const missing = defaultSettings
          .filter(([key]) => !existingMap.has(key))
          .map(([key, value]) => ({ key, value }));
        if (missing.length > 0) {
          await supabase.from('settings').upsert(missing, { onConflict: 'key' });
        }
        // Міграція старих часів за замовчуванням (20:30 -> 11:00, 22:00 -> 13:00)
        if (existingMap.get('reminder_time') === '20:30') {
          await supabase.from('settings').upsert({ key: 'reminder_time', value: '11:00' }, { onConflict: 'key' });
        }
        if (existingMap.get('report_time') === '22:00') {
          await supabase.from('settings').upsert({ key: 'report_time', value: '13:00' }, { onConflict: 'key' });
        }
        if (!existingMap.get('google_script_url') && config.googleScriptUrl) {
          await supabase.from('settings').upsert({ key: 'google_script_url', value: config.googleScriptUrl }, { onConflict: 'key' });
        }
      }
    } catch (err) {
      console.warn('⚠️ Помилка перевірки Supabase:', err.message);
    }
    return;
  }

  // Якщо локальний SQLite
  console.log('📦 Використовується локальна база даних SQLite (bot.db)...');
  sqliteDb.exec('PRAGMA foreign_keys = ON;');

  // Таблиця користувачів
  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      first_name TEXT NOT NULL,
      username TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );
  `);

  // Таблиця щоденних кроків
  sqliteDb.exec(`
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
  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Таблиця платежів у штрафну банку
  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS penalty_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      admin_id INTEGER,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_penalty_payments_user ON penalty_payments(user_id);
  `);

  const insertSetting = sqliteDb.prepare(`
    INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?);
  `);

  for (const [key, value] of defaultSettings) {
    insertSetting.run(key, value);
  }

  // Міграція старих часів за замовчуванням (20:30 -> 11:00, 22:00 -> 13:00)
  sqliteDb.prepare(`UPDATE settings SET value = '11:00' WHERE key = 'reminder_time' AND value = '20:30'`).run();
  sqliteDb.prepare(`UPDATE settings SET value = '13:00' WHERE key = 'report_time' AND value = '22:00'`).run();
  if (config.googleScriptUrl) {
    sqliteDb.prepare(`UPDATE settings SET value = ? WHERE key = 'google_script_url' AND (value IS NULL OR value = '')`).run(config.googleScriptUrl);
  }
}

module.exports = {
  isSupabase,
  supabase,
  sqliteDb,
  db: sqliteDb, // зворотна сумісність
  initDatabase,
};
