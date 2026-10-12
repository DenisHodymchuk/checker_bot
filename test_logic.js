const assert = require('node:assert');
const { initDatabase } = require('./src/db/database');
const queries = require('./src/db/queries');
const { formatDailyReport, formatMonthlyStatusReport, formatBankReport } = require('./src/services/leaderboard');

async function runTests() {
  console.log('🧪 Запуск перевірки бізнес-логіки...');

  // 1. Ініціалізація бази даних
  await initDatabase();
  console.log('✅ 1. База даних ініціалізована.');

  // 2. Створення тестових користувачів
  const testUserId = 999901;
  const testUser2Id = 999902;
  await queries.upsertUser(testUserId, 'Тестер Василь', 'vasyl_tester');
  await queries.upsertUser(testUser2Id, 'Тестерка Марія', 'maria_tester');

  const user = await queries.getUser(testUserId);
  assert.strictEqual(user.first_name, 'Тестер Василь');
  assert.strictEqual(user.username, 'vasyl_tester');

  const foundByHandle = await queries.findUserByHandleOrId('@vasyl_tester');
  assert.strictEqual(foundByHandle.id, testUserId);
  console.log('✅ 2. Користувачів успішно створено та знайдено за handle/id.');

  // 3. Тестування бізнес-правил (10k кроків, 2 пільгових дні, 100 грн штраф)
  const yearMonth = '2026-10';
  
  // День 1 (2026-10-01): 6 000 кроків (< 10 000) -> 1-й пільговий (1/2)
  await queries.saveDailySteps(testUserId, '2026-10-01', 6000, 'photo');

  // День 2 (2026-10-02): 8 000 кроків (< 10 000) -> 2-й пільговий (2/2)
  await queries.saveDailySteps(testUserId, '2026-10-02', 8000, 'photo');

  // День 3 (2026-10-03): 5 000 кроків (< 10 000) -> 3-й пропуск -> Штраф 100 грн!
  await queries.saveDailySteps(testUserId, '2026-10-03', 5000, 'photo');

  // День 4 (2026-10-04): 12 000 кроків (>= 10 000) -> Норма виконана 🎯
  await queries.saveDailySteps(testUserId, '2026-10-04', 12000, 'photo');

  // День 5 (2026-10-05): 0 кроків (пропуск) -> 4-й пропуск -> Ще 100 грн штраф (разом 200 грн)!
  await queries.saveDailySteps(testUserId, '2026-10-05', 0, 'photo');

  // Оцінка за 5 днів
  const stats = await queries.getUserMonthStats(testUserId, yearMonth, '2026-10-05');
  assert.strictEqual(stats.graceDaysUsed, 2, 'Має бути використано 2 пільгових дні');
  assert.strictEqual(stats.penaltyDaysCount, 2, 'Має бути 2 штрафних дні (3-й та 4-й пропуск)');
  assert.strictEqual(stats.monthPenaltiesTotal, 200, 'Штраф має бути 200 грн');
  assert.strictEqual(stats.currentDebt, 200, 'Поточний борг має бути 200 грн');
  console.log('✅ 3. Пільгові дні (2/2) та штрафи (200 грн) розраховано вірно.');

  // 4. Оплата штрафу через банку (/paid)
  await queries.addPenaltyPayment(testUserId, 100, 111, 'Часткова оплата');
  const statsAfterPay = await queries.getUserMonthStats(testUserId, yearMonth, '2026-10-05');
  assert.strictEqual(statsAfterPay.totalPaid, 100, 'Сплачено 100 грн');
  assert.strictEqual(statsAfterPay.currentDebt, 100, 'Залишок боргу має бути 100 грн');

  const bankTotal = await queries.getAllPaymentsTotal();
  assert.ok(bankTotal >= 100, 'У штрафній банці має бути щонайменше 100 грн');
  console.log('✅ 4. Оплата штрафу зарахована, борг зменшився до 100 грн, банка оновилася.');

  // 5. Перевірка звітів
  const dailyReport = await formatDailyReport('2026-10-05');
  assert.ok(dailyReport.includes('Підсумки:'), 'Звіт має містити заголовок');
  assert.ok(dailyReport.includes('Штрафна банка:'), 'Звіт має містити блок Штрафна банка');
  assert.ok(dailyReport.includes('Поточні борги:'), 'Звіт має містити блок Поточні борги');

  const statusReport = await formatMonthlyStatusReport('2026-10');
  assert.ok(statusReport.includes('Статус челенджу за'), 'Статус має містити заголовок');
  assert.ok(statusReport.includes('Тестер Василь'), 'Статус має містити учасника');

  const bankReport = await formatBankReport();
  assert.ok(bankReport.includes('Штрафна банка челенджу'), 'Банка має містити заголовок');
  console.log('✅ 5. Звіти форматуються коректно.');

  console.log('\n🎉 ВСІ ТЕСТИ ПРОЙДЕНО УСПІШНО!');
}

runTests().catch(err => {
  console.error('❌ Помилка тесту:', err);
  process.exit(1);
});
