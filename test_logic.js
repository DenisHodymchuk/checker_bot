const assert = require('node:assert');
const { initDatabase, sqliteDb } = require('./src/db/database');
const queries = require('./src/db/queries');
const { 
  formatDailyReport, 
  formatMonthlyStatusReport, 
  formatBankReport,
  formatStepSuccessMessage,
} = require('./src/services/leaderboard');

async function runTests() {
  console.log('🧪 Запуск повної перевірки бізнес-логіки...');

  // 1. Ініціалізація бази даних
  await initDatabase();
  console.log('✅ 1. База даних ініціалізована.');

  // 2. Створення тестових користувачів та пакетне додавання
  const testUserId = 900000 + Math.floor(Math.random() * 100000);
  const testUser2Id = testUserId + 1;
  const testIds = [testUserId, testUser2Id, testUserId + 2, testUserId + 3];

  try {
    await queries.upsertUser(testUserId, 'Денис', `denis_${testUserId}`);
  await queries.upsertUser(testUser2Id, 'Тестерка Марія', `maria_${testUser2Id}`);

  await queries.upsertUsersBatch([
    { id: testUserId + 2, first_name: 'Олег', username: `oleg_${testUserId}` },
    { id: testUserId + 3, first_name: 'Ірина', username: `iryna_${testUserId}` },
  ]);

  const user = await queries.getUser(testUserId);
  assert.strictEqual(user.first_name, 'Денис');
  assert.strictEqual(user.username, `denis_${testUserId}`);

  const foundByHandle = await queries.findUserByHandleOrId(`@denis_${testUserId}`);
  assert.strictEqual(foundByHandle.id, testUserId);
  console.log('✅ 2. Користувачів успішно створено та пакетно зареєстровано.');

  // 3. Тестування доплюсовування кроків (2 скріншоти або +N за день)
  const testDate = '2026-10-12';
  // Перший скріншот: 7 158 кроків
  await queries.saveDailySteps(testUserId, testDate, 7158, 'photo');
  let currentSteps = await queries.getUserStepsForDate(testUserId, testDate);
  assert.strictEqual(currentSteps.steps, 7158);

  // Другий скріншот у цей же день: +6 000 кроків -> Разом 13 158!
  const addResult = await queries.addDailySteps(testUserId, testDate, 6000, 'photo');
  assert.strictEqual(addResult.previousSteps, 7158);
  assert.strictEqual(addResult.addedSteps, 6000);
  assert.strictEqual(addResult.totalSteps, 13158);

  currentSteps = await queries.getUserStepsForDate(testUserId, testDate);
  assert.strictEqual(currentSteps.steps, 13158, 'Кроки мають доплюсуватися до 13 158');
  console.log('✅ 3. Доплюсовування кроків (7 158 + 6 000 = 13 158) працює коректно.');

  // 4. Перевірка нового форматування повідомлення (за зразком користувача)
  const { formatNumber } = require('./src/utils/date');
  const maleMsg = formatStepSuccessMessage({
    name: 'Денис',
    steps: 13158,
    dailyGoal: 10000,
  });

  assert.ok(maleMsg.includes('Зафіксував результат <b>Денис</b>'), 'Має містити Зафіксував результат');
  assert.ok(maleMsg.includes(`+${formatNumber(13158)}`), 'Має містити +13 158');
  assert.ok(maleMsg.includes('Ціль виконано на <b>132%</b>'), 'Має містити 132%');
  assert.ok(maleMsg.includes('Ти розірвав цей день, продовжуй в тому ж русі 💥'), 'Чоловіче ім\'я: має бути розірвав');

  // Жіноче ім'я (Марія) -> має бути "розірвала"
  const femaleMsg = formatStepSuccessMessage({
    name: 'Марія',
    steps: 13158,
    dailyGoal: 10000,
  });
  assert.ok(femaleMsg.includes('Ти розірвала цей день, продовжуй в тому ж русі 💥'), 'Жіноче ім\'я: має бути розірвала');

  // Повідомлення при доплюсовуванні кроків (+6 000 до 7 158)
  const combinedMsg = formatStepSuccessMessage({
    name: 'Денис',
    steps: 13158,
    dailyGoal: 10000,
    previousSteps: 7158,
    addedSteps: 6000,
  });
  assert.ok(combinedMsg.includes(`+${formatNumber(6000)}`), 'Має показувати додані кроки');
  assert.ok(combinedMsg.includes(`разом: ${formatNumber(13158)}`), 'Має показувати загальну суму');
  console.log('✅ 4. Новий формат з автовизначенням роду (розірвав / розірвала) протестовано.');

  // 5. Тестування бізнес-правил (10k кроків, 2 пільгових дні, 100 грн штраф, враховуючи дні без надісланого скріна)
  const yearMonth = '2026-10';
  await queries.saveDailySteps(testUserId, '2026-10-01', 6000, 'photo'); // 1-й пільговий
  await queries.saveDailySteps(testUserId, '2026-10-02', 8000, 'photo'); // 2-й пільговий
  await queries.saveDailySteps(testUserId, '2026-10-03', 5000, 'photo'); // 3-й пропуск -> Штраф 100 грн
  await queries.saveDailySteps(testUserId, '2026-10-04', 12000, 'photo'); // норма 🎯
  // За 2026-10-05 взагалі НЕ зберігаємо скріншот -> 4-й пропуск (не надіслано до звіту) -> Штраф +100 грн!

  const stats = await queries.getUserMonthStats(testUserId, yearMonth, '2026-10-05');
  assert.strictEqual(stats.graceDaysUsed, 2);
  assert.strictEqual(stats.penaltyDaysCount, 2);
  assert.strictEqual(stats.monthPenaltiesTotal, 200);
  assert.strictEqual(stats.currentDebt, 200);
  console.log('✅ 5. Пільгові дні (2/2) та штрафи (200 грн, у т.ч. за незданий скрін) розраховано вірно.');

  // 6. Оплата штрафу через банку (/paid) та перевірка посилання на Monobank
  await queries.addPenaltyPayment(testUserId, 100, 111, 'Часткова оплата');
  const statsAfterPay = await queries.getUserMonthStats(testUserId, yearMonth, '2026-10-05');
  assert.strictEqual(statsAfterPay.totalPaid, 100);
  assert.strictEqual(statsAfterPay.currentDebt, 100);

  const bankTotal = await queries.getAllPaymentsTotal();
  assert.ok(bankTotal >= 100);
  console.log('✅ 6. Оплата штрафу зарахована, борг зменшився.');

  // 7. Перевірка наявності посилання на банку Monobank у всіх звітах
  const jarUrlExpected = 'send.monobank.ua/jar/6fwMYmHxM1';

  const dailyReport = await formatDailyReport('2026-10-05');
  assert.ok(dailyReport.includes(jarUrlExpected), 'Щоденний звіт має містити посилання на Monobank банку');

  const statusReport = await formatMonthlyStatusReport('2026-10');
  assert.ok(statusReport.includes(jarUrlExpected), 'Статус за місяць має містити посилання на Monobank банку');

  const bankReport = await formatBankReport();
  assert.ok(bankReport.includes(jarUrlExpected), 'Звіт по банку має містити посилання на Monobank банку');
    console.log('✅ 7. Посилання на банку Monobank додано до всіх звітів.');

    // 8. Перевірка фільтрації гілки «скріни кроків»
    const { isAllowedStepsTopic } = require('./src/utils/topic');
    const prevGroup = await queries.getSetting('group_chat_id', '');
    const prevTopic = await queries.getSetting('steps_topic_id', '');
    try {
      await queries.setSetting('group_chat_id', '');
      await queries.setSetting('steps_topic_id', '');

      // Особисті повідомлення — дозволено
      assert.strictEqual(await isAllowedStepsTopic({ chat: { id: 123, type: 'private' } }), true);

      // Основний чат групи (General без теми) — заборонено
      assert.strictEqual(await isAllowedStepsTopic({
        chat: { id: -100123456, type: 'supergroup' },
        message: {},
      }), false);

      // Інша гілка в групі (наприклад, «Робочі питання») — заборонено
      assert.strictEqual(await isAllowedStepsTopic({
        chat: { id: -100123456, type: 'supergroup' },
        message: {
          message_thread_id: 555,
          reply_to_message: { forum_topic_created: { name: 'Робочі питання' } },
        },
      }), false);

      // Гілка «Скріни кроків» — дозволено + автозбереження ID
      assert.strictEqual(await isAllowedStepsTopic({
        chat: { id: -100123456, type: 'supergroup' },
        message: {
          message_thread_id: 777,
          reply_to_message: { forum_topic_created: { name: '👟 Скріни кроків' } },
        },
      }), true);
      assert.strictEqual(await queries.getSetting('steps_topic_id'), '777');

      // Відповідь (reply) всередині гілки «Скріни кроків» (де немає forum_topic_created, але є message_thread_id = 777) — дозволено
      assert.strictEqual(await isAllowedStepsTopic({
        chat: { id: -100123456, type: 'supergroup' },
        message: {
          message_thread_id: 777,
          reply_to_message: { text: 'Мій скрін' },
        },
      }), true);

      // Відповідь (reply) в іншій гілці (message_thread_id = 555) — заборонено
      assert.strictEqual(await isAllowedStepsTopic({
        chat: { id: -100123456, type: 'supergroup' },
        message: {
          message_thread_id: 555,
          reply_to_message: { text: 'Інший чат' },
        },
      }), false);

      console.log('✅ 8. Фільтрація фото лише в гілці «скріни кроків» та особистих чатах працює бездоганно.');
    } finally {
      await queries.setSetting('group_chat_id', prevGroup);
      await queries.setSetting('steps_topic_id', prevTopic);
    }

    console.log('\n🎉 ВСІ ТЕСТИ ПРОЙДЕНО УСПІШНО!');
  } finally {
    // Очищення тестових користувачів
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
