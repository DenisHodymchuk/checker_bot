const http = require('node:http');
const { Bot } = require('grammy');
const { config, validateConfig } = require('./config');
const { initDatabase } = require('./db/database');
const queries = require('./db/queries');
const { registerPhotoHandlers } = require('./handlers/photo');
const { registerUserHandlers } = require('./handlers/user');
const { registerAdminHandlers } = require('./handlers/admin');
const { initScheduler } = require('./services/scheduler');
const { runImport, syncUserStepsToSheet } = require('./services/google_sheet');

async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🤖 Запуск Telegram Step Tracker Bot...');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Ініціалізація бази даних (Supabase або SQLite)
  await initDatabase();

  // Підключаємо автоматичну синхронізацію кожного нового запису кроків у Google Таблицю
  queries.setOnStepsSavedHook(syncUserStepsToSheet);

  // Автоматична звірка та синхронізація з Google Таблицею при запуску бота
  try {
    await runImport();
    console.log('✅ [Auto-Sync] Дані успішно звірено з Google Таблицею!');
  } catch (importErr) {
    console.warn('⚠️ [Auto-Sync] Не вдалося виконати звірку на старті:', importErr.message);
  }

  // Перевірка конфігурації
  const missingConfig = validateConfig();
  if (missingConfig.length > 0) {
    console.error('\n⚠️ УВАГА: Для запуску бота необхідно заповнити файл .env!');
    console.error('Відсутні або не налаштовані обов\'язкові змінні:');
    for (const key of missingConfig) {
      console.error(`  - ${key}`);
    }
    console.error('\nБудь ласка, відкрийте файл .env та вкажіть ваш BOT_TOKEN та GEMINI_API_KEY.');
    process.exit(1);
  }

  // Створення екземпляра бота grammY
  const bot = new Bot(config.botToken);

  // Реєстрація списку команд у меню Telegram
  try {
    await bot.api.setMyCommands([
      { command: 'start', description: 'Почати роботу / Головне меню' },
      { command: 'my_stats', description: 'Моя статистика та пільги' },
      { command: 'leaderboard', description: 'Звіт за день (/top [день])' },
      { command: 'month', description: 'Топ кроків за місяць (/top month)' },
      { command: 'status', description: 'Пільгові дні, кроки та штрафи команди' },
      { command: 'bank', description: 'Штрафна банка та борги' },
      { command: 'steps', description: 'Записати кроки вручну (/steps 10000)' },
      { command: 'scan', description: 'Просканувати скрін у відповідь на фото' },
      { command: 'report', description: 'Опублікувати звіт (/report [день])' },
      { command: 'import', description: 'Звірка та синхронізація з Google Таблицею' },
      { command: 'set', description: 'Встановити кроки колезі (адмін)' },
      { command: 'paid', description: 'Зафіксувати оплату штрафу (адмін)' },
      { command: 'set_topic', description: 'Призначити гілку для скрінів/звітів/штрафів (адмін)' },
      { command: 'set_sheet_url', description: 'Підключити автозапис у Google Таблицю (адмін)' },
      { command: 'settings', description: 'Панель налаштувань (адмін)' },
      { command: 'help', description: 'Правила та довідка' },
    ]);
    console.log('📋 Команди бота зареєстровані в меню Telegram.');
  } catch (err) {
    console.warn('Не вдалося встановити команди меню:', err.message);
  }

  // Глобальне middleware для автоматичної підтримки гілок (topics) та фіксації учасників
  const { isAllowedStepsTopic, trackGroupTopic } = require('./utils/topic');
  bot.use(async (ctx, next) => {
    trackGroupTopic(ctx).catch(() => {});

    const threadId = ctx.msg?.message_thread_id;
    if (threadId && ctx.chat) {
      const chatId = ctx.chat.id;
      ctx.api.config.use((prev, method, payload, signal) => {
        if (
          (method === 'sendMessage' || method === 'sendPhoto' || method === 'sendChatAction') &&
          payload.chat_id === chatId &&
          payload.message_thread_id === undefined
        ) {
          payload.message_thread_id = threadId;
        }
        return prev(method, payload, signal);
      });
    }

    if (ctx.from && !ctx.from.is_bot) {
      const allowed = await isAllowedStepsTopic(ctx);
      if (allowed) {
        queries.upsertUser(ctx.from.id, ctx.from.first_name, ctx.from.username).catch((err) => {
          console.warn('Помилка автореєстрації учасника:', err.message);
        });
      }
    }
    return next();
  });

  // Автоматична прив'язка нового групового чату та звірка з таблицею, коли бота додають у нову групу
  bot.on('my_chat_member', async (ctx) => {
    try {
      const chat = ctx.chat;
      const newStatus = ctx.myChatMember?.new_chat_member?.status;
      if (chat && chat.type !== 'private' && (newStatus === 'member' || newStatus === 'administrator')) {
        console.log(`[Group] Бота додано у групу "${chat.title}" (ID: ${chat.id}, статус: ${newStatus})`);
        await queries.setSetting('group_chat_id', String(chat.id));
        await queries.setSetting('steps_topic_id', '');
        await queries.setSetting('reports_topic_id', '');
        await queries.setSetting('penalties_topic_id', '');
        await queries.setSetting('reminders_topic_id', '');
        await queries.setSetting('known_topics', '{}');
        await runImport();
      }
    } catch (err) {
      console.warn('Помилка обробки додавання бота в групу:', err.message);
    }
  });

  // Автоматична реєстрація нових учасників при вході в групу
  bot.on(['chat_member', 'message:new_chat_members'], async (ctx) => {
    try {
      if (ctx.message?.new_chat_members) {
        for (const m of ctx.message.new_chat_members) {
          if (!m.is_bot) {
            await queries.upsertUser(m.id, m.first_name, m.username);
          }
        }
      }
      if (ctx.chatMember?.new_chat_member?.user) {
        const u = ctx.chatMember.new_chat_member.user;
        if (!u.is_bot) {
          await queries.upsertUser(u.id, u.first_name, u.username);
        }
      }
    } catch (err) {
      console.warn('Помилка реєстрації нового учасника чату:', err.message);
    }
  });

  // Обробники подій
  registerPhotoHandlers(bot);
  registerUserHandlers(bot);
  registerAdminHandlers(bot, {
    reloadJobs: () => initScheduler(bot),
  });

  // Запуск планувальника щоденних завдань (11:00 нагадування, 12:00 дедлайн, 13:00 звіт)
  await initScheduler(bot);
  console.log('⏰ Планувальник (11:00 нагадування, 12:00 дедлайн, 13:00 звіт) запущено.');

  // Запуск опціонального HTTP сервера для Render / Railway health check (якщо вказано PORT)
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
      console.log(`🌐 Health check HTTP сервер запущено на порту ${config.port}`);
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
