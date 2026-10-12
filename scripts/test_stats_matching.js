const { initDatabase, sqliteDb } = require('../src/db/database');
const queries = require('../src/db/queries');

async function test() {
  await initDatabase();

  const users = await queries.getAllActiveUsers();
  const yearMonth = '2026-10';
  const today = '2026-10-12';

  console.log('=== CURRENT STATUS FOR ALL USERS ===');
  for (const u of users) {
    const stats = await queries.getUserMonthStats(u.id, yearMonth, today);
    if (stats) {
      console.log(
        `${u.first_name} (@${u.username}): ` +
        `Пільгові: ${stats.graceDaysUsed}/${stats.graceLimit}, ` +
        `Штрафних: ${stats.penaltyDaysCount} (${stats.monthPenaltiesTotal} грн), ` +
        `Борг: ${stats.currentDebt} грн`
      );
    }
  }
}
test();
