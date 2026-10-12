/**
 * Повертає поточну дату у форматі YYYY-MM-DD з урахуванням часового поясу (за замовчуванням Europe/Kyiv)
 */
function getTodayDateString(timeZone = 'Europe/Kyiv') {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(new Date()); // повертає YYYY-MM-DD
}

/**
 * Повертає вчорашню дату у форматі YYYY-MM-DD
 */
function getYesterdayDateString(timeZone = 'Europe/Kyiv') {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(yesterday);
}

/**
 * Форматує дату для гарного відображення українською: "11 жовтня (неділя)"
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
 * Форматує місяць: "2026-10" -> "Жовтень 2026"
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
 * Перетворює введений користувачем рядок дати (наприклад: "11", "вчора", "2026-10-11") на YYYY-MM-DD
 */
function resolveTargetDate(inputStr, timeZone = 'Europe/Kyiv') {
  const today = getTodayDateString(timeZone);
  if (!inputStr) return today;

  const raw = String(inputStr).trim().toLowerCase();
  if (raw === 'вчора' || raw === 'yesterday') {
    return getYesterdayDateString(timeZone);
  }
  if (raw === 'сьогодні' || raw === 'today') {
    return today;
  }
  // Число місяця 1..31 (наприклад: "11" або "5")
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

  return today;
}

module.exports = {
  getTodayDateString,
  getYesterdayDateString,
  formatUkrainianDate,
  formatMonthUkrainian,
  formatNumber,
  resolveTargetDate,
};
