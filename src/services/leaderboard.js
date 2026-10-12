const queries = require('../db/queries');
const { 
  formatUkrainianDate, 
  formatMonthUkrainian, 
  formatNumber, 
  getTodayDateString 
} = require('../utils/date');

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
async function formatDailyReport(date = null) {
  const tz = await queries.getSetting('timezone', 'Europe/Kyiv');
  const targetDate = date || getTodayDateString(tz);
  const yearMonth = targetDate.slice(0, 7);

  const rows = await queries.getLeaderboard(targetDate);
  const dailyGoal = Number(await queries.getSetting('daily_goal', '10000'));
  const graceLimit = Number(await queries.getSetting('grace_days_limit', '2'));
  const penaltyAmount = Number(await queries.getSetting('penalty_amount', '100'));

  if (!rows || rows.length === 0) {
    return (
      `👟 <b>Підсумки: ${escapeHtml(formatUkrainianDate(targetDate))}</b>\n` +
      `🎯 Щоденна норма: <b>${formatNumber(dailyGoal)}</b> кроків\n\n` +
      `Поки немає зареєстрованих учасників у челенджі.\n` +
      `Напишіть /start у приватні повідомлення боту, щоб приєднатися!`
    );
  }

  // Отримуємо детальну місячну оцінку кожного користувача до поточної дати
  const userMonthStatsMap = new Map();
  for (const r of rows) {
    const stats = await queries.getUserMonthStats(r.user_id, yearMonth, targetDate);
    if (stats) userMonthStatsMap.set(r.user_id, stats);
  }

  const completed = rows.filter(r => r.steps && r.steps > 0);
  const missing = rows.filter(r => !r.steps || r.steps === 0);

  let message = `👟 <b>Підсумки: ${escapeHtml(formatUkrainianDate(targetDate))}</b>\n`;
  message += `🎯 Щоденна норма: <b>${formatNumber(dailyGoal)}</b> кроків\n\n`;

  // Блок рейтингу
  message += `<b>Рейтинг дня:</b>\n`;
  const todayStr = getTodayDateString(tz);
  if (completed.length === 0) {
    if (targetDate === todayStr) {
      message += `За сьогодні ще ніхто не зафіксував кроки.\n`;
      message += `💡 <i>Щоб переглянути результати за попередні дні челенджу, вкажіть день або дату: <code>/report 11</code>, <code>/report 10</code> або <code>/report вчора</code></i>\n\n`;
    } else {
      message += `За цей день кроків не було зафіксовано.\n\n`;
    }
  } else {
    completed.forEach((entry, index) => {
      const name = entry.first_name 
        ? escapeHtml(entry.first_name) 
        : (entry.username ? `@${escapeHtml(entry.username)}` : 'Учасник');
      const percent = Math.round((entry.steps / dailyGoal) * 100);
      const isTargetReached = entry.steps >= dailyGoal;

      let tag = '';
      if (isTargetReached) {
        tag = ' 🎯';
      } else {
        const uStats = userMonthStatsMap.get(entry.user_id);
        const dayEval = uStats?.daysBreakdown.find(d => d.date === targetDate);
        if (dayEval) {
          if (dayEval.status === 'grace_1') tag = ' 🛡️ (пільговий 1/2)';
          else if (dayEval.status === 'grace_2') tag = ' 🛡️ (пільговий 2/2)';
          else if (dayEval.status === 'penalty') tag = ` 💸 (+${penaltyAmount} грн штраф)`;
        }
      }

      message += `${index + 1}. ${name} — <b>${formatNumber(entry.steps)}</b> (${percent}%)${tag}\n`;
    });
    message += `\n`;
  }

  // Ті, хто взагалі не надіслав
  if (missing.length > 0) {
    message += `<b>Не надіслали звіт:</b>\n`;
    missing.forEach(m => {
      const name = m.first_name 
        ? escapeHtml(m.first_name) 
        : (m.username ? `@${escapeHtml(m.username)}` : 'Учасник');
      const uStats = userMonthStatsMap.get(m.user_id);
      const dayEval = uStats?.daysBreakdown.find(d => d.date === targetDate);

      let tag = '';
      if (dayEval) {
        if (dayEval.status === 'grace_1') tag = ' 🛡️ (пільговий 1/2)';
        else if (dayEval.status === 'grace_2') tag = ' 🛡️ (пільговий 2/2)';
        else if (dayEval.status === 'penalty') tag = ` 💸 (+${penaltyAmount} грн штраф)`;
      }

      message += `• ${name} — 0 кр.${tag}\n`;
    });
    message += `\n`;
  }

  // Командна статистика
  const totalSteps = completed.reduce((sum, r) => sum + r.steps, 0);
  const avgSteps = completed.length > 0 ? Math.round(totalSteps / completed.length) : 0;
  const reachedGoalCount = completed.filter(r => r.steps >= dailyGoal).length;

  message += `<b>По команді:</b>\n`;
  message += `• Загалом: <b>${formatNumber(totalSteps)}</b> кроків\n`;
  message += `• Середнє: <b>${formatNumber(avgSteps)}</b> кр./чол.\n`;
  message += `• Виконали норму: <b>${reachedGoalCount}/${rows.length}</b>\n\n`;

  // Штрафи за сьогодні
  const penalizedToday = [];
  for (const r of rows) {
    const uStats = userMonthStatsMap.get(r.user_id);
    const dayEval = uStats?.daysBreakdown.find(d => d.date === targetDate);
    if (dayEval && dayEval.penalty > 0) {
      const name = r.first_name || (r.username ? `@${r.username}` : 'Учасник');
      penalizedToday.push(`${escapeHtml(name)}: <b>+${dayEval.penalty} грн</b> (${dayEval.missedOrder}-й пропуск)`);
    }
  }

  message += `<b>💸 Штрафи за сьогодні:</b>\n`;
  if (penalizedToday.length > 0) {
    message += penalizedToday.map(p => `• ${p}`).join('\n') + `\n\n`;
  } else {
    message += `• Сьогодні без штрафів! Всі вклалися в норму або пільги 🎉\n\n`;
  }

  // Борги учасників
  const debtors = [];
  for (const r of rows) {
    const uStats = userMonthStatsMap.get(r.user_id);
    if (uStats && uStats.currentDebt > 0) {
      const name = r.first_name || (r.username ? `@${r.username}` : 'Учасник');
      debtors.push(`${escapeHtml(name)}: <b>${formatNumber(uStats.currentDebt)} грн</b>`);
    }
  }

  message += `<b>💳 Поточні борги:</b>\n`;
  if (debtors.length > 0) {
    message += debtors.map(d => `• ${d}`).join('\n') + `\n\n`;
  } else {
    message += `• Усі борги закрито! Боржників немає 👏\n\n`;
  }

  // Штрафна банка
  const totalBank = await queries.getAllPaymentsTotal();
  const jarUrl = await queries.getSetting('jar_url', 'https://send.monobank.ua/jar/6fwMYmHxM1');
  message += `🏦 <b>Штрафна банка:</b> <b>${formatNumber(totalBank)} грн</b> зібрано\n`;
  message += `🔗 <b>Банка для штрафів:</b> <a href="${jarUrl}">${jarUrl}</a>`;

  return message;
}

/**
 * Форматує статус за місяць (/status)
 */
async function formatMonthlyStatusReport(yearMonth = null) {
  const tz = await queries.getSetting('timezone', 'Europe/Kyiv');
  const today = getTodayDateString(tz);
  const targetMonth = yearMonth || today.slice(0, 7);

  const statsList = await queries.getAllUsersMonthStats(targetMonth, today);
  const totalBank = await queries.getAllPaymentsTotal();
  const dailyGoal = Number(await queries.getSetting('daily_goal', '10000'));
  const graceLimit = Number(await queries.getSetting('grace_days_limit', '2'));
  const penaltyAmount = Number(await queries.getSetting('penalty_amount', '100'));

  if (!statsList || statsList.length === 0) {
    return `📊 Немає зареєстрованих учасників для показу статусу.`;
  }

  let text = `📊 <b>Статус челенджу за ${escapeHtml(formatMonthUkrainian(targetMonth))}</b>\n\n`;
  text += `🎯 Норма: <b>${formatNumber(dailyGoal)}</b> кр./день\n`;
  text += `🛡️ Пільгові дні: <b>${graceLimit} на місяць</b>\n`;
  text += `💸 Штраф: <b>${penaltyAmount} грн</b> за кожен день починаючи з 3-го\n\n`;

  text += `<b>Учасники команди:</b>\n`;
  let totalOutstandingDebt = 0;

  statsList.forEach((s, idx) => {
    const name = s.user.first_name 
      ? escapeHtml(s.user.first_name) 
      : (s.user.username ? `@${escapeHtml(s.user.username)}` : 'Учасник');
    const handle = s.user.username ? ` (@${escapeHtml(s.user.username)})` : '';
    totalOutstandingDebt += s.currentDebt;

    let graceStatus = `${s.graceDaysUsed}/${s.graceLimit}`;
    if (s.graceDaysUsed >= s.graceLimit) {
      graceStatus += ' (вичерпано ⚠️)';
    }

    text += `${idx + 1}. <b>${name}</b>${handle}\n`;
    text += `   • Пільгові дні: <b>${graceStatus}</b>\n`;
    text += `   • Штрафних днів: <b>${s.penaltyDaysCount}</b> (${formatNumber(s.monthPenaltiesTotal)} грн)\n`;
    text += `   • Поточний борг: <b>${s.currentDebt > 0 ? `${formatNumber(s.currentDebt)} грн ⚠️` : '0 грн ✅'}</b>\n`;
  });

  const jarUrl = await queries.getSetting('jar_url', 'https://send.monobank.ua/jar/6fwMYmHxM1');
  text += `\n━━━━━━━━━━━━━━━━━━━━\n`;
  text += `🏦 <b>Штрафна банка:</b> <b>${formatNumber(totalBank)} грн</b> (сплачено)\n`;
  text += `💳 <b>Несплачений борг команди:</b> <b>${formatNumber(totalOutstandingDebt)} грн</b>\n`;
  text += `🔗 <b>Банка для штрафів:</b> <a href="${jarUrl}">${jarUrl}</a>\n`;

  return text;
}

/**
 * Форматує стан штрафної банки (/bank)
 */
async function formatBankReport() {
  const totalBank = await queries.getAllPaymentsTotal();
  const recentPayments = await queries.getRecentPayments(5);

  const tz = await queries.getSetting('timezone', 'Europe/Kyiv');
  const today = getTodayDateString(tz);
  const currentMonth = today.slice(0, 7);
  const statsList = await queries.getAllUsersMonthStats(currentMonth, today);

  const debtors = statsList.filter(s => s.currentDebt > 0);
  const totalDebt = debtors.reduce((sum, s) => sum + s.currentDebt, 0);
  const jarUrl = await queries.getSetting('jar_url', 'https://send.monobank.ua/jar/6fwMYmHxM1');

  let text = `🏦 <b>Штрафна банка челенджу</b>\n\n`;
  text += `💰 <b>Зібрано коштів:</b> <b>${formatNumber(totalBank)} грн</b>\n`;
  text += `💳 <b>Загальний борг:</b> <b>${formatNumber(totalDebt)} грн</b>\n`;
  text += `🔗 <b>Офіційна банка Monobank:</b> <a href="${jarUrl}">${jarUrl}</a>\n\n`;

  text += `<b>Боржники:</b>\n`;
  if (debtors.length === 0) {
    text += `• Немає жодного боргу! Всі молодці 👏\n\n`;
  } else {
    debtors.forEach(d => {
      const name = d.user.first_name || `@${d.user.username}`;
      text += `• <b>${escapeHtml(name)}</b>: <b>${formatNumber(d.currentDebt)} грн</b>\n`;
    });
    text += `\n`;
  }

  text += `<b>Останні внески в банку:</b>\n`;
  if (recentPayments.length === 0) {
    text += `• Поки внесків не було.\n`;
  } else {
    recentPayments.forEach(p => {
      const name = p.first_name || (p.username ? `@${p.username}` : `ID: ${p.user_id}`);
      const date = p.created_at ? String(p.created_at).slice(0, 16) : '';
      const notes = p.notes ? ` (${escapeHtml(p.notes)})` : '';
      text += `• ${escapeHtml(name)} — <b>+${formatNumber(p.amount)} грн</b>${notes} <i>${date}</i>\n`;
    });
  }

  text += `\n<i>Адміністратор може зафіксувати оплату: <code>/paid @username 100</code></i>`;
  return text;
}

/**
 * Форматує персональну статистику користувача
 */
async function formatUserStats(userId) {
  const user = await queries.getUser(userId);
  if (!user) {
    return 'Користувача не знайдено. Натисніть /start для реєстрації.';
  }

  const tz = await queries.getSetting('timezone', 'Europe/Kyiv');
  const today = getTodayDateString(tz);
  const currentMonth = today.slice(0, 7);

  const summary = await queries.getUserSummaryStats(userId);
  const history = await queries.getUserWeeklyHistory(userId, 7);
  const monthStats = await queries.getUserMonthStats(userId, currentMonth, today);
  const dailyGoal = Number(await queries.getSetting('daily_goal', '10000'));
  const jarUrl = await queries.getSetting('jar_url', 'https://send.monobank.ua/jar/6fwMYmHxM1');

  let msg = `👤 <b>Ваша статистика, ${escapeHtml(user.first_name)}:</b>\n\n`;
  
  msg += `📊 <b>Загальні показники:</b>\n`;
  msg += `• Активних днів: <b>${summary.total_days}</b>\n`;
  msg += `• Всього пройдено: <b>${formatNumber(summary.total_steps)}</b> кроків\n`;
  msg += `• Середній результат: <b>${formatNumber(summary.avg_steps)}</b> кр./день\n`;
  msg += `• Рекорд за день: <b>${formatNumber(summary.max_steps)}</b> кроків 🔥\n\n`;

  if (monthStats) {
    msg += `📅 <b>Поточний місяць (${escapeHtml(formatMonthUkrainian(currentMonth))}):</b>\n`;
    msg += `• Пільгових днів: <b>${monthStats.graceDaysUsed}/${monthStats.graceLimit}</b> `;
    if (monthStats.graceDaysRemaining > 0) {
      msg += `(залишилось: ${monthStats.graceDaysRemaining})\n`;
    } else {
      msg += `(вичерпано ⚠️)\n`;
    }
    msg += `• Штрафних днів цього місяця: <b>${monthStats.penaltyDaysCount}</b>\n`;
    msg += `• Нараховано штрафів: <b>${formatNumber(monthStats.monthPenaltiesTotal)} грн</b>\n`;
    msg += `• Сплачено в банку: <b>${formatNumber(monthStats.totalPaid)} грн</b>\n`;
    msg += `• Поточний борг: <b>${monthStats.currentDebt > 0 ? `${formatNumber(monthStats.currentDebt)} грн ⚠️` : '0 грн ✅'}</b>\n`;
    if (monthStats.currentDebt > 0) {
      msg += `👉 <i>Сплатити борг у банку: <a href="${jarUrl}">${jarUrl}</a></i>\n`;
    }
    msg += `\n`;
  }

  msg += `🗓️ <b>Останні дні:</b>\n`;
  if (!history || history.length === 0) {
    msg += `Поки немає записів. Надішліть скріншот крокоміра або скористайтеся /steps [число].\n`;
  } else {
    for (const h of history) {
      const reached = h.steps >= dailyGoal ? ' 🎯' : '';
      msg += `• ${h.date}: <b>${formatNumber(h.steps)}</b> кр.${reached}\n`;
    }
  }

  return msg;
}

/**
 * Текст нагадування для публікації в спільний груповий чат
 */
async function formatGroupReminderMessage(missingUsers, date = null) {
  const tz = await queries.getSetting('timezone', 'Europe/Kyiv');
  const targetDate = date || getTodayDateString(tz);
  const reportTime = await queries.getSetting('report_time', '22:00');
  const dailyGoal = Number(await queries.getSetting('daily_goal', '10000'));
  const jarUrl = await queries.getSetting('jar_url', 'https://send.monobank.ua/jar/6fwMYmHxM1');
  
  const mentions = missingUsers.map(u => {
    return u.username ? `@${escapeHtml(u.username)}` : `<b>${escapeHtml(u.first_name)}</b>`;
  }).join(' ');

  let msg = `⏰ <b>Нагадування — до ${reportTime} приймаю звіти за ${escapeHtml(formatUkrainianDate(targetDate))}</b>\n\n`;
  msg += `Ще не бачу звіту від:\n${mentions}\n\n`;
  msg += `Норма — <b>${formatNumber(dailyGoal)}</b> кроків. Пам'ятайте: є лише 2 пільгових дні на місяць, далі — штраф 100 грн у банку (<a href="${jarUrl}">посилання на банку</a>)! 👟`;
  return msg;
}

/**
 * Текст персонального нагадування в приватні
 */
function formatReminderMessage(firstName) {
  return (
    `Привіт, ${firstName}! 👟\n\n` +
    `Нагадуємо скинути скріншот своїх кроків за сьогодні до вечірнього звіту! 📸\n` +
    `Щоденна норма — 10 000 кроків. Не витрачайте пільгові дні даремно 💪\n\n` +
    `Просто надішліть фото сюди в чат або напишіть /steps [число].`
  );
}

/**
 * Визначає, чи є ім'я жіночим (для правильної форми дієслова в українській мові)
 */
function isFemaleName(name) {
  if (!name) return false;
  const clean = String(name).trim().replace(/^[^\p{L}]+/u, '').split(/\s+/)[0].toLowerCase();
  if (!clean) return false;

  const maleExceptions = new Set(['микола', 'ілля', 'кузьма', 'лука', 'сава', 'микита', 'льова']);
  if (maleExceptions.has(clean)) return false;

  const femaleExceptions = new Set(['любов', 'ніколь', 'ірен', 'кармен', 'адель', 'іннес']);
  if (femaleExceptions.has(clean)) return true;

  return clean.endsWith('а') || clean.endsWith('я');
}

/**
 * Форматує повідомлення-підтвердження про зарахування кроків
 */
function formatStepSuccessMessage({ name, steps, dailyGoal = 10000, previousSteps = 0, addedSteps = 0, albumSteps = null }) {
  const safeName = escapeHtml(name || 'Колега');
  const percent = Math.round((steps / dailyGoal) * 100);
  const isGoalReached = steps >= dailyGoal;
  const verb = isFemaleName(name) ? 'розірвала' : 'розірвав';
  const stepsToAdd = addedSteps > 0 ? addedSteps : steps;

  let line1 = `Зафіксував результат <b>${safeName}</b>, <b>+${formatNumber(stepsToAdd)}</b>🏃‍♂️`;
  if (previousSteps > 0) {
    line1 += ` <i>(разом: ${formatNumber(steps)})</i>`;
  }

  let line2 = '';
  if (isGoalReached) {
    line2 = `🎯 Ціль виконано на <b>${percent}%</b>, Ти ${verb} цей день, продовжуй в тому ж русі 💥`;
  } else {
    const remaining = dailyGoal - steps;
    line2 = `🎯 Ціль виконано на <b>${percent}%</b> (до норми ще ${formatNumber(remaining)} кр.), продовжуй в тому ж русі 💪`;
  }

  return `${line1}\n${line2}`;
}

module.exports = {
  formatDailyReport,
  formatMonthlyStatusReport,
  formatBankReport,
  formatUserStats,
  formatReminderMessage,
  formatGroupReminderMessage,
  formatStepSuccessMessage,
  escapeHtml,
};
