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
 * Форматує число кроків з роздільником тисяч: 12450 -> 12 450
 */
function formatNumber(num) {
  return Number(num || 0).toLocaleString('uk-UA');
}

module.exports = {
  getTodayDateString,
  getYesterdayDateString,
  formatUkrainianDate,
  formatNumber,
};
