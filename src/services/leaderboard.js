const queries = require('../db/queries');
const { 
  formatUkrainianDate, 
  formatMonthUkrainian, 
  formatNumber, 
  getTodayDateString,
  getYesterdayDateString,
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
 * За замовчуванням формує звіт за вчорашній день (оскільки підсумки за 8 число підбиваються 9-го числа після 12:00)
 */
async function formatDailyReport(date = null, options = {}) {
  const tz = await queries.getSetting('timezone', 'Europe/Kyiv');
  const targetDate = date || getYesterdayDateString(tz);
  const yearMonth = targetDate.slice(0, 7);

  const rows = await queries.getLeaderboard(targetDate);
  const dailyGoal = Number(await queries.getSetting('daily_goal', '10000'));
  const graceLimit = Number(await queries.getSetting('grace_days_limit', '2'));
  const penaltyAmount = Number(await queries.getSetting('penalty_amount', '100'));
  const deadlineTime = await queries.getSetting('deadline_time', '12:00');

  if (!rows || rows.length === 0) {
    return (
      `👟 <b>Підсумки за ${escapeHtml(formatUkrainianDate(targetDate))}</b>\n` +
      `🎯 Щоденна норма: <b>${formatNumber(dailyGoal)}</b> кроків\n\n` +
      `Поки немає зареєстрованих учасників у челенджі.`
    );
  }

  // Отримуємо детальну місячну оцінку кожного користувача до цільової дати
  const userMonthStatsMap = new Map();
  for (const r of rows) {
    const stats = await queries.getUserMonthStats(r.user_id, yearMonth, targetDate, options);
    if (stats) userMonthStatsMap.set(r.user_id, stats);
  }

  const passed = rows.filter(r => r.steps && r.steps >= dailyGoal);
  const underGoal = rows.filter(r => r.steps && r.steps > 0 && r.steps < dailyGoal);
  const missing = rows.filter(r => !r.steps || r.steps === 0);
  const completed = rows.filter(r => r.steps && r.steps > 0);

  let message = `👟 <b>Підсумки за ${escapeHtml(formatUkrainianDate(targetDate))}</b>\n`;
  message += `🎯 Щоденна норма: <b>${formatNumber(dailyGoal)}</b> кроків\n\n`;

  // 1. Хто скільки пройшов
  message += `<b>🏆 Хто скільки пройшов:</b>\n`;
  if (completed.length === 0) {
    message += `За цей день ще ніхто не зафіксував кроки.\n\n`;
  } else {
    completed.forEach((entry, index) => {
      const name = entry.first_name 
        ? escapeHtml(entry.first_name) 
        : (entry.username ? `@${escapeHtml(entry.username)}` : 'Учасник');
      const handle = entry.username ? ` (@${escapeHtml(entry.username)})` : '';
      const percent = Math.round((entry.steps / dailyGoal) * 100);
      const isTargetReached = entry.steps >= dailyGoal;

      let tag = '';
      if (isTargetReached) {
        tag = ' 🎯';
      } else {
        const uStats = userMonthStatsMap.get(entry.user_id);
        const dayEval = uStats?.daysBreakdown.find(d => d.date === targetDate);
        if (dayEval) {
          if (dayEval.status === 'grace_1') tag = ` 🛡️ (пропуск 1/${graceLimit})`;
          else if (dayEval.status === 'grace_2') tag = ` 🛡️ (пропуск 2/${graceLimit})`;
          else if (dayEval.status === 'penalty') tag = ` 💸 (+${penaltyAmount} грн штраф, ${dayEval.missedOrder}/${graceLimit})`;
        }
      }

      message += `${index + 1}. ${name}${handle} — <b>${formatNumber(entry.steps)}</b> (${percent}%)${tag}\n`;
    });
    message += `\n`;
  }

  // 2. Хто не пройшов норму або не скинув скрін
  const failedOrMissing = [...underGoal, ...missing];
  if (failedOrMissing.length > 0) {
    message += `<b>❌ Не виконали норму / Не скинули скрін:</b>\n`;
    failedOrMissing.forEach(m => {
      const name = m.first_name 
        ? escapeHtml(m.first_name) 
        : (m.username ? `@${escapeHtml(m.username)}` : 'Учасник');
      const handle = m.username ? ` (@${escapeHtml(m.username)})` : '';
      const uStats = userMonthStatsMap.get(m.user_id);
      const dayEval = uStats?.daysBreakdown.find(d => d.date === targetDate);
      const stepStr = m.steps && m.steps > 0 ? `${formatNumber(m.steps)} кр.` : 'не скинув(ла) скрін (0 кр.)';

      let tag = '';
      if (dayEval) {
        if (dayEval.status === 'grace_1') tag = ` — 🛡️ пільговий пропуск (1/${graceLimit})`;
        else if (dayEval.status === 'grace_2') tag = ` — 🛡️ пільговий пропуск (2/${graceLimit})`;
        else if (dayEval.status === 'penalty') tag = ` — 💸 <b>штраф +${penaltyAmount} грн</b> (пропуск ${dayEval.missedOrder}/${graceLimit})`;
      }

      message += `• ${name}${handle}: ${stepStr}${tag}\n`;
    });
    message += `\n`;
  }

  // Командна статистика
  const totalSteps = completed.reduce((sum, r) => sum + r.steps, 0);
  const avgSteps = completed.length > 0 ? Math.round(totalSteps / completed.length) : 0;

  message += `<b>📊 По команді:</b>\n`;
  message += `• Загалом: <b>${formatNumber(totalSteps)}</b> кроків\n`;
  message += `• Середнє: <b>${formatNumber(avgSteps)}</b> кр./чол.\n`;
  message += `• Виконали норму: <b>${passed.length}/${rows.length}</b>\n\n`;

  // 3. Штрафи за цей день
  const isDayInProgress = rows.some(r => {
    const uStats = userMonthStatsMap.get(r.user_id);
    const dayEval = uStats?.daysBreakdown.find(d => d.date === targetDate);
    return dayEval && dayEval.status === 'in_progress';
  });

  const penalizedOnDate = [];
  for (const r of rows) {
    const uStats = userMonthStatsMap.get(r.user_id);
    const dayEval = uStats?.daysBreakdown.find(d => d.date === targetDate);
    if (dayEval && dayEval.penalty > 0) {
      const name = r.first_name || (r.username ? `@${r.username}` : 'Учасник');
      const handle = r.username ? ` (@${escapeHtml(r.username)})` : '';
      penalizedOnDate.push(`${escapeHtml(name)}${handle}: <b>+${dayEval.penalty} грн</b> (${dayEval.missedOrder}-й пропуск за місяць)`);
    }
  }

  message += `<b>💸 Штрафи за ${escapeHtml(formatUkrainianDate(targetDate))}:</b>\n`;
  if (isDayInProgress) {
    message += `• ⏳ Прийом скрінів за цей день триває до <b>${escapeHtml(deadlineTime)} наступного дня</b> — фіксація пропусків і штрафів відбудеться о ${escapeHtml(deadlineTime)}.\n\n`;
  } else if (penalizedOnDate.length > 0) {
    message += penalizedOnDate.map(p => `• ${p}`).join('\n') + `\n\n`;
  } else {
    message += `• За цей день без штрафів! Всі вклалися в норму або пільгові дні 🎉\n\n`;
  }

  // Борги учасників за місяць
  const debtors = [];
  for (const r of rows) {
    const uStats = userMonthStatsMap.get(r.user_id);
    if (uStats && uStats.currentDebt > 0) {
      const name = r.first_name || (r.username ? `@${r.username}` : 'Учасник');
      debtors.push(`${escapeHtml(name)}: <b>${formatNumber(uStats.currentDebt)} грн</b>`);
    }
  }

  if (debtors.length > 0) {
    message += `<b>💳 Загальні несплачені штрафи:</b>\n`;
    message += debtors.map(d => `• ${d}`).join('\n') + `\n\n`;
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
  text += `🎯 Норма: <b>${formatNumber(dailyGoal)}</b> кр./день (прийом до 12:00 наступного дня)\n`;
  text += `🛡️ Пільгові пропуски: <b>${graceLimit} на місяць</b>\n`;
  text += `💸 Штраф: <b>${penaltyAmount} грн</b> за кожен пропуск понад ${graceLimit}\n\n`;

  text += `<b>Учасники команди:</b>\n`;
  let totalOutstandingDebt = 0;

  statsList.forEach((s, idx) => {
    const name = s.user.first_name 
      ? escapeHtml(s.user.first_name) 
      : (s.user.username ? `@${escapeHtml(s.user.username)}` : 'Учасник');
    const handle = s.user.username ? ` (@${escapeHtml(s.user.username)})` : '';
    totalOutstandingDebt += s.currentDebt;

    let missStatus = `${s.missedDays}/${s.graceLimit}`;
    if (s.missedDays > s.graceLimit) {
      missStatus += ` (штрафних: ${s.penaltyDaysCount} 💸)`;
    } else if (s.missedDays === s.graceLimit) {
      missStatus += ' (пільги вичерпано ⚠️)';
    }

    text += `${idx + 1}. <b>${name}</b>${handle}\n`;
    text += `   • Кроків за місяць: <b>${formatNumber(s.totalMonthSteps)}</b> кр.\n`;
    text += `   • Пропуски / Пільги: <b>${missStatus}</b>\n`;
    text += `   • Нараховано штрафів: <b>${formatNumber(s.monthPenaltiesTotal)} грн</b>\n`;
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
    msg += `• Пропуски / Пільги: <b>${monthStats.missedDays}/${monthStats.graceLimit}</b> `;
    if (monthStats.graceDaysRemaining > 0) {
      msg += `(залишилось пільг: ${monthStats.graceDaysRemaining})\n`;
    } else {
      msg += `(пільги вичерпано ⚠️)\n`;
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
 * Текст нагадування об 11:00 наступного дня для публікації в спільний груповий чат
 * Відмічає всіх, хто не скинув скрін за вчора, з попередженням що через годину (о 12:00)
 * будуть зараховані пропуски та штрафи (у кого пропусків більше 2).
 */
async function formatGroupReminderMessage(missingUsers, date = null) {
  const tz = await queries.getSetting('timezone', 'Europe/Kyiv');
  const targetDate = date || getYesterdayDateString(tz);
  const yearMonth = targetDate.slice(0, 7);
  const deadlineTime = await queries.getSetting('deadline_time', '12:00');
  const dailyGoal = Number(await queries.getSetting('daily_goal', '10000'));
  const graceLimit = Number(await queries.getSetting('grace_days_limit', '2'));
  const penaltyAmount = Number(await queries.getSetting('penalty_amount', '100'));
  const jarUrl = await queries.getSetting('jar_url', 'https://send.monobank.ua/jar/6fwMYmHxM1');

  const mentions = [];
  const penaltyWarnList = [];

  for (const u of missingUsers) {
    const tag = u.username ? `@${escapeHtml(u.username)}` : `<b>${escapeHtml(u.first_name)}</b>`;
    mentions.push(tag);

    const stats = await queries.getUserMonthStats(u.user_id, yearMonth, targetDate);
    if (stats && stats.missedDays >= graceLimit) {
      const nameStr = u.first_name ? escapeHtml(u.first_name) : tag;
      penaltyWarnList.push(`${nameStr} (${tag}) — вже має <b>${stats.missedDays}/${graceLimit}</b> пропусків`);
    }
  }

  let msg = `⏰ <b>УВАГА! Залишилась 1 година до закриття прийому скрінів за ${escapeHtml(formatUkrainianDate(targetDate))}!</b>\n\n`;
  msg += `Ще не скинули скрін за вчора:\n${mentions.join(' ')}\n\n`;
  msg += `⚠️ <b>Попередження:</b> через годину (рівно о <b>${escapeHtml(deadlineTime)}</b>) прийом результатів за ${escapeHtml(formatUkrainianDate(targetDate))} закривається!\n`;
  msg += `• Хто не скине скрін до <b>${escapeHtml(deadlineTime)}</b> — отримає <b>пропуск</b>.\n`;
  msg += `• У кого пропусків стане <b>більше ${graceLimit}</b> — автоматично нараховується <b>штраф +${penaltyAmount} грн</b> у банку (<a href="${jarUrl}">Monobank</a>)! 💸`;

  if (penaltyWarnList.length > 0) {
    msg += `\n\n🚨 <b>У зоні штрафу (+${penaltyAmount} грн о ${escapeHtml(deadlineTime)}, якщо не буде скріна):</b>\n`;
    msg += penaltyWarnList.map(p => `• ${p}`).join('\n');
  }

  msg += `\n\n🎯 Щоденна норма — <b>${formatNumber(dailyGoal)}</b> кроків. Поспішіть надіслати скріншот! 👟`;
  return msg;
}

/**
 * Текст персонального нагадування в приватні об 11:00
 */
function formatReminderMessage(firstName, dateStr = '') {
  const dateLabel = dateStr ? formatUkrainianDate(dateStr) : 'вчора';
  return (
    `Привіт, ${firstName}! 👟\n\n` +
    `⏰ Ви ще не надіслали скріншот своїх кроків за ${dateLabel}!\n` +
    `Через 1 годину (о 12:00) прийом результатів закриється і будуть зафіксовані пропуски та штрафи (у кого більше 2 пропусків — +100 грн у банку).\n\n` +
    `Будь ласка, надішліть скріншот у гілку скрінів або сюди в чат до 12:00! 📸`
  );
}

/**
 * Визначає, чи є ім'я жіночим (для правильної форми дієслова в українській мові)
 */
function isFemaleName(name, username = '') {
  const candidates = [name, username].filter(Boolean);
  for (const raw of candidates) {
    const clean = String(raw).trim().replace(/^[^\p{L}]+/u, '').split(/[\s_]+/)[0].toLowerCase();
    if (!clean) continue;

    const maleExceptions = new Set([
      'микола', 'ілля', 'кузьма', 'лука', 'сава', 'микита', 'льова', 'женя',
      'mykola', 'illia', 'illya', 'mykyta', 'nikita', 'luka', 'sava', 'shaadrin',
    ]);
    if (maleExceptions.has(clean)) return false;

    const femaleExceptions = new Set([
      'любов', 'ніколь', 'ірен', 'кармен', 'адель', 'іннес',
      'kate', 'каte', 'katrin', 'liza', 'iryna', 'dasha', 'daria', 'dariya',
      'noppa', 'kseni', 'ksenia', 'ksenya', 'alina', 'anastasia', 'anastasiia',
      'victoria', 'victoriia', 'diana', 'ira', 'kristina', 'krystyna', 'olha', 'olga', 'svitlana',
    ]);
    if (femaleExceptions.has(clean)) return true;

    // Кириличні або латинські жіночі закінчення (-а, -я, -a, -ia, -ya)
    if (clean.endsWith('а') || clean.endsWith('я') || clean.endsWith('a')) {
      return true;
    }
  }

  return false;
}

/**
 * Форматує повідомлення-підтвердження про зарахування кроків
 */
function formatStepSuccessMessage({ name, username = '', steps, dailyGoal = 10000, previousSteps = 0, addedSteps = 0 }) {
  const safeName = escapeHtml(name || 'Колега');
  const percent = Math.round((steps / dailyGoal) * 100);
  const isGoalReached = steps >= dailyGoal;
  const female = isFemaleName(name, username);
  const verb = female ? 'розірвала' : 'розірвав';
  const runnerEmoji = female ? '🏃‍♀️' : '🏃‍♂️';
  const stepsToAdd = addedSteps > 0 ? addedSteps : steps;

  let line1 = `Зафіксував результат <b>${safeName}</b>, <b>+${formatNumber(stepsToAdd)}</b>${runnerEmoji}`;
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

/**
 * Форматує загальний рейтинг кроків за місяць (/top month)
 */
async function formatMonthlyLeaderboard(yearMonth = null) {
  const tz = await queries.getSetting('timezone', 'Europe/Kyiv');
  const today = getTodayDateString(tz);
  const targetMonth = yearMonth || today.slice(0, 7);

  const rows = await queries.getMonthlyLeaderboard(targetMonth);
  if (!rows || rows.length === 0) {
    return `🏆 Немає даних для рейтингу за ${escapeHtml(formatMonthUkrainian(targetMonth))}.`;
  }

  let text = `🏆 <b>Загальний рейтинг кроків за ${escapeHtml(formatMonthUkrainian(targetMonth))}</b>\n\n`;
  const medals = ['🥇', '🥈', '🥉'];

  let totalTeamSteps = 0;
  rows.forEach((r, idx) => {
    totalTeamSteps += r.total_steps;
    const prefix = medals[idx] || `${idx + 1}.`;
    const name = r.first_name 
      ? escapeHtml(r.first_name) 
      : (r.username ? `@${escapeHtml(r.username)}` : 'Учасник');
    const handle = r.username ? ` (@${escapeHtml(r.username)})` : '';
    const avg = r.days_count > 0 ? Math.round(r.total_steps / r.days_count) : 0;

    text += `${prefix} <b>${name}</b>${handle}\n`;
    text += `   • Всього: <b>${formatNumber(r.total_steps)}</b> кр. (${r.days_count} дн., сер. ${formatNumber(avg)}/д)\n`;
  });

  const avgPerPerson = Math.round(totalTeamSteps / rows.length);
  text += `\n━━━━━━━━━━━━━━━━━━━━\n`;
  text += `👟 <b>Загалом команда пройшла:</b> <b>${formatNumber(totalTeamSteps)}</b> кроків\n`;
  text += `📈 <b>Середній показник на учасника:</b> <b>${formatNumber(avgPerPerson)}</b> кроків`;

  return text;
}

/**
 * Форматує окремий звіт по штрафах, пільгах та банці за день (якщо штрафи налаштовані в окрему гілку)
 */
async function formatDailyPenaltyReport(date = null, options = {}) {
  const tz = await queries.getSetting('timezone', 'Europe/Kyiv');
  const targetDate = date || getYesterdayDateString(tz);
  const yearMonth = targetDate.slice(0, 7);

  const rows = await queries.getLeaderboard(targetDate);
  const penaltyAmount = Number(await queries.getSetting('penalty_amount', '100'));
  const graceLimit = Number(await queries.getSetting('grace_days_limit', '2'));
  const deadlineTime = await queries.getSetting('deadline_time', '12:00');

  const userMonthStatsMap = new Map();
  for (const r of rows) {
    const stats = await queries.getUserMonthStats(r.user_id, yearMonth, targetDate, options);
    if (stats) userMonthStatsMap.set(r.user_id, stats);
  }

  const graceUsedToday = [];
  const penalizedToday = [];
  const debtors = [];

  for (const r of rows) {
    const uStats = userMonthStatsMap.get(r.user_id);
    if (!uStats) continue;
    const name = r.first_name || (r.username ? `@${r.username}` : 'Учасник');
    const dayEval = uStats.daysBreakdown.find(d => d.date === targetDate);

    if (dayEval) {
      if (dayEval.status === 'grace_1') {
        graceUsedToday.push(`${escapeHtml(name)} — <b>${formatNumber(dayEval.steps)} кр.</b> (пропуск 1/${graceLimit} 🛡️)`);
      } else if (dayEval.status === 'grace_2') {
        graceUsedToday.push(`${escapeHtml(name)} — <b>${formatNumber(dayEval.steps)} кр.</b> (пропуск 2/${graceLimit} 🛡️)`);
      } else if (dayEval.status === 'penalty') {
        penalizedToday.push(`${escapeHtml(name)} — <b>+${penaltyAmount} грн</b> (${dayEval.missedOrder}-й пропуск, ${formatNumber(dayEval.steps)} кр.)`);
      }
    }

    if (uStats.currentDebt > 0) {
      debtors.push(`${escapeHtml(name)}: <b>${formatNumber(uStats.currentDebt)} грн</b>`);
    }
  }

  const isDayInProgress = rows.some(r => {
    const uStats = userMonthStatsMap.get(r.user_id);
    const dayEval = uStats?.daysBreakdown.find(d => d.date === targetDate);
    return dayEval && dayEval.status === 'in_progress';
  });

  let msg = `💸 <b>Звіт по пропусках та штрафах за ${escapeHtml(formatUkrainianDate(targetDate))}</b>\n\n`;

  if (graceUsedToday.length > 0) {
    msg += `<b>🛡️ Зараховано пільговий пропуск:</b>\n`;
    msg += graceUsedToday.map(g => `• ${g}`).join('\n') + `\n\n`;
  }

  msg += `<b>💸 Нараховані штрафи за ${escapeHtml(formatUkrainianDate(targetDate))}:</b>\n`;
  if (isDayInProgress) {
    msg += `• ⏳ Прийом скрінів триває до <b>${escapeHtml(deadlineTime)}</b> — підрахунок пропусків і штрафів відбудеться о ${escapeHtml(deadlineTime)}.\n\n`;
  } else if (penalizedToday.length > 0) {
    msg += penalizedToday.map(p => `• ${p}`).join('\n') + `\n\n`;
  } else {
    msg += `• За цей день без нових штрафів! 🎉\n\n`;
  }

  msg += `<b>💳 Поточні борги:</b>\n`;
  if (debtors.length > 0) {
    msg += debtors.map(d => `• ${d}`).join('\n') + `\n\n`;
  } else {
    msg += `• Усі борги закрито! 👏\n\n`;
  }

  const totalBank = await queries.getAllPaymentsTotal();
  const jarUrl = await queries.getSetting('jar_url', 'https://send.monobank.ua/jar/6fwMYmHxM1');
  msg += `🏦 <b>Штрафна банка:</b> <b>${formatNumber(totalBank)} грн</b> зібрано\n`;
  msg += `🔗 <b>Банка Monobank:</b> <a href="${jarUrl}">${jarUrl}</a>`;

  return msg;
}

module.exports = {
  formatDailyReport,
  formatDailyPenaltyReport,
  formatMonthlyStatusReport,
  formatMonthlyLeaderboard,
  formatBankReport,
  formatUserStats,
  formatReminderMessage,
  formatGroupReminderMessage,
  formatStepSuccessMessage,
  escapeHtml,
};
