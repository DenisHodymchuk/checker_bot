/**
 * Повертає дату у форматі YYYY-MM-DD з урахуванням часового поясу (за замовчуванням Europe/Kyiv)
 */
function getTodayDateString(timeZone = 'Europe/Kyiv', dateObj = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(dateObj); // повертає YYYY-MM-DD
}

/**
 * Повертає попередній календарний день у форматі YYYY-MM-DD від заданого рядка YYYY-MM-DD
 */
function getPreviousDateString(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d));
  utc.setUTCDate(utc.getUTCDate() - 1);
  return utc.toISOString().slice(0, 10);
}

/**
 * Повертає вчорашню дату у форматі YYYY-MM-DD
 */
function getYesterdayDateString(timeZone = 'Europe/Kyiv', dateObj = new Date()) {
  const todayStr = getTodayDateString(timeZone, dateObj);
  return getPreviousDateString(todayStr);
}

/**
 * Повертає час у форматі "HH:MM" у заданому часовому поясі
 */
function getKyivTimeHHMM(timeZone = 'Europe/Kyiv', dateObj = new Date()) {
  return new Intl.DateTimeFormat('uk-UA', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(dateObj);
}

/**
 * Визначає цільову дату (YYYY-MM-DD), за яку зараховуються кроки.
 * Правило дедлайну 12:00 наступного дня:
 * - Результати за день D приймаються до 12:00 дня D+1.
 * - Якщо скрін надіслано до 12:00 дня D+1, і за день D (вчора) норму ще не виконано
 *   (або запис за вчора вже створювався сьогодні вранці — серія скрінів), кроки йдуть за день D (вчора).
 * - Якщо після 12:00 — кроки йдуть за поточний день D+1.
 */
async function resolveSubmissionDate({
  userId,
  messageDate = new Date(),
  timeZone = 'Europe/Kyiv',
  deadlineTime = '12:00',
  dailyGoal = 10000,
  getUserStepsForDate,
}) {
  const msgDayStr = getTodayDateString(timeZone, messageDate);
  const msgTimeHHMM = getKyivTimeHHMM(timeZone, messageDate);

  if (msgTimeHHMM < deadlineTime && typeof getUserStepsForDate === 'function') {
    const prevDayStr = getPreviousDateString(msgDayStr);
    // Перевіряємо лише якщо попередній день у тому ж місяці (або загалом не закритий)
    const prevEntry = await getUserStepsForDate(userId, prevDayStr);
    const prevSteps = prevEntry ? (Number(prevEntry.steps) || 0) : 0;
    const prevCreatedDate = prevEntry?.created_at ? String(prevEntry.created_at).slice(0, 10) : '';

    // Якщо за вчора ще немає кроків, або менше норми, або користувач досилає другий скрін сьогодні вранці за вчора
    if (!prevEntry || prevSteps < dailyGoal || prevCreatedDate === msgDayStr) {
      return prevDayStr;
    }
  }

  return msgDayStr;
}

/**
 * Форматує дату для гарного відображення українською: "8 листопада (Неділя)"
 */
function formatUkrainianDate(dateString) {
  if (!dateString) return '';
  const [year, month, day] = dateString.split('-').map(Number);
  const d = new Date(year, month - 1, day);
  
  const dayAndMonth = d.toLocaleDateString('uk-UA', { day: 'numeric', month: 'long' });
  const weekday = d.toLocaleDateString('uk-UA', { weekday: 'long' });
  const capitalizedWeekday = weekday.charAt(0).toUpperCase() + weekday.slice(1);
  return `${dayAndMonth} (${capitalizedWeekday})`;
}

/**
 * Форматує місяць: "2026-11" -> "Листопад 2026"
 */
function formatMonthUkrainian(yearMonth) {
  if (!yearMonth) return '';
  const [year, month] = yearMonth.split('-').map(Number);
  const d = new Date(year, month - 1, 1);
  const m = d.toLocaleDateString('uk-UA', { month: 'long', year: 'numeric' });
  return m.charAt(0).toUpperCase() + m.slice(1);
}

/**
 * Форматує число кроків з роздільником тисяч: 12450 -> 12 450
 */
function formatNumber(num) {
  return Number(num || 0).toLocaleString('uk-UA');
}

/**
 * Перетворює введений користувачем рядок дати (наприклад: "8", "вчора", "2026-11-08") на YYYY-MM-DD
 */
function resolveTargetDate(inputStr, timeZone = 'Europe/Kyiv', defaultToYesterday = false) {
  const today = getTodayDateString(timeZone);
  if (!inputStr) {
    return defaultToYesterday ? getYesterdayDateString(timeZone) : today;
  }

  const raw = String(inputStr).trim().toLowerCase();
  if (raw === 'вчора' || raw === 'yesterday') {
    return getYesterdayDateString(timeZone);
  }
  if (raw === 'сьогодні' || raw === 'today') {
    return today;
  }
  // Число місяця 1..31 (наприклад: "8" або "5")
  if (/^\d{1,2}$/.test(raw)) {
    const dayNum = Number(raw);
    if (dayNum >= 1 && dayNum <= 31) {
      const yearMonth = today.slice(0, 7);
      return `${yearMonth}-${String(dayNum).padStart(2, '0')}`;
    }
  }
  // Повна дата YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw;
  }
  // Дата у форматі DD.MM або DD.MM.YYYY
  if (/^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?$/.test(raw)) {
    const match = raw.match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?$/);
    const day = String(match[1]).padStart(2, '0');
    const month = String(match[2]).padStart(2, '0');
    const year = match[3] || today.slice(0, 4);
    return `${year}-${month}-${day}`;
  }

  return defaultToYesterday ? getYesterdayDateString(timeZone) : today;
}

module.exports = {
  getTodayDateString,
  getPreviousDateString,
  getYesterdayDateString,
  getKyivTimeHHMM,
  resolveSubmissionDate,
  formatUkrainianDate,
  formatMonthUkrainian,
  formatNumber,
  resolveTargetDate,
};
