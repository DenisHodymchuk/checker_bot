const { InlineKeyboard } = require('grammy');
const queries = require('../db/queries');
const { formatUserStats, formatDailyReport, escapeHtml } = require('../services/leaderboard');
const { getTodayDateString, formatUkrainianDate, formatNumber } = require('../utils/date');
const { userAwaitingManualInput } = require('./photo');

function registerUserHandlers(bot) {
  // Команда /start
  bot.command('start', async (ctx) => {
    const userId = ctx.from.id;
    const firstName = ctx.from.first_name || 'Колего';
    const username = ctx.from.username || null;

    queries.upsertUser(userId, firstName, username);

    const isGroup = ctx.chat.type !== 'private';
    if (isGroup) {
      return ctx.reply(
        `👋 Привіт, ${escapeHtml(firstName)}! Я бот для обліку щоденних кроків.\n\n` +
        `• Щоб надсилати скріншоти кроків, перейдіть зі мною в <a href="https://t.me/${ctx.me.username}?start=join">особисті повідомлення</a>.\n` +
        `• Адміністратор може налаштувати цей чат для щоденних звітів командою /set_group.`,
        { parse_mode: 'HTML' }
      );
    }

    const keyboard = new InlineKeyboard()
      .text('📊 Моя статистика', 'btn_my_stats')
      .text('🏆 Поточний рейтинг', 'btn_leaderboard')
      .row()
      .text('ℹ️ Як це працює?', 'btn_help');

    const welcomeText = 
      `👋 Привіт, <b>${escapeHtml(firstName)}</b>!\n\n` +
      `Я бот для корпоративного челенджу щоденних кроків 👟\n\n` +
      `<b>Як користуватися:</b>\n` +
      `1️⃣ Просто надішліть мені сюди <b>фото або скріншот</b> з вашого телефону чи смарт-годинника (Apple Health, Garmin, Mi Fitness, Samsung тощо).\n` +
      `2️⃣ Я автоматично розпізнаю точну кількість кроків через Vision AI та запропоную підтвердити.\n` +
      `3️⃣ Якщо не маєте фото — введіть вручну: <code>/steps 10500</code>\n` +
      `4️⃣ Щовечора публікується підсумковий рейтинг команди в робочому чаті 🏆\n\n` +
      `Чекаю на ваші перші кроки за сьогодні! 🚶‍♀️🚶‍♂️`;

    await ctx.reply(welcomeText, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  });

  // Команда /help
  bot.command('help', async (ctx) => {
    const helpText = 
      `ℹ️ <b>Довідка по боту:</b>\n\n` +
      `• <b>Надіслати фото:</b> просто прикріпіть скріншот екрану з кроками в особисті повідомлення.\n` +
      `• <code>/steps [число]</code> — записати кроки за сьогодні вручну (наприклад: <code>/steps 8500</code>).\n` +
      `• <code>/my_stats</code> — переглянути власну статистику та рекорди.\n` +
      `• <code>/leaderboard</code> або <code>/top</code> — переглянути сьогоднішній рейтинг команди.\n` +
      `• <code>/settings</code> — панель налаштувань (для адміністратора).\n\n` +
      `🔔 Бот нагадає в приватні повідомлення о вказаній годині, якщо ви ще не надіслали результат за день.`;

    await ctx.reply(helpText, { parse_mode: 'HTML' });
  });

  // Команда /my_stats
  bot.command('my_stats', async (ctx) => {
    const text = formatUserStats(ctx.from.id);
    await ctx.reply(text, { parse_mode: 'HTML' });
  });

  // Команда /leaderboard або /top
  bot.command(['leaderboard', 'top'], async (ctx) => {
    const text = formatDailyReport();
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
    const date = getTodayDateString(queries.getSetting('timezone', 'Europe/Kyiv'));

    queries.upsertUser(userId, firstName, ctx.from.username);
    queries.saveDailySteps(userId, date, steps, 'manual', 'Введено вручну');

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
      msg += `🎉 Денну ціль (${formatNumber(dailyGoal)}) досягнуто! 🎯`;
    }

    await ctx.reply(msg, { parse_mode: 'HTML' });
  });

  // Обробка кнопок головного меню
  bot.callbackQuery('btn_my_stats', async (ctx) => {
    await ctx.answerCallbackQuery();
    const text = formatUserStats(ctx.from.id);
    await ctx.reply(text, { parse_mode: 'HTML' });
  });

  bot.callbackQuery('btn_leaderboard', async (ctx) => {
    await ctx.answerCallbackQuery();
    const text = formatDailyReport();
    await ctx.reply(text, { parse_mode: 'HTML' });
  });

  bot.callbackQuery('btn_help', async (ctx) => {
    await ctx.answerCallbackQuery();
    const helpText = 
      `👟 <b>Як це працює:</b>\n\n` +
      `1. Зробіть скріншот екрану у вашому фітнес-додатку в кінці дня.\n` +
      `2. Надішліть його сюди як фото.\n` +
      `3. ШІ автоматично розпізнає число кроків, а ви просто натиснете «✅ Зберегти».\n\n` +
      `Якщо ви забудете надіслати фото — я нагадаю вам увечері особисто!`;
    await ctx.reply(helpText, { parse_mode: 'HTML' });
  });

  // Обробка звичайних текстових повідомлень (наприклад, якщо користувач вводить число)
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
        queries.saveDailySteps(userId, date, steps, 'manual', 'Введено вручну');
        const dailyGoal = Number(queries.getSetting('daily_goal', '10000'));

        let replyMsg = `✅ <b>Збережено!</b> <b>${formatNumber(steps)}</b> кроків за ${escapeHtml(formatUkrainianDate(date))}.\n`;
        if (steps >= dailyGoal) {
          replyMsg += `🎉 Ціль (${formatNumber(dailyGoal)}) виконано! 🎯`;
        }

        return ctx.reply(replyMsg, { parse_mode: 'HTML' });
      } else {
        return ctx.reply('⚠️ Будь ласка, введіть дійсне число кроків (наприклад, <code>10500</code>), або надішліть /start для скасування.', {
          parse_mode: 'HTML',
        });
      }
    }

    // Якщо це просто число в приватному чаті (наприклад, користувач просто написав 12500)
    if (ctx.chat.type === 'private' && /^\d{3,6}$/.test(text)) {
      const steps = Number(text);
      const date = getTodayDateString(queries.getSetting('timezone', 'Europe/Kyiv'));
      const firstName = ctx.from.first_name || 'Колега';

      queries.upsertUser(userId, firstName, ctx.from.username);
      queries.saveDailySteps(userId, date, steps, 'manual', 'Введено числом');

      return ctx.reply(`✅ Записано <b>${formatNumber(steps)}</b> кроків за сьогодні!`, {
        parse_mode: 'HTML',
      });
    }

    return next();
  });
}

module.exports = {
  registerUserHandlers,
};
