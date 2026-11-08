const cron = require('node-cron');
const queries = require('../db/queries');
const {
  formatDailyReport,
  formatDailyPenaltyReport,
  formatReminderMessage,
  formatGroupReminderMessage,
} = require('./leaderboard');
const { getYesterdayDateString } = require('../utils/date');
const { resolveTopicThreadId } = require('../utils/topic');
const { syncAllUsersToSheet } = require('./google_sheet');

let reminderTask = null;
let deadlineTask = null;
let reportTask = null;

/**
 * Перетворює час "HH:MM" на cron вираз "MM HH * * *"
 */
function timeToCron(timeStr) {
  const [hour, minute] = timeStr.split(':').map(Number);
  return `${minute || 0} ${hour || 0} * * *`;
}

/**
 * Об 11:00 (за годину до дедлайну 12:00) запускає нагадування всім учасникам,
 * які ще не скинули скрін за вчорашній день
 */
async function sendDailyReminders(bot) {
  const enabled = await queries.getSetting('reminders_enabled', '1');
  if (enabled === '0') {
    console.log('[Scheduler] Автоматичні нагадування вимкнені в налаштуваннях.');
    return;
  }

  const tz = await queries.getSetting('timezone', 'Europe/Kyiv');
  const yesterday = getYesterdayDateString(tz);
  const missing = await queries.getMissingUsersForDate(yesterday);

  if (!missing || missing.length === 0) {
    console.log(`[Scheduler] Всі учасники надіслали скріни за ${yesterday}. Нагадування об 11:00 не потрібні.`);
    return;
  }

  console.log(`[Scheduler] Розсилка нагадувань за ${yesterday}. Не надіслали скрін: ${missing.length}`);

  // 1. Надсилаємо нагадування з тегами всіх боржників у груповий чат
  const groupChatId = await queries.getSetting('group_chat_id');
  const remindersThreadId = await resolveTopicThreadId('reminders');
  if (groupChatId) {
    try {
      const groupMsg = await formatGroupReminderMessage(missing, yesterday);
      const sendOpts = { parse_mode: 'HTML' };
      if (remindersThreadId) {
        sendOpts.message_thread_id = remindersThreadId;
      }
      await bot.api.sendMessage(groupChatId, groupMsg, sendOpts);
      console.log(`[Scheduler] Нагадування за ${yesterday} опубліковано в групу ${groupChatId}${remindersThreadId ? ` (гілка ${remindersThreadId})` : ''}`);
    } catch (err) {
      console.error(`[Scheduler] Помилка надсилання нагадування в групу:`, err.message);
    }
  }

  // 2. Також надсилаємо в приватні тим, у кого відкритий чат з ботом
  for (const user of missing) {
    try {
      const msg = formatReminderMessage(user.first_name, yesterday);
      await bot.api.sendMessage(user.user_id, msg);
    } catch {
      // Ігноруємо якщо заблоковано або не відкрито
    }
  }
}

/**
 * О 12:00 фіксує результати за вчорашній день (пропуски та штрафи) та оновлює Google Таблицю
 */
async function finalizeYesterdayDeadline() {
  const tz = await queries.getSetting('timezone', 'Europe/Kyiv');
  const yesterday = getYesterdayDateString(tz);
  console.log(`[Scheduler] 12:00 Дедлайн! Фіксація пропусків та штрафів за ${yesterday} і синхронізація з Google Таблицею...`);
  try {
    await syncAllUsersToSheet(yesterday.slice(0, 7), { forceCloseDate: yesterday });
  } catch (err) {
    console.warn('[Scheduler] Помилка синхронізації таблиці о 12:00:', err.message);
  }
}

/**
 * О 13:00 публікує підсумковий звіт за вчорашній день (хто скільки пройшов, хто не пройшов, і штрафи)
 */
async function sendDailyGroupReport(bot) {
  const enabled = await queries.getSetting('reports_enabled', '1');
  if (enabled === '0') {
    console.log('[Scheduler] Автоматичні звіти вимкнені в налаштуваннях.');
    return;
  }

  const tz = await queries.getSetting('timezone', 'Europe/Kyiv');
  const yesterday = getYesterdayDateString(tz);

  // Оновлюємо Google Таблицю перед публікацією звіту
  try {
    await syncAllUsersToSheet(yesterday.slice(0, 7), { forceCloseDate: yesterday });
  } catch (err) {
    console.warn('[Scheduler] Помилка синхронізації з Google Таблицею перед звітом:', err.message);
  }

  const groupChatId = await queries.getSetting('group_chat_id');
  if (!groupChatId) {
    console.log('[Scheduler] Груповий чат не налаштовано. Пропускаємо відправку звіту.');
    return;
  }

  const reportsThreadId = await resolveTopicThreadId('reports');
  const penaltiesThreadId = await resolveTopicThreadId('penalties');

  const reportText = await formatDailyReport(yesterday, { forceCloseDate: yesterday });

  try {
    const sendOpts = { parse_mode: 'HTML' };
    if (reportsThreadId) {
      sendOpts.message_thread_id = reportsThreadId;
    }
    await bot.api.sendMessage(groupChatId, reportText, sendOpts);
    console.log(`[Scheduler] Звіт за вчора (${yesterday}) опубліковано в групу ${groupChatId}${reportsThreadId ? ` (гілка ${reportsThreadId})` : ''}`);
  } catch (err) {
    console.error(`[Scheduler] Помилка відправки звіту в групу ${groupChatId}:`, err.message);
  }

  // Якщо гілка для штрафів налаштована окремо від гілки звітів — публікуємо туди звіт по штрафах і банці
  if (penaltiesThreadId !== reportsThreadId) {
    try {
      const penaltyText = await formatDailyPenaltyReport(yesterday, { forceCloseDate: yesterday });
      const penOpts = { parse_mode: 'HTML' };
      if (penaltiesThreadId) {
        penOpts.message_thread_id = penaltiesThreadId;
      }
      await bot.api.sendMessage(groupChatId, penaltyText, penOpts);
      console.log(`[Scheduler] Звіт по штрафах за ${yesterday} опубліковано в гілку ${penaltiesThreadId || 'General'}`);
    } catch (err) {
      console.error(`[Scheduler] Помилка відправки звіту по штрафах:`, err.message);
    }
  }
}

/**
 * Ініціалізує та планує автоматичні завдання:
 * - 11:00 — нагадування тим, хто не скинув скрін за вчора (за 1 год до дедлайну)
 * - 12:00 — фіксація пропусків та штрафів за вчора + запис у Google Таблицю
 * - 13:00 — публікація звіту за вчора в групу
 */
async function initScheduler(bot) {
  if (reminderTask) {
    reminderTask.stop();
    reminderTask = null;
  }
  if (deadlineTask) {
    deadlineTask.stop();
    deadlineTask = null;
  }
  if (reportTask) {
    reportTask.stop();
    reportTask = null;
  }

  const reminderTime = await queries.getSetting('reminder_time', '11:00');
  const deadlineTime = await queries.getSetting('deadline_time', '12:00');
  const reportTime = await queries.getSetting('report_time', '13:00');
  const tz = await queries.getSetting('timezone', 'Europe/Kyiv');

  const reminderCron = timeToCron(reminderTime);
  const deadlineCron = timeToCron(deadlineTime);
  const reportCron = timeToCron(reportTime);

  console.log(`[Scheduler] Нагадування (за вчора): "${reminderTime}" (${reminderCron}, TZ: ${tz})`);
  console.log(`[Scheduler] Фіксація дедлайну (за вчора): "${deadlineTime}" (${deadlineCron}, TZ: ${tz})`);
  console.log(`[Scheduler] Звіт у чат (за вчора): "${reportTime}" (${reportCron}, TZ: ${tz})`);

  reminderTask = cron.schedule(
    reminderCron,
    async () => {
      await sendDailyReminders(bot);
    },
    { timezone: tz }
  );

  deadlineTask = cron.schedule(
    deadlineCron,
    async () => {
      await finalizeYesterdayDeadline();
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
  finalizeYesterdayDeadline,
  sendDailyGroupReport,
};
