const cron = require('node-cron');
const queries = require('../db/queries');
const { formatDailyReport, formatReminderMessage, formatGroupReminderMessage } = require('./leaderboard');
const { getTodayDateString } = require('../utils/date');

let reminderTask = null;
let reportTask = null;

/**
 * Перетворює час "HH:MM" на cron вираз "MM HH * * *"
 */
function timeToCron(timeStr) {
  const [hour, minute] = timeStr.split(':').map(Number);
  return `${minute || 0} ${hour || 0} * * *`;
}

/**
 * Запускає нагадування користувачам, які ще не надіслали кроки
 */
async function sendDailyReminders(bot) {
  const enabled = queries.getSetting('reminders_enabled', '1');
  if (enabled === '0') {
    console.log('[Scheduler] Автоматичні нагадування вимкнені в налаштуваннях.');
    return;
  }

  const tz = queries.getSetting('timezone', 'Europe/Kyiv');
  const today = getTodayDateString(tz);
  const missing = queries.getMissingUsersForDate(today);

  if (!missing || missing.length === 0) {
    console.log(`[Scheduler] Всі учасники надіслали звіти за ${today}. Нагадування не потрібні.`);
    return;
  }

  console.log(`[Scheduler] Запуск розсилки нагадувань за ${today}. Залишилось надіслати: ${missing.length}`);

  // 1. Надсилаємо нагадування в спільний груповий чат
  const groupChatId = queries.getSetting('group_chat_id');
  if (groupChatId) {
    try {
      const groupMsg = formatGroupReminderMessage(missing, today);
      await bot.api.sendMessage(groupChatId, groupMsg, { parse_mode: 'HTML' });
      console.log(`[Scheduler] Нагадування успішно опубліковано в групу ${groupChatId}`);
    } catch (err) {
      console.error(`[Scheduler] Помилка надсилання нагадування в групу:`, err.message);
    }
  }

  // 2. Також надсилаємо в приватні тим, у кого відкритий чат з ботом
  for (const user of missing) {
    try {
      const msg = formatReminderMessage(user.first_name);
      await bot.api.sendMessage(user.user_id, msg);
      console.log(`[Scheduler] Надіслано нагадування в приватні: ${user.first_name} (${user.user_id})`);
    } catch (err) {
      // Ігноруємо якщо заблоковано або не відкрито
    }
  }
}

/**
 * Публікує щоденний звіт у робочу групу
 */
async function sendDailyGroupReport(bot) {
  const enabled = queries.getSetting('reports_enabled', '1');
  if (enabled === '0') {
    console.log('[Scheduler] Автоматичні звіти вимкнені в налаштуваннях.');
    return;
  }

  const groupChatId = queries.getSetting('group_chat_id');
  if (!groupChatId) {
    console.log('[Scheduler] Груповий чат не налаштовано. Пропускаємо відправку звіту.');
    return;
  }

  const tz = queries.getSetting('timezone', 'Europe/Kyiv');
  const today = getTodayDateString(tz);
  const reportText = formatDailyReport(today);

  try {
    await bot.api.sendMessage(groupChatId, reportText, { parse_mode: 'HTML' });
    console.log(`[Scheduler] Звіт успішно опубліковано в групу ${groupChatId} за ${today}`);
  } catch (err) {
    console.error(`[Scheduler] Помилка відправки звіту в групу ${groupChatId}:`, err.message);
  }
}

/**
 * Ініціалізує та планує автоматичні завдання
 */
function initScheduler(bot) {
  // Зупиняємо старі задачі, якщо вони вже працювали
  if (reminderTask) {
    reminderTask.stop();
    reminderTask = null;
  }
  if (reportTask) {
    reportTask.stop();
    reportTask = null;
  }

  const reminderTime = queries.getSetting('reminder_time', '20:30');
  const reportTime = queries.getSetting('report_time', '22:00');
  const tz = queries.getSetting('timezone', 'Europe/Kyiv');

  const reminderCron = timeToCron(reminderTime);
  const reportCron = timeToCron(reportTime);

  console.log(`[Scheduler] Планування нагадувань: "${reminderTime}" (${reminderCron}, TZ: ${tz})`);
  console.log(`[Scheduler] Планування звітів: "${reportTime}" (${reportCron}, TZ: ${tz})`);

  reminderTask = cron.schedule(
    reminderCron,
    async () => {
      await sendDailyReminders(bot);
    },
    { timezone: tz }
  );

  reportTask = cron.schedule(
    reportCron,
    async () => {
      await sendDailyGroupReport(bot);
    },
    { timezone: tz }
  );
}

module.exports = {
  initScheduler,
  sendDailyReminders,
  sendDailyGroupReport,
};
