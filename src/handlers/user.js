const { InlineKeyboard } = require('grammy');
const queries = require('../db/queries');
const { 
  formatUserStats, 
  formatDailyReport, 
  formatMonthlyStatusReport, 
  formatMonthlyLeaderboard,
  formatBankReport, 
  formatStepSuccessMessage,
  escapeHtml 
} = require('../services/leaderboard');
const { getTodayDateString, formatUkrainianDate, formatNumber, resolveTargetDate } = require('../utils/date');
const { userAwaitingManualInput } = require('./photo');

function registerUserHandlers(bot) {
  // Команда /start
  bot.command('start', async (ctx) => {
    const userId = ctx.from.id;
    const firstName = ctx.from.first_name || 'Колего';
    const username = ctx.from.username || null;

    await queries.upsertUser(userId, firstName, username);

    const isGroup = ctx.chat.type !== 'private';
    if (isGroup) {
      return ctx.reply(
        `👋 Привіт, ${escapeHtml(firstName)}! Я бот для обліку щоденних кроків.\n\n` +
        `• Норма: <b>10 000 кроків</b> на день.\n` +
        `• Щоб надсилати скріншоти кроків, перейдіть зі мною в <a href="https://t.me/${ctx.me.username}?start=join">особисті повідомлення</a>.\n` +
        `• Адміністратор може налаштувати цей чат для щоденних звітів командою /set_group.`,
        { parse_mode: 'HTML' }
      );
    }

    const keyboard = new InlineKeyboard()
      .text('📊 Моя статистика', 'btn_my_stats')
      .text('🏆 Рейтинг дня', 'btn_leaderboard')
      .row()
      .text('📋 Статус челенджу', 'btn_status')
      .text('🏦 Штрафна банка', 'btn_bank')
      .row()
      .text('ℹ️ Правила челенджу', 'btn_help');

    const welcomeText = 
      `👋 Привіт, <b>${escapeHtml(firstName)}</b>!\n\n` +
      `Я бот для корпоративного челенджу щоденних кроків 👟\n\n` +
      `<b>📌 Правила нашого челенджу:</b>\n` +
      `• 🎯 <b>Норма: 10 000 кроків на день</b> (можна більше, менше — ні).\n` +
      `• 🛡️ <b>2 пільгових дні на місяць</b> — коли можна пройти менше норми або пропустити день без штрафу.\n` +
      `• 💸 <b>З 3-го невиконаного дня</b> — штраф <b>100 грн</b> за кожен такий день у спільну штрафну банку.\n` +
      `• 🔄 Щомісяця лічильники пільгових днів обнуляються.\n\n` +
      `<b>Як здавати звіт:</b>\n` +
      `1️⃣ Надішліть сюди <b>скріншот екрану</b> з будь-якого додатку (Apple Health, Garmin, Mi Fitness тощо) — ШІ розпізнає кроки автоматично.\n` +
      `2️⃣ Або введіть вручну число: <code>/steps 10500</code> (або просто <code>10500</code> у чат).\n` +
      `3️⃣ Щовечора о 22:00 бот надсилає турнірну таблицю та оновлення банку в робочий чат 🏆`;

    await ctx.reply(welcomeText, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  });

  // Команда /help
  bot.command('help', async (ctx) => {
    const helpText = 
      `ℹ️ <b>Правила та команди бота:</b>\n\n` +
      `<b>Правила:</b>\n` +
      `• Норма: <b>10 000 кроків щодня</b>.\n` +
      `• У кожного є <b>2 пільгових дні на місяць</b>.\n` +
      `• Починаючи з 3-го пропуску або дня менше 10к — <b>штраф 100 грн</b> у банку.\n\n` +
      `<b>Команди для всіх:</b>\n` +
      `• <b>Надіслати фото:</b> надішліть скріншот крокоміра в приватні повідомлення.\n` +
      `• <code>/steps [число]</code> — записати кроки за сьогодні (наприклад: <code>/steps 10500</code>).\n` +
      `• <code>/status</code> — статус команди за поточний місяць (використані пільги, штрафи, борги).\n` +
      `• <code>/bank</code> — стан штрафної банки та внески.\n` +
      `• <code>/my_stats</code> — ваша особиста статистика, пільги та історія.\n` +
      `• <code>/leaderboard</code> — сьогоднішній рейтинг команди.\n\n` +
      `<b>Команди адміністратора:</b>\n` +
      `• <code>/set @user [число] [дата]</code> — встановити/виправити кроки учаснику.\n` +
      `• <code>/paid @user [сума]</code> — зафіксувати оплату штрафу в банку.\n` +
      `• <code>/set_group</code> — підключити робочу групу для щоденних звітів.\n` +
      `• <code>/settings</code> — панель налаштувань бота.\n` +
      `• <code>/report</code> — опублікувати щоденний звіт прямо зараз.`;

    await ctx.reply(helpText, { parse_mode: 'HTML' });
  });

  // Команда /status
  bot.command('status', async (ctx) => {
    const text = await formatMonthlyStatusReport();
    await ctx.reply(text, { parse_mode: 'HTML' });
  });

  // Команда /my_stats
  bot.command('my_stats', async (ctx) => {
    const text = await formatUserStats(ctx.from.id);
    await ctx.reply(text, { parse_mode: 'HTML' });
  });

  // Команда /leaderboard або /top (підтримує день або дату, або /top month)
  bot.command(['leaderboard', 'top', 'month', 'top_month'], async (ctx) => {
    const rawText = ctx.message.text.trim();
    const parts = rawText.split(/\s+/);
    const cmd = parts[0].replace('/', '').toLowerCase();
    const arg = (parts[1] || '').toLowerCase();

    if (cmd === 'month' || cmd === 'top_month' || arg === 'month' || arg === 'місяць') {
      const text = await formatMonthlyLeaderboard();
      return ctx.reply(text, { parse_mode: 'HTML' });
    }

    const tz = await queries.getSetting('timezone', 'Europe/Kyiv');
    const targetDate = resolveTargetDate(parts[1], tz);
    const text = await formatDailyReport(targetDate);
    await ctx.reply(text, { parse_mode: 'HTML' });
  });

  // Ручний запис або доплюсовування кроків: /steps 12000 або /steps +3000
  bot.command('steps', async (ctx) => {
    const rawArgs = ctx.message.text.split(/\s+/).slice(1).join(' ').trim();
    if (!rawArgs) {
      return ctx.reply(
        '⚠️ <b>Вкажіть кількість кроків після команди:</b>\n\n' +
        '• <code>/steps 10500</code> — встановити точну кількість кроків\n' +
        '• <code>/steps +3000</code> — доплюсувати до вже наявних за сьогодні',
        { parse_mode: 'HTML' }
      );
    }

    const isPlus = rawArgs.startsWith('+');
    const cleaned = rawArgs.replace(/\D/g, '');
    const steps = Number(cleaned);

    if (isNaN(steps) || steps <= 0 || steps > 150000) {
      return ctx.reply('⚠️ Введіть коректне число кроків від 1 до 150 000.');
    }

    const userId = ctx.from.id;
    const firstName = ctx.from.first_name || 'Колега';
    const tz = await queries.getSetting('timezone', 'Europe/Kyiv');
    const date = getTodayDateString(tz);
    const dailyGoal = Number(await queries.getSetting('daily_goal', '10000'));

    await queries.upsertUser(userId, firstName, ctx.from.username);

    let replyText = '';

    if (isPlus) {
      const res = await queries.addDailySteps(userId, date, steps, 'manual', 'Додано через /steps');
      replyText = formatStepSuccessMessage({
        name: firstName,
        steps: res.totalSteps,
        dailyGoal,
        previousSteps: res.previousSteps,
        addedSteps: res.addedSteps,
      });
    } else {
      await queries.saveDailySteps(userId, date, steps, 'manual', 'Введено через /steps');
      replyText = formatStepSuccessMessage({
        name: firstName,
        steps,
        dailyGoal,
      });
    }

    const isGroup = ctx.chat.type !== 'private';
    return ctx.reply(replyText, {
      parse_mode: 'HTML',
      reply_parameters: isGroup ? { message_id: ctx.message.message_id } : undefined,
    });
  });

  // Обробка кнопок головного меню
  bot.callbackQuery('btn_my_stats', async (ctx) => {
    await ctx.answerCallbackQuery();
    const text = await formatUserStats(ctx.from.id);
    await ctx.reply(text, { parse_mode: 'HTML' });
  });

  bot.callbackQuery('btn_leaderboard', async (ctx) => {
    await ctx.answerCallbackQuery();
    const text = await formatDailyReport();
    await ctx.reply(text, { parse_mode: 'HTML' });
  });

  bot.callbackQuery('btn_status', async (ctx) => {
    await ctx.answerCallbackQuery();
    const text = await formatMonthlyStatusReport();
    await ctx.reply(text, { parse_mode: 'HTML' });
  });

  bot.callbackQuery('btn_bank', async (ctx) => {
    await ctx.answerCallbackQuery();
    const text = await formatBankReport();
    await ctx.reply(text, { parse_mode: 'HTML' });
  });

  bot.callbackQuery('btn_help', async (ctx) => {
    await ctx.answerCallbackQuery();
    const helpText = 
      `👟 <b>Як це працює:</b>\n\n` +
      `1. Зробіть скріншот екрану у вашому фітнес-додатку в кінці дня.\n` +
      `2. Надішліть його сюди або в робочу групу як фото.\n` +
      `3. ШІ автоматично розпізнає число кроків та миттєво зарахує їх 🎯\n` +
      `4. Якщо скинули 2 скріни — бот автоматично додасть результати разом!\n` +
      `5. Якщо не маєте фото — напишіть <code>/steps 10500</code> або <code>/steps +3000</code>.\n\n` +
      `Норма — 10 000 кроків. Не забувайте здавати звіт до 22:00 щовечора!`;
    await ctx.reply(helpText, { parse_mode: 'HTML' });
  });

  // Обробка текстових повідомлень (ручний ввід числа або доплюсовування)
  bot.on('message:text', async (ctx, next) => {
    const text = ctx.message.text.trim();
    const userId = ctx.from.id;

    // Перевіряємо, чи очікує бот введення числа від цього користувача
    if (userAwaitingManualInput.has(userId)) {
      const { date } = userAwaitingManualInput.get(userId);
      const isPlus = text.startsWith('+');
      const cleaned = text.replace(/\D/g, '');
      const steps = Number(cleaned);

      if (!isNaN(steps) && steps > 0 && steps <= 150000) {
        userAwaitingManualInput.delete(userId);
        const dailyGoal = Number(await queries.getSetting('daily_goal', '10000'));
        const firstName = ctx.from.first_name || 'Колега';

        let replyText = '';
        if (isPlus) {
          const res = await queries.addDailySteps(userId, date, steps, 'manual', 'Додано вручну');
          replyText = formatStepSuccessMessage({
            name: firstName,
            steps: res.totalSteps,
            dailyGoal,
            previousSteps: res.previousSteps,
            addedSteps: res.addedSteps,
          });
        } else {
          await queries.saveDailySteps(userId, date, steps, 'manual', 'Введено вручну');
          replyText = formatStepSuccessMessage({
            name: firstName,
            steps,
            dailyGoal,
          });
        }

        return ctx.reply(replyText, { parse_mode: 'HTML' });
      } else {
        return ctx.reply('⚠️ Будь ласка, введіть дійсне число кроків (наприклад, <code>10500</code> або <code>+3000</code>), або надішліть /start для скасування.', {
          parse_mode: 'HTML',
        });
      }
    }

    // Якщо це просто число (або "+3000") у приватному чаті, або у відповідь на повідомлення бота в групі
    const isReplyToBot = ctx.message.reply_to_message?.from?.is_bot;
    const isDirectNumber = /^\+?\s*\d{3,6}$/.test(text);

    if ((ctx.chat.type === 'private' || isReplyToBot) && isDirectNumber) {
      const isPlus = text.startsWith('+');
      const steps = Number(text.replace(/\D/g, ''));
      const tz = await queries.getSetting('timezone', 'Europe/Kyiv');
      const date = getTodayDateString(tz);
      const firstName = ctx.from.first_name || 'Колега';
      const dailyGoal = Number(await queries.getSetting('daily_goal', '10000'));

      await queries.upsertUser(userId, firstName, ctx.from.username);

      let replyText = '';

      if (isPlus) {
        const res = await queries.addDailySteps(userId, date, steps, 'manual', 'Додано текстом');
        replyText = formatStepSuccessMessage({
          name: firstName,
          steps: res.totalSteps,
          dailyGoal,
          previousSteps: res.previousSteps,
          addedSteps: res.addedSteps,
        });
      } else {
        await queries.saveDailySteps(userId, date, steps, 'manual', 'Введено числом');
        replyText = formatStepSuccessMessage({
          name: firstName,
          steps,
          dailyGoal,
        });
      }

      return ctx.reply(replyText, {
        parse_mode: 'HTML',
        reply_parameters: { message_id: ctx.message.message_id },
      });
    }

    return next();
  });
}

module.exports = {
  registerUserHandlers,
};
