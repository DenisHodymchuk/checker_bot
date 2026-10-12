const http = require('node:http');
const { Bot } = require('grammy');
const { config, validateConfig } = require('./config');
const { initDatabase } = require('./db/database');
const { registerPhotoHandlers } = require('./handlers/photo');
const { registerUserHandlers } = require('./handlers/user');
const { registerAdminHandlers } = require('./handlers/admin');
const { initScheduler } = require('./services/scheduler');

async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🤖 Запуск Telegram Step Tracker Bot...');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Ініціалізація бази даних (Supabase або SQLite)
  await initDatabase();

  // Перевірка конфігурації
  const missingConfig = validateConfig();
  if (missingConfig.length > 0) {
    console.error('\n⚠️ УВАГА: Для запуску бота необхідно заповнити файл .env!');
    console.error('Відсутні або не налаштовані обов\'язкові змінні:');
    for (const key of missingConfig) {
      console.error(`  - ${key}`);
    }
    console.error('\nБудь ласка, відкрийте файл .env та вкажіть ваш BOT_TOKEN та GEMINI_API_KEY.');
    console.error('Детальні інструкції дивіться у файлі README.md.\n');
    process.exit(1);
  }

  // Створення екземпляра бота grammY
  const bot = new Bot(config.botToken);

  // Реєстрація списку команд у меню Telegram
  try {
    await bot.api.setMyCommands([
      { command: 'start', description: 'Почати роботу / Головне меню' },
      { command: 'my_stats', description: 'Моя статистика та пільги' },
      { command: 'leaderboard', description: 'Поточний рейтинг кроків' },
      { command: 'status', description: 'Пільгові дні та штрафи команди' },
      { command: 'bank', description: 'Штрафна банка та борги' },
      { command: 'steps', description: 'Записати кроки вручну (/steps 10000)' },
      { command: 'set', description: 'Встановити кроки колезі (адмін)' },
      { command: 'paid', description: 'Зафіксувати оплату штрафу (адмін)' },
      { command: 'settings', description: 'Панель налаштувань (адмін)' },
      { command: 'help', description: 'Правила та довідка' },
    ]);
    console.log('📋 Команди бота зареєстровані в меню Telegram.');
  } catch (err) {
    console.warn('Не вдалося встановити команди меню:', err.message);
  }

  // Обробники подій
  registerPhotoHandlers(bot);
  registerUserHandlers(bot);
  registerAdminHandlers(bot, {
    reloadJobs: () => initScheduler(bot),
  });

  // Запуск планувальника щоденних завдань
  await initScheduler(bot);
  console.log('⏰ Планувальник щоденних звітів та нагадувань запущено.');

  // Запуск опціонального HTTP сервера для Railway health check (якщо вказано PORT)
  if (config.port) {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        status: 'ok', 
        bot: 'Telegram Step Tracker Bot',
        uptime: process.uptime(),
      }));
    });
    server.listen(config.port, '0.0.0.0', () => {
      console.log(`🌐 Health check HTTP сервер запущено на порту ${config.port} (Railway)`);
    });
  }

  // Глобальний вилов помилок
  bot.catch((err) => {
    const ctx = err.ctx;
    console.error(`[Bot Error] Помилка під час обробки оновлення ${ctx?.update?.update_id}:`, err.error);
  });

  // Запуск бота
  console.log('🚀 Бот успішно запущений і очікує повідомлень!');
  bot.start({
    onStart: (botInfo) => {
      console.log(`✅ Підключено як @${botInfo.username} (${botInfo.first_name})`);
    },
  });

  // Коректне завершення роботи
  const stopHandler = () => {
    console.log('\nЗупинка бота...');
    bot.stop();
    process.exit(0);
  };
  process.once('SIGINT', stopHandler);
  process.once('SIGTERM', stopHandler);
}

main().catch((err) => {
  console.error('Критична помилка запуску:', err);
  process.exit(1);
});
