const assert = require('node:assert');
const { initDatabase, sqliteDb } = require('./src/db/database');
const queries = require('./src/db/queries');
const { 
  formatDailyReport, 
  formatMonthlyStatusReport, 
  formatBankReport,
  formatGroupReminderMessage,
  formatStepSuccessMessage,
} = require('./src/services/leaderboard');
const {
  resolveSubmissionDate,
  formatNumber,
} = require('./src/utils/date');
const {
  getDayColumnNumber1Based,
  colNumberToLetter,
  runImport,
} = require('./src/services/google_sheet');

async function runTests() {
  console.log('🧪 Запуск повної перевірки оновленої бізнес-логіки...');

  // 1. Ініціалізація бази даних та перевірка розкладу (11:00, 12:00, 13:00)
  await initDatabase();
  assert.strictEqual(await queries.getSetting('reminder_time'), '11:00');
  assert.strictEqual(await queries.getSetting('deadline_time'), '12:00');
  assert.strictEqual(await queries.getSetting('report_time'), '13:00');
  console.log('✅ 1. База даних ініціалізована, розклад (11:00 / 12:00 / 13:00) налаштовано.');

  // 2. Перевірка синхронізації з новою Google Таблицею («Листопад кроки»)
  const importRes = await runImport({ yearMonth: '2026-11' });
  const activeUsers = await queries.getAllActiveUsers();
  assert.strictEqual(activeUsers.length, 19, 'Має бути рівно 19 учасників з таблиці Листопада');
  // Перевіряємо, що Аня Андрон (без @username у таблиці) теж імпортована
  const anya = await queries.findUserByHandleOrId('Аня Андрон');
  assert.ok(anya, 'Аня Андрон (без @username у колонці C) має бути імпортована');
  const anyaDay1 = await queries.getUserStepsForDate(anya.id, '2026-11-01');
  assert.strictEqual(anyaDay1.steps, 13250);

  // Перевіряємо формулу колонок Google Таблиці (блоки по 5 днів + 1 колонка суми)
  assert.strictEqual(colNumberToLetter(getDayColumnNumber1Based(1)), 'E');
  assert.strictEqual(colNumberToLetter(getDayColumnNumber1Based(5)), 'I');
  assert.strictEqual(colNumberToLetter(getDayColumnNumber1Based(6)), 'K');
  assert.strictEqual(colNumberToLetter(getDayColumnNumber1Based(8)), 'M');
  assert.strictEqual(colNumberToLetter(getDayColumnNumber1Based(30)), 'AM');
  console.log(`✅ 2. Google Таблиця (Листопад, ${activeUsers.length} учасників, включно з Аня Андрон) синхронізована.`);

  // 3. Створення тестових користувачів та перевірка дедлайну 12:00 наступного дня
  const testUserId = 900000 + Math.floor(Math.random() * 100000);
  const testUser2Id = testUserId + 1;
  const testIds = [testUserId, testUser2Id];

  try {
    await queries.upsertUser(testUserId, 'Денис Тест', `denis_${testUserId}`);
    await queries.upsertUser(testUser2Id, 'Марія Тест', `maria_${testUser2Id}`);

    // Якщо скрін надіслано 9 листопада о 10:30 ранку (до 12:00), а за 8 листопада кроків ще немає -> зараховується за 8 листопада!
    const morningNov9 = new Date('2026-11-09T10:30:00+02:00');
    const resolvedMorning = await resolveSubmissionDate({
      userId: testUserId,
      messageDate: morningNov9,
      timeZone: 'Europe/Kyiv',
      deadlineTime: '12:00',
      dailyGoal: 10000,
      getUserStepsForDate: queries.getUserStepsForDate,
    });
    assert.strictEqual(resolvedMorning, '2026-11-08', 'Скрін до 12:00 9-го числа має зараховуватися за 8-ме число');

    // Якщо скрін надіслано 9 листопада о 12:15 (після 12:00) -> зараховується вже за 9 листопада!
    const afternoonNov9 = new Date('2026-11-09T12:15:00+02:00');
    const resolvedAfternoon = await resolveSubmissionDate({
      userId: testUserId,
      messageDate: afternoonNov9,
      timeZone: 'Europe/Kyiv',
      deadlineTime: '12:00',
      dailyGoal: 10000,
      getUserStepsForDate: queries.getUserStepsForDate,
    });
    assert.strictEqual(resolvedAfternoon, '2026-11-09', 'Скрін після 12:00 9-го числа має зараховуватися за 9-те число');
    console.log('✅ 3. Логіка прийому результатів за 8 число до 12:00 9-го числа працює бездоганно.');

    // 4. Тестування доплюсовування кроків (2 скріншоти за день)
    const testDate = '2026-10-12';
    await queries.saveDailySteps(testUserId, testDate, 7158, 'photo');
    const addResult = await queries.addDailySteps(testUserId, testDate, 6000, 'photo');
    assert.strictEqual(addResult.totalSteps, 13158);
    console.log('✅ 4. Доплюсовування кроків (7 158 + 6 000 = 13 158) працює коректно.');

    // 5. Тестування пропусків та штрафів (2 пільгових дні, з 3-го — 100 грн штраф)
    const yearMonth = '2026-10';
    await queries.saveDailySteps(testUserId, '2026-10-01', 6000, 'photo'); // 1-й пропуск (пільга 1/2)
    await queries.saveDailySteps(testUserId, '2026-10-02', 8000, 'photo'); // 2-й пропуск (пільга 2/2)
    await queries.saveDailySteps(testUserId, '2026-10-03', 5000, 'photo'); // 3-й пропуск -> Штраф 100 грн
    await queries.saveDailySteps(testUserId, '2026-10-04', 12000, 'photo'); // норма 🎯
    // За 2026-10-05 скрін не скинуто -> 4-й пропуск -> Штраф +100 грн!

    const stats = await queries.getUserMonthStats(testUserId, yearMonth, '2026-10-05', { forceCloseDate: '2026-10-05' });
    assert.strictEqual(stats.missedDays, 4);
    assert.strictEqual(stats.graceDaysUsed, 2);
    assert.strictEqual(stats.penaltyDaysCount, 2);
    assert.strictEqual(stats.monthPenaltiesTotal, 200);
    console.log('✅ 5. Пільгові дні (2/2) та штрафи (200 грн, формат 4/2 для таблиці) розраховано вірно.');

    // 6. Перевірка тексту нагадування об 11:00 (з попередженням про штрафи через годину о 12:00)
    const reminderMsg = await formatGroupReminderMessage(
      [{ user_id: testUserId, first_name: 'Денис Тест', username: `denis_${testUserId}` }],
      '2026-10-06'
    );
    assert.ok(reminderMsg.includes('12:00'), 'Нагадування об 11:00 має попереджати про дедлайн о 12:00');
    assert.ok(reminderMsg.includes(`@denis_${testUserId}`), 'Нагадування має тегати користувача');
    assert.ok(reminderMsg.includes('У зоні штрафу'), 'Користувач із >=2 пропусками має бути виділений у зоні штрафу');
    console.log('✅ 6. Повідомлення нагадування об 11:00 з попередженням про штрафи о 12:00 сформовано вірно.');

    // 7. Перевірка звіту о 13:00 за вчора
    const dailyReport = await formatDailyReport('2026-10-05', { forceCloseDate: '2026-10-05' });
    assert.ok(dailyReport.includes('Хто скільки пройшов:'), 'Звіт має містити блок Хто скільки пройшов');
    assert.ok(dailyReport.includes('Не виконали норму / Не скинули скрін:'), 'Звіт має містити блок хто не пройшов');
    assert.ok(dailyReport.includes('Штрафи за'), 'Звіт має містити блок штрафів');
    console.log('✅ 7. Звіт о 13:00 за вчора містить інформацію хто скільки пройшов, хто не пройшов і штрафи.');

    // 8. Перевірка фільтрації гілки «скріни кроків»
    const { isAllowedStepsTopic } = require('./src/utils/topic');
    const prevGroup = await queries.getSetting('group_chat_id', '');
    const prevTopic = await queries.getSetting('steps_topic_id', '');
    try {
      await queries.setSetting('group_chat_id', '');
      await queries.setSetting('steps_topic_id', '');

      assert.strictEqual(await isAllowedStepsTopic({ chat: { id: 123, type: 'private' } }), true);
      assert.strictEqual(await isAllowedStepsTopic({
        chat: { id: -100123456, type: 'supergroup' },
        message: {},
      }), false);
      assert.strictEqual(await isAllowedStepsTopic({
        chat: { id: -100123456, type: 'supergroup' },
        message: {
          message_thread_id: 777,
          reply_to_message: { forum_topic_created: { name: '👟 Скріни кроків' } },
        },
      }), true);
      console.log('✅ 8. Фільтрація гілки для скрінів працює коректно.');
    } finally {
      await queries.setSetting('group_chat_id', prevGroup);
      await queries.setSetting('steps_topic_id', prevTopic);
    }

    console.log('\n🎉 ВСІ ТЕСТИ ПРОЙДЕНО УСПІШНО!');
  } finally {
    const { isSupabase, supabase } = require('./src/db/database');
    if (isSupabase) {
      await supabase.from('penalty_payments').delete().in('user_id', testIds);
      await supabase.from('daily_steps').delete().in('user_id', testIds);
      await supabase.from('users').delete().in('id', testIds);
    } else if (sqliteDb) {
      for (const tid of testIds) {
        sqliteDb.prepare('DELETE FROM penalty_payments WHERE user_id = ?').run(tid);
        sqliteDb.prepare('DELETE FROM daily_steps WHERE user_id = ?').run(tid);
        sqliteDb.prepare('DELETE FROM users WHERE id = ?').run(tid);
      }
    }
  }
}

runTests().catch(err => {
  console.error('❌ Помилка тесту:', err);
  process.exit(1);
});
