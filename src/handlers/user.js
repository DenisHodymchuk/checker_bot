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
const {
  userAwaitingManualInput,
  reactToMessage,
  resolveMessageSenderAndDate,
  parseCaptionHints,
} = require('./photo');
const { syncUserStepsToSheet } = require('../services/google_sheet');

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

  /**
   * Універсальна обробка вводу кроків: через /steps, /s, /k або текстовою відповіддю на скрін / повідомлення бота
   */
  async function processStepTextInput(ctx, rawText) {
    const tz = await queries.getSetting('timezone', 'Europe/Kyiv');
    const deadlineTime = await queries.getSetting('deadline_time', '12:00');
    const dailyGoal = Number(await queries.getSetting('daily_goal', '10000'));

    const { captionSteps: steps, captionDate, captionUsername, isPlus } = parseCaptionHints(rawText, tz);
    if (!steps || steps <= 0 || steps > 150000) {
      return false;
    }

    let resolvedUserId = null;
    let resolvedDate = captionDate || null;
    let photoMessageIdToReact = null;

    // 1. Якщо явно вказано @username у тексті команди
    if (captionUsername) {
      const matched = await queries.findUserByHandleOrId(captionUsername);
      if (matched) {
        resolvedUserId = matched.id;
      } else {
        await ctx.reply(
          `⚠️ Учасника <b>@${escapeHtml(captionUsername)}</b> не знайдено в таблиці. Перевірте правильність логіна.`,
          { parse_mode: 'HTML', reply_parameters: { message_id: ctx.message.message_id } }
        );
        return true;
      }
    }

    // 2. Перевіряємо повідомлення, на яке відповіли (Reply)
    const replyMsg = !ctx.message.reply_to_message?.forum_topic_created ? ctx.message.reply_to_message : null;
    if (replyMsg) {
      // 2a. Якщо відповіли на повідомлення бота з кнопкою manual_input:userId:date
      const kbRows = replyMsg.reply_markup?.inline_keyboard || [];
      for (const row of kbRows) {
        for (const btn of row) {
          const m = btn.callback_data?.match(/^manual_input:(\d+):([\d-]+)$/);
          if (m) {
            if (!resolvedUserId) resolvedUserId = Number(m[1]);
            if (!resolvedDate) resolvedDate = m[2];
          }
        }
      }

      // 2b. Якщо відповіли прямо на фото-скріншот (у групі або в особистих)
      if (replyMsg.photo) {
        photoMessageIdToReact = replyMsg.message_id;
        const { userId: pUserId, firstName: pName, username: pUsername, messageDate: pDate, unmatchedHiddenName } =
          await resolveMessageSenderAndDate(replyMsg, replyMsg.from);
        if (!unmatchedHiddenName) {
          await queries.upsertUser(pUserId, pName, pUsername);
          if (!resolvedUserId) resolvedUserId = pUserId;
        }
        if (!resolvedDate) {
          resolvedDate = await resolveSubmissionDate({
            userId: resolvedUserId || pUserId,
            messageDate: pDate,
            timeZone: tz,
            deadlineTime,
            dailyGoal,
            getUserStepsForDate: queries.getUserStepsForDate,
          });
        }
      }
    }

    // 3. Якщо бот очікував ручного вводу після попереднього нерозпізнаного фото або кнопки
    if (userAwaitingManualInput.has(ctx.from.id)) {
      const state = userAwaitingManualInput.get(ctx.from.id);
      userAwaitingManualInput.delete(ctx.from.id);
      if (!resolvedUserId && state.targetUserId) resolvedUserId = state.targetUserId;
      if (!resolvedDate && state.date) resolvedDate = state.date;
      if (!photoMessageIdToReact && state.photoMessageId) photoMessageIdToReact = state.photoMessageId;
    }

    // 4. За замовчуванням — сам відправник повідомлення
    if (!resolvedUserId) {
      resolvedUserId = ctx.from.id;
      await queries.upsertUser(ctx.from.id, ctx.from.first_name || 'Колега', ctx.from.username);
    }

    const targetUser = await queries.getUser(resolvedUserId);
    const isAdminAccount = targetUser?.username?.toLowerCase() === 'godymchuk_d_d' || (!targetUser?.is_active && ctx.from.username?.toLowerCase() === 'godymchuk_d_d' && resolvedUserId === ctx.from.id);

    if (ctx.chat.type === 'private' && isAdminAccount) {
      await ctx.reply(
        `⚠️ <b>Не вказано, для якого учасника ці кроки!</b>\n\n` +
        `Оскільки ви адміністратор, будь ласка:\n` +
        `• або дайте <b>Reply (Відповісти)</b> прямо на скріншот учасника чи повідомлення бота;\n` +
        `• або вкажіть логін учасника: <code>/steps @username ${steps} 06.11</code>`,
        { parse_mode: 'HTML', reply_parameters: { message_id: ctx.message.message_id } }
      );
      return true;
    }

    if (!resolvedDate) {
      resolvedDate = await resolveSubmissionDate({
        userId: resolvedUserId,
        messageDate: new Date(),
        timeZone: tz,
        deadlineTime,
        dailyGoal,
        getUserStepsForDate: queries.getUserStepsForDate,
      });
    }

    let finalSteps = steps;
    if (isPlus) {
      const res = await queries.addDailySteps(resolvedUserId, resolvedDate, steps, 'manual', 'Додано через команду');
      finalSteps = res.totalSteps;
    } else {
      await queries.saveDailySteps(resolvedUserId, resolvedDate, steps, 'manual', 'Введено через команду');
    }

    await syncUserStepsToSheet(resolvedUserId, resolvedDate, finalSteps);
    await reactToMessage(ctx, '👍');
    if (photoMessageIdToReact) {
      await reactToMessage(ctx, '👍', photoMessageIdToReact);
    }

    const displayName = targetUser
      ? (targetUser.username ? `${targetUser.first_name} (@${targetUser.username})` : targetUser.first_name)
      : (ctx.from.first_name || 'Колега');

    if (ctx.chat.type === 'private') {
      await ctx.reply(
        `✅ <b>Записано в Google Таблицю:</b> <b>${formatNumber(finalSteps)}</b> кроків для <b>${escapeHtml(displayName)}</b> за <b>${escapeHtml(formatUkrainianDate(resolvedDate))}</b>!`,
        { parse_mode: 'HTML', reply_parameters: { message_id: ctx.message.message_id } }
      );
    }

    return true;
  }

  // Ручний запис або доплюсовування кроків: /steps 12000 [дата] [@username] (або скорочено /s, /k)
  bot.command(['steps', 's', 'k'], async (ctx) => {
    const args = ctx.message.text.split(/\s+/).slice(1);
    if (args.length === 0) {
      return ctx.reply(
        '⚠️ <b>Як користуватися командою <code>/steps</code>:</b>\n\n' +
        '• <b>У підписі до скріншота:</b> прикріпіть фото і напишіть у підписі <code>/steps 10500</code> (або просто <code>10500</code>)\n' +
        '• <b>У відповідь (Reply) на скріншот:</b> дайте відповідь на фото командою <code>/steps 10500</code>\n' +
        '• <b>За іншу дату чи учасника:</b> <code>/steps @username 10500 06.11</code>\n' +
        '• <b>Доплюсувати кроки:</b> <code>/steps +3000</code>',
        { parse_mode: 'HTML' }
      );
    }

    const handled = await processStepTextInput(ctx, ctx.message.text);
    if (!handled) {
      await ctx.reply(
        '⚠️ Введіть коректне число кроків від 100 до 150 000 (наприклад: <code>/steps 10500</code> або <code>/steps @username 10500 06.11</code>).',
        { parse_mode: 'HTML' }
      );
    }
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
      `1. Надішліть скріншот крокоміра у гілку для скрінів і додайте у підпис команду <code>/steps 10500</code> (або просто число <code>10500</code>).\n` +
      `2. Бот поставить реакцію 👍 на фото та миттєво запише кроки у базу і Google Таблицю.\n` +
      `3. Скріни за день (наприклад, за 8 число) приймаються <b>до 12:00 наступного дня</b> (9 числа).\n` +
      `4. Об 11:00 приходить нагадування тим, хто забув скинути скрін за вчора.\n` +
      `5. О 12:00 фіксуються пропуски та штрафи, а о 13:00 публікується звіт за вчора!`;
    await ctx.reply(helpText, { parse_mode: 'HTML' });
  });

  // Обробка текстових повідомлень (ручний ввід числа, відповідь на фото або доплюсовування)
  bot.on('message:text', async (ctx, next) => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return next();

    const { isAllowedStepsTopic } = require('../utils/topic');
    const replyMsg = !ctx.message.reply_to_message?.forum_topic_created ? ctx.message.reply_to_message : null;
    const isReplyToBotOrPhoto = Boolean(replyMsg && (replyMsg.from?.is_bot || replyMsg.photo));
    const isAwaiting = userAwaitingManualInput.has(ctx.from.id);

    if (ctx.chat.type === 'private' || isAwaiting || (isReplyToBotOrPhoto && await isAllowedStepsTopic(ctx))) {
      const handled = await processStepTextInput(ctx, text);
      if (handled) return;
      if (isAwaiting) {
        return ctx.reply(
          '⚠️ Будь ласка, введіть дійсне число кроків (наприклад: <code>/steps 10500</code> або просто <code>10500</code>), або надішліть /start для скасування.',
          { parse_mode: 'HTML' }
        );
      }
    }

    return next();
  });
}

module.exports = {
  registerUserHandlers,
};
