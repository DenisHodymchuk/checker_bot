const queries = require('../db/queries');
const { formatUkrainianDate, formatNumber, getTodayDateString } = require('../utils/date');

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Форматує щоденний звіт (турнірну таблицю) для групового чату
 */
function formatDailyReport(date = null) {
  const targetDate = date || getTodayDateString(queries.getSetting('timezone', 'Europe/Kyiv'));
  const rows = queries.getLeaderboard(targetDate);
  const dailyGoal = Number(queries.getSetting('daily_goal', '10000'));

  if (!rows || rows.length === 0) {
    return `👟 <b>Підсумки: ${escapeHtml(formatUkrainianDate(targetDate))}</b>\n🎯 Денна мета: <b>${formatNumber(dailyGoal)}</b> кроків\n\nПоки немає зареєстрованих учасників у челенджі.\nНапишіть /start у приватні повідомлення боту, щоб приєднатися!`;
  }

  const completed = rows.filter(r => r.steps && r.steps > 0);
  const missing = rows.filter(r => !r.steps || r.steps === 0);

  let message = `👟 <b>Підсумки: ${escapeHtml(formatUkrainianDate(targetDate))}</b>\n`;
  message += `🎯 Денна мета: <b>${formatNumber(dailyGoal)}</b> кроків\n\n`;

  message += `<b>Рейтинг:</b>\n`;
  if (completed.length === 0) {
    message += `Сьогодні ще ніхто не зафіксував кроки.\n\n`;
  } else {
    completed.forEach((entry, index) => {
      const name = entry.first_name 
        ? escapeHtml(entry.first_name) 
        : (entry.username ? `@${escapeHtml(entry.username)}` : 'Учасник');
      const percent = Math.round((entry.steps / dailyGoal) * 100);
      const targetReached = entry.steps >= dailyGoal ? ' 🎯' : '';

      message += `${index + 1}.  ${name} — <b>${formatNumber(entry.steps)}</b> (${percent}%)${targetReached}\n`;
    });
    message += `\n`;
  }

  // По команді
  const totalSteps = completed.reduce((sum, r) => sum + r.steps, 0);
  const avgSteps = completed.length > 0 ? Math.round(totalSteps / completed.length) : 0;
  const reachedGoalCount = completed.filter(r => r.steps >= dailyGoal).length;

  message += `<b>По команді:</b>\n`;
  message += `• Загалом: <b>${formatNumber(totalSteps)}</b>\n`;
  message += `• Середнє: <b>${formatNumber(avgSteps)}</b>\n`;
  message += `• Виконали мету: <b>${reachedGoalCount}/${rows.length}</b>\n`;

  if (missing.length > 0) {
    const missingList = missing.map(m => {
      return m.username ? `@${escapeHtml(m.username)}` : escapeHtml(m.first_name);
    }).join(', ');
    message += `• Не надіслали: ${missingList}\n`;
  }

  return message;
}

/**
 * Форматує персональну статистику користувача
 */
function formatUserStats(userId) {
  const user = queries.getUser(userId);
  if (!user) {
    return 'Користувача не знайдено. Натисніть /start для реєстрації.';
  }

  const summary = queries.getUserSummaryStats(userId);
  const history = queries.getUserWeeklyHistory(userId, 7);
  const dailyGoal = Number(queries.getSetting('daily_goal', '10000'));

  let msg = `👤 <b>Ваша статистика, ${escapeHtml(user.first_name)}:</b>\n\n`;
  msg += `📊 <b>Загальні показники:</b>\n`;
  msg += `• Активних днів: <b>${summary.total_days}</b>\n`;
  msg += `• Всього пройдено: <b>${formatNumber(summary.total_steps)}</b> кроків\n`;
  msg += `• Середній результат: <b>${formatNumber(summary.avg_steps)}</b> кр./день\n`;
  msg += `• Рекорд за день: <b>${formatNumber(summary.max_steps)}</b> кроків 🔥\n\n`;

  msg += `📅 <b>Останні дні:</b>\n`;
  if (!history || history.length === 0) {
    msg += `Поки немає записів. Надішліть скріншот крокоміра або скористайтеся /steps [число].\n`;
  } else {
    for (const h of history) {
      const reached = h.steps >= dailyGoal ? '🎯' : '👟';
      msg += `• ${h.date}: <b>${formatNumber(h.steps)}</b> кр. ${reached}\n`;
    }
  }

  return msg;
}

/**
 * Текст нагадування для публікації в спільний груповий чат
 */
function formatGroupReminderMessage(missingUsers, date = null) {
  const targetDate = date || getTodayDateString(queries.getSetting('timezone', 'Europe/Kyiv'));
  const reportTime = queries.getSetting('report_time', '22:00');
  
  const mentions = missingUsers.map(u => {
    return u.username ? `@${escapeHtml(u.username)}` : `<b>${escapeHtml(u.first_name)}</b>`;
  }).join(' ');

  let msg = `⏰ <b>Нагадування — до ${reportTime} приймаю звіти за ${escapeHtml(formatUkrainianDate(targetDate))}</b>\n\n`;
  msg += `Ще не бачу звіту від:\n${mentions}\n\n`;
  msg += `Будь ласка, надішліть скріншот своїх кроків сюди в чат до підсумкового звіту! 👟`;
  return msg;
}

/**
 * Текст персонального нагадування в приватні
 */
function formatReminderMessage(firstName) {
  return `Привіт, ${firstName}! 👟\n\nНагадуємо скинути скріншот своїх кроків за сьогодні, щоб потрапити до загального звіту команди! 📸\n\nПросто надішли фото сюди в чат.`;
}

module.exports = {
  formatDailyReport,
  formatUserStats,
  formatReminderMessage,
  formatGroupReminderMessage,
  escapeHtml,
};
