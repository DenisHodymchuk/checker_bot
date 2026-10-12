const { InlineKeyboard } = require('grammy');
const queries = require('../db/queries');
const { 
  formatUserStats, 
  formatDailyReport, 
  formatMonthlyStatusReport, 
  formatBankReport, 
  escapeHtml 
} = require('../services/leaderboard');
const { getTodayDateString, formatUkrainianDate, formatNumber } = require('../utils/date');
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

  // Команда /leaderboard або /top
  bot.command(['leaderboard', 'top'], async (ctx) => {
    const text = await formatDailyReport();
    await ctx.reply(text, { parse_mode: 'HTML' });
  });

  // Ручний запис кроків: /steps 12000
  bot.command('steps', async (ctx) => {
    const args = ctx.message.text.split(/\s+/).slice(1);
    if (args.length === 0) {
      return ctx.reply('⚠️ Вкажіть кількість кроків після команди, наприклад:\n<code>/steps 10500</code>', {
        parse_mode: 'HTML',
      });
    }

    const cleaned = args[0].replace(/\D/g, '');
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
    await queries.saveDailySteps(userId, date, steps, 'manual', 'Введено вручну');

    const isGroup = ctx.chat.type !== 'private';
    const percent = Math.round((steps / dailyGoal) * 100);
    const targetReached = steps >= dailyGoal ? ' 🎯' : '';
    const name = firstName ? escapeHtml(firstName) : (ctx.from.username ? '@' + escapeHtml(ctx.from.username) : 'Колега');

    if (isGroup) {
      return ctx.reply(
        `👟 <b>${name}</b> — <b>${formatNumber(steps)}</b> (${percent}%)${targetReached} зараховано!`,
        {
          parse_mode: 'HTML',
          reply_parameters: { message_id: ctx.message.message_id },
        }
      );
    }

    let msg = `✅ <b>Збережено вручну:</b> <b>${formatNumber(steps)}</b> кроків за ${escapeHtml(formatUkrainianDate(date))}.\n`;
    if (steps >= dailyGoal) {
      msg += `🎉 Щоденну норму (${formatNumber(dailyGoal)} кр.) виконано! 🎯`;
    } else {
      const remaining = dailyGoal - steps;
      msg += `До щоденної норми залишилось ще <b>${formatNumber(remaining)}</b> кроків 💪`;
    }

    await ctx.reply(msg, { parse_mode: 'HTML' });
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
      `2. Надішліть його сюди як фото.\n` +
      `3. ШІ автоматично розпізнає число кроків, а ви просто натиснете «✅ Зберегти».\n` +
      `4. Якщо не маєте фото — напишіть <code>/steps 10500</code>.\n\n` +
      `Норма — 10 000 кроків. Не забувайте здавати звіт до 22:00 щовечора!`;
    await ctx.reply(helpText, { parse_mode: 'HTML' });
  });

  // Обробка текстових повідомлень (ручний ввід числа)
  bot.on('message:text', async (ctx, next) => {
    const text = ctx.message.text.trim();
    const userId = ctx.from.id;

    // Перевіряємо, чи очікує бот введення числа від цього користувача
    if (userAwaitingManualInput.has(userId)) {
      const { date } = userAwaitingManualInput.get(userId);
      const cleaned = text.replace(/\D/g, '');
      const steps = Number(cleaned);

      if (!isNaN(steps) && steps > 0 && steps <= 150000) {
        userAwaitingManualInput.delete(userId);
        await queries.saveDailySteps(userId, date, steps, 'manual', 'Введено вручну');
        const dailyGoal = Number(await queries.getSetting('daily_goal', '10000'));

        let replyMsg = `✅ <b>Збережено!</b> <b>${formatNumber(steps)}</b> кроків за ${escapeHtml(formatUkrainianDate(date))}.\n`;
        if (steps >= dailyGoal) {
          replyMsg += `🎉 Щоденну норму (${formatNumber(dailyGoal)} кр.) виконано! 🎯`;
        } else {
          const remaining = dailyGoal - steps;
          replyMsg += `До норми залишилось: <b>${formatNumber(remaining)}</b> кр. 💪`;
        }

        return ctx.reply(replyMsg, { parse_mode: 'HTML' });
      } else {
        return ctx.reply('⚠️ Будь ласка, введіть дійсне число кроків (наприклад, <code>10500</code>), або надішліть /start для скасування.', {
          parse_mode: 'HTML',
        });
      }
    }

    // Якщо це просто число в приватному чаті (наприклад, "12500")
    if (ctx.chat.type === 'private' && /^\d{3,6}$/.test(text)) {
      const steps = Number(text);
      const tz = await queries.getSetting('timezone', 'Europe/Kyiv');
      const date = getTodayDateString(tz);
      const firstName = ctx.from.first_name || 'Колега';
      const dailyGoal = Number(await queries.getSetting('daily_goal', '10000'));

      await queries.upsertUser(userId, firstName, ctx.from.username);
      await queries.saveDailySteps(userId, date, steps, 'manual', 'Введено числом');

      let reply = `✅ Записано <b>${formatNumber(steps)}</b> кроків за сьогодні!`;
      if (steps >= dailyGoal) {
        reply += ` 🎉 Норму (${formatNumber(dailyGoal)} кр.) виконано! 🎯`;
      } else {
        reply += ` (до норми ще ${formatNumber(dailyGoal - steps)} кр.)`;
      }

      return ctx.reply(reply, { parse_mode: 'HTML' });
    }

    return next();
  });
}

module.exports = {
  registerUserHandlers,
};
