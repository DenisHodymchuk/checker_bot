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
const {
  getTodayDateString,
  getYesterdayDateString,
  resolveSubmissionDate,
  formatUkrainianDate,
  formatNumber,
  resolveTargetDate,
} = require('../utils/date');
const { userAwaitingManualInput, reactToMessage } = require('./photo');

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
        `• Результати за день приймаються <b>до 12:00 наступного дня</b>.\n` +
        `• На кожен зарахований скрін бот ставить реакцію 👍 та записує результат у базу і Google Таблицю.\n` +
        `• Адміністратор може налаштувати гілки чату командою <code>/set_topic</code> або <code>/set_group</code>.`,
        { parse_mode: 'HTML' }
      );
    }

    const keyboard = new InlineKeyboard()
      .text('📊 Моя статистика', 'btn_my_stats')
      .text('🏆 Звіт за вчора', 'btn_leaderboard')
      .row()
      .text('📋 Статус челенджу', 'btn_status')
      .text('🏦 Штрафна банка', 'btn_bank')
      .row()
      .text('ℹ️ Правила челенджу', 'btn_help');

    const welcomeText = 
      `👋 Привіт, <b>${escapeHtml(firstName)}</b>!\n\n` +
      `Я бот для корпоративного челенджу щоденних кроків 👟\n\n` +
      `<b>📌 Правила нашого челенджу:</b>\n` +
      `• 🎯 <b>Норма: 10 000 кроків на день</b>.\n` +
      `• 🕛 <b>Дедлайн: до 12:00 наступного дня</b> (наприклад, скрін за 8 число можна скинути до 12:00 9-го числа).\n` +
      `• 🛡️ <b>2 пільгових дні на місяць</b> — коли можна пройти менше норми або пропустити день без штрафу.\n` +
      `• 💸 <b>Починаючи з 3-го пропуску</b> — штраф <b>100 грн</b> у спільну штрафну банку.\n\n` +
      `<b>Розклад бота:</b>\n` +
      `• 👍 На кожен надісланий скрін бот ставить реакцію та автоматично заносить кроки в Google Таблицю.\n` +
      `• ⏰ <b>11:00</b> — нагадування і відмітка всіх, хто ще не скинув скрін за вчора.\n` +
      `• 🔒 <b>12:00</b> — фіксація пропусків та штрафів за вчора.\n` +
      `• 📊 <b>13:00</b> — публікація звіту за вчора у груповий чат.`;

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
      `• Скріни за день приймаються <b>до 12:00 наступного дня</b>.\n` +
      `• У кожного є <b>2 пільгових пропуски на місяць</b>, з 3-го пропуску — <b>штраф 100 грн</b>.\n` +
      `• Об <b>11:00</b> бот нагадує тим, хто не скинув скрін за вчора, о <b>12:00</b> фіксує пропуски/штрафи, о <b>13:00</b> надсилає звіт за вчора.\n\n` +
      `<b>Команди для всіх:</b>\n` +
      `• <b>Надіслати фото:</b> скиньте скріншот у гілку скрінів або в особисті боту — бот поставить 👍.\n` +
      `• <code>/steps [число] [дата]</code> — записати кроки вручну (напр. <code>/steps 10500</code> або <code>/steps 12000 08.11</code>).\n` +
      `• <code>/status</code> — статус команди за поточний місяць.\n` +
      `• <code>/bank</code> — стан штрафної банки та внески.\n` +
      `• <code>/my_stats</code> — ваша особиста статистика.\n` +
      `• <code>/top [день]</code> — рейтинг за день (за замовчуванням за вчора).\n\n` +
      `<b>Команди адміністратора:</b>\n` +
      `• <code>/set @user [число] [дата]</code> — встановити кроки учаснику.\n` +
      `• <code>/scan [дата]</code> — у відповідь (reply) на старий скрін у чаті, щоб бот його проаналізував.\n` +
      `• <code>/import</code> — двостороння звірка та синхронізація з Google Таблицею.\n` +
      `• <code>/paid @user [сума]</code> — зафіксувати оплату штрафу в банку.\n` +
      `• <code>/set_topic</code> — налаштувати гілки для скрінів та звітів.\n` +
      `• <code>/settings</code> — панель налаштувань бота.`;

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
    const targetDate = resolveTargetDate(parts[1], tz, true);
    const text = await formatDailyReport(targetDate);
    await ctx.reply(text, { parse_mode: 'HTML' });
  });

  // Ручний запис або доплюсовування кроків: /steps 12000 [дата] або /steps +3000
  bot.command('steps', async (ctx) => {
    const args = ctx.message.text.split(/\s+/).slice(1);
    if (args.length === 0) {
      return ctx.reply(
        '⚠️ <b>Вкажіть кількість кроків після команди:</b>\n\n' +
        '• <code>/steps 10500</code> — записати кроки\n' +
        '• <code>/steps +3000</code> — доплюсувати до вже наявних\n' +
        '• <code>/steps 10500 08.11</code> — записати за конкретну дату',
        { parse_mode: 'HTML' }
      );
    }

    const stepArg = args[0];
    const dateArg = args[1] || null;
    const isPlus = stepArg.startsWith('+');
    const cleaned = stepArg.replace(/\D/g, '');
    const steps = Number(cleaned);

    if (isNaN(steps) || steps <= 0 || steps > 150000) {
      return ctx.reply('⚠️ Введіть коректне число кроків від 1 до 150 000.');
    }

    const userId = ctx.from.id;
    const firstName = ctx.from.first_name || 'Колега';
    const tz = await queries.getSetting('timezone', 'Europe/Kyiv');
    const deadlineTime = await queries.getSetting('deadline_time', '12:00');
    const dailyGoal = Number(await queries.getSetting('daily_goal', '10000'));

    await queries.upsertUser(userId, firstName, ctx.from.username);

    const date = dateArg
      ? resolveTargetDate(dateArg, tz)
      : await resolveSubmissionDate({
          userId,
          messageDate: new Date(),
          timeZone: tz,
          deadlineTime,
          dailyGoal,
          getUserStepsForDate: queries.getUserStepsForDate,
        });

    if (isPlus) {
      await queries.addDailySteps(userId, date, steps, 'manual', 'Додано через /steps');
    } else {
      await queries.saveDailySteps(userId, date, steps, 'manual', 'Введено через /steps');
    }

    await reactToMessage(ctx, '👍');
  });

  // Обробка кнопок головного меню
  bot.callbackQuery('btn_my_stats', async (ctx) => {
    await ctx.answerCallbackQuery();
    const text = await formatUserStats(ctx.from.id);
    await ctx.reply(text, { parse_mode: 'HTML' });
  });

  bot.callbackQuery('btn_leaderboard', async (ctx) => {
    await ctx.answerCallbackQuery();
    const tz = await queries.getSetting('timezone', 'Europe/Kyiv');
    const yesterday = getYesterdayDateString(tz);
    const text = await formatDailyReport(yesterday);
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
      `1. Надішліть скріншот крокоміра у гілку для скрінів або сюди в приватні.\n` +
      `2. ШІ розпізнає кроки, поставить реакцію 👍 на фото та запише їх у базу і Google Таблицю.\n` +
      `3. Скріни за день (наприклад, за 8 число) приймаються <b>до 12:00 наступного дня</b> (9 числа).\n` +
      `4. Об 11:00 приходить нагадування тим, хто забув скинути скрін за вчора.\n` +
      `5. О 12:00 фіксуються пропуски та штрафи, а о 13:00 публікується звіт за вчора!`;
    await ctx.reply(helpText, { parse_mode: 'HTML' });
  });

  // Обробка текстових повідомлень (ручний ввід числа або доплюсовування)
  bot.on('message:text', async (ctx, next) => {
    const text = ctx.message.text.trim();
    const userId = ctx.from.id;

    // Перевіряємо, чи очікує бот введення числа від цього користувача
    if (userAwaitingManualInput.has(userId)) {
      const { targetUserId, date, targetName } = userAwaitingManualInput.get(userId);
      const isPlus = text.startsWith('+');
      const cleaned = text.replace(/\D/g, '');
      const steps = Number(cleaned);

      if (!isNaN(steps) && steps > 0 && steps <= 150000) {
        userAwaitingManualInput.delete(userId);
        const resolvedUserId = targetUserId || userId;

        if (isPlus) {
          await queries.addDailySteps(resolvedUserId, date, steps, 'manual', 'Додано вручну');
        } else {
          await queries.saveDailySteps(resolvedUserId, date, steps, 'manual', 'Введено вручну');
        }

        await reactToMessage(ctx, '👍');
        await ctx.reply(
          `✅ <b>Зараховано:</b> <b>${formatNumber(steps)}</b> кроків для <b>${escapeHtml(targetName || 'колеги')}</b> за <b>${escapeHtml(formatUkrainianDate(date))}</b> (записано в Google Таблицю)!`,
          { parse_mode: 'HTML', reply_parameters: { message_id: ctx.message.message_id } }
        );
        return;
      } else {
        return ctx.reply('⚠️ Будь ласка, введіть дійсне число кроків (наприклад, <code>10500</code> або <code>+3000</code>), або надішліть /start для скасування.', {
          parse_mode: 'HTML',
        });
      }
    }

    // Якщо це просто число (або "+3000") у приватному чаті, або у відповідь на повідомлення бота в гілці «скріни кроків»
    const { isAllowedStepsTopic } = require('../utils/topic');
    const isReplyToBot =
      !ctx.message.reply_to_message?.forum_topic_created &&
      ctx.message.reply_to_message?.from?.is_bot;
    const isDirectNumber = /^\+?\s*\d{3,6}$/.test(text);

    if ((ctx.chat.type === 'private' || (isReplyToBot && await isAllowedStepsTopic(ctx))) && isDirectNumber) {
      const isPlus = text.startsWith('+');
      const steps = Number(text.replace(/\D/g, ''));
      const tz = await queries.getSetting('timezone', 'Europe/Kyiv');
      const deadlineTime = await queries.getSetting('deadline_time', '12:00');
      const dailyGoal = Number(await queries.getSetting('daily_goal', '10000'));
      const firstName = ctx.from.first_name || 'Колега';

      await queries.upsertUser(userId, firstName, ctx.from.username);

      const date = await resolveSubmissionDate({
        userId,
        messageDate: new Date(),
        timeZone: tz,
        deadlineTime,
        dailyGoal,
        getUserStepsForDate: queries.getUserStepsForDate,
      });

      if (isPlus) {
        await queries.addDailySteps(userId, date, steps, 'manual', 'Додано текстом');
      } else {
        await queries.saveDailySteps(userId, date, steps, 'manual', 'Введено числом');
      }

      await reactToMessage(ctx, '👍');
      return;
    }

    return next();
  });
}

module.exports = {
  registerUserHandlers,
};
