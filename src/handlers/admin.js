const { InlineKeyboard } = require('grammy');
const { config } = require('../config');
const queries = require('../db/queries');
const { 
  formatDailyReport, 
  formatMonthlyStatusReport, 
  formatBankReport, 
  formatReminderMessage, 
  escapeHtml 
} = require('../services/leaderboard');
const { formatNumber, getTodayDateString, formatUkrainianDate } = require('../utils/date');

/**
 * Перевіряє, чи має користувач права адміністратора
 */
async function isAdmin(ctx) {
  if (config.adminId && ctx.from.id === config.adminId) {
    return true;
  }
  if (ctx.chat.type !== 'private') {
    try {
      const member = await ctx.api.getChatMember(ctx.chat.id, ctx.from.id);
      return member.status === 'creator' || member.status === 'administrator';
    } catch {
      return false;
    }
  }
  if (!config.adminId) {
    return true;
  }
  return false;
}

/**
 * Будує головне повідомлення налаштувань та інлайн-клавіатуру
 */
async function buildSettingsView() {
  const settings = await queries.getAllSettings();
  const reminderTime = settings.reminder_time || '20:30';
  const reportTime = settings.report_time || '22:00';
  const dailyGoal = settings.daily_goal || '10000';
  const graceLimit = settings.grace_days_limit || '2';
  const penaltyAmount = settings.penalty_amount || '100';
  const remindersEnabled = settings.reminders_enabled !== '0';
  const reportsEnabled = settings.reports_enabled !== '0';
  const groupChatId = settings.group_chat_id;
  const activeUsers = await queries.getAllActiveUsers();
  const totalBank = await queries.getAllPaymentsTotal();

  const jarUrl = settings.jar_url || 'https://send.monobank.ua/jar/6fwMYmHxM1';

  let text = `⚙️ <b>Панель налаштувань бота</b>\n\n`;
  text += `⏰ <b>Час нагадувань:</b> <code>${reminderTime}</code> (${remindersEnabled ? '✅ Увімкнено' : '❌ Вимкнено'})\n`;
  text += `📊 <b>Час звіту в чат:</b> <code>${reportTime}</code> (${reportsEnabled ? '✅ Увімкнено' : '❌ Вимкнено'})\n`;
  text += `🎯 <b>Щоденна норма:</b> <code>${formatNumber(dailyGoal)}</code> кроків\n`;
  text += `🛡️ <b>Пільгових днів:</b> <code>${graceLimit}</code> на місяць\n`;
  text += `💸 <b>Штраф:</b> <code>${penaltyAmount} грн</code> (з 3-го пропуску)\n`;
  text += `🏦 <b>Штрафна банка:</b> <code>${formatNumber(totalBank)} грн</code> (<a href="${jarUrl}">Monobank</a>)\n`;
  text += `👥 <b>Активних учасників:</b> ${activeUsers.length}\n`;
  text += `💬 <b>Груповий чат:</b> ${groupChatId ? `<code>ID: ${groupChatId}</code> ✅` : '⚠️ Не підключено (напишіть /set_group у групі)'}\n\n`;
  text += `Оберіть параметр для зміни:`;

  const keyboard = new InlineKeyboard()
    .text('⏰ Час нагадування', 'set_time:reminder')
    .text('📊 Час звіту', 'set_time:report')
    .row()
    .text('🎯 Денна норма', 'set_target_goal')
    .text(remindersEnabled ? '🔔 Вимкнути нагадування' : '🔕 Увімкнути нагадування', 'toggle_reminders')
    .row()
    .text('📢 Надіслати звіт зараз', 'admin_trigger_report')
    .text('👟 Розіслати нагадування зараз', 'admin_trigger_remind')
    .row()
    .text('🏦 Штрафна банка', 'admin_view_bank')
    .text('👥 Список колег', 'admin_view_users')
    .row()
    .text('🔄 Оновити', 'admin_refresh_settings');

  return { text, keyboard };
}

function registerAdminHandlers(bot, schedulerCallbacks = {}) {
  // Команда /set_group — для прив'язки групи
  bot.command('set_group', async (ctx) => {
    if (ctx.chat.type === 'private') {
      return ctx.reply('⚠️ Цю команду потрібно викликати <b>всередині робочої групи</b>, куди бот має надсилати щоденні звіти!', {
        parse_mode: 'HTML',
      });
    }

    const permitted = await isAdmin(ctx);
    if (!permitted) {
      return ctx.reply('⛔️ Тільки адміністратор може підключати групу.');
    }

    const groupId = String(ctx.chat.id);
    await queries.setSetting('group_chat_id', groupId);

    // Автоматично реєструємо всіх адміністраторів цієї групи у челендж
    let addedAdmins = 0;
    try {
      const admins = await ctx.api.getChatAdministrators(ctx.chat.id);
      for (const a of admins) {
        if (!a.user.is_bot) {
          await queries.upsertUser(a.user.id, a.user.first_name, a.user.username);
          addedAdmins++;
        }
      }
    } catch (err) {
      console.warn('Не вдалося отримати адмінів групи:', err.message);
    }

    // Перевіряємо статус бота в групі
    let botAdminNotice = '';
    try {
      const me = await ctx.api.getChatMember(ctx.chat.id, ctx.me.id);
      if (me.status !== 'administrator') {
        botAdminNotice = '\n\n⚠️ <b>Порада:</b> Призначте бота адміністратором цього чату (або вимкніть Group Privacy у @BotFather), щоб бот автоматично бачив скріншоти та повідомлення всіх учасників!';
      }
    } catch {}

    const reportTime = await queries.getSetting('report_time', '22:00');
    await ctx.reply(
      `🎉 <b>Успішно!</b> Цю групу прив'язано для публікації щоденних звітів команди кроків.\n\n` +
      `👥 Автоматично зареєстровано в челенджі: <b>${addedAdmins}</b> адміністраторів чату.\n` +
      `Щодня о <b>${reportTime}</b> сюди публікуватиметься турнірна таблиця.\n` +
      `Ви можете протестувати надсилання прямо зараз командою /report.${botAdminNotice}`,
      { parse_mode: 'HTML' }
    );
  });

  // Команда /sync — синхронізація учасників чату
  bot.command(['sync', 'sync_members'], async (ctx) => {
    const permitted = await isAdmin(ctx);
    if (!permitted) {
      return ctx.reply('⛔️ Тільки адміністратор може виконувати синхронізацію.');
    }

    const savedGroupId = await queries.getSetting('group_chat_id');
    const targetChatId = ctx.chat.type !== 'private' ? ctx.chat.id : (savedGroupId ? Number(savedGroupId) : null);

    let syncedAdmins = 0;
    let memberCountStr = '';

    if (targetChatId) {
      try {
        const admins = await ctx.api.getChatAdministrators(targetChatId);
        for (const a of admins) {
          if (!a.user.is_bot) {
            await queries.upsertUser(a.user.id, a.user.first_name, a.user.username);
            syncedAdmins++;
          }
        }
        const totalInGroup = await ctx.api.getChatMemberCount(targetChatId);
        memberCountStr = `\n👥 Всього користувачів у чаті: <b>${totalInGroup}</b>.`;
      } catch (err) {
        console.warn('Помилка синхронізації з чатом:', err.message);
      }
    }

    const activeUsers = await queries.getAllActiveUsers();
    await ctx.reply(
      `✅ <b>Синхронізацію учасників виконано!</b>\n\n` +
      `• Оновлено з групи: <b>${syncedAdmins}</b> колег\n` +
      `• Всього зареєстровано в челенджі бота: <b>${activeUsers.length}</b> учасників${memberCountStr}\n\n` +
      `<i>Усі нові учасники автоматично реєструються, як тільки напишуть будь-яке повідомлення або надішлють скріншот у групу.</i>`,
      { parse_mode: 'HTML' }
    );
  });

  // Команда /add_user — ручне додавання користувача
  bot.command('add_user', async (ctx) => {
    const permitted = await isAdmin(ctx);
    if (!permitted) {
      return ctx.reply('⛔️ Тільки адміністратор може додавати учасників.');
    }

    const args = ctx.message.text.split(/\s+/).slice(1);
    let targetId = null;
    let targetUsername = null;
    let targetName = null;

    if (ctx.message.reply_to_message?.from) {
      const u = ctx.message.reply_to_message.from;
      targetId = u.id;
      targetUsername = u.username;
      targetName = args.length > 0 ? args.join(' ') : u.first_name;
    } else {
      if (args.length < 1) {
        return ctx.reply(
          '⚠️ <b>Формат команди:</b>\n\n' +
          '• <code>/add_user @username [Ім\'я]</code>\n' +
          '• <code>/add_user [ID] [Ім\'я]</code>\n' +
          '• Або дайте відповідь (reply) на повідомлення учасника командою: <code>/add_user</code>',
          { parse_mode: 'HTML' }
        );
      }

      const firstArg = args[0];
      if (/^\d+$/.test(firstArg)) {
        targetId = Number(firstArg);
        targetName = args.slice(1).join(' ') || `Колега ${targetId}`;
      } else {
        targetUsername = firstArg.replace(/^@/, '');
        targetName = args.slice(1).join(' ') || targetUsername;
        targetId = Math.floor(100000000 + Math.random() * 900000000);
      }
    }

    await queries.upsertUser(targetId, targetName, targetUsername);
    await ctx.reply(
      `✅ <b>Учасника додано до челенджу!</b>\n\n` +
      `👤 Ім'я: <b>${escapeHtml(targetName)}</b>\n` +
      `🔗 Handle: ${targetUsername ? `@${escapeHtml(targetUsername)}` : `ID: ${targetId}`}`,
      { parse_mode: 'HTML' }
    );
  });

  // Команда /set_jar — налаштування посилання на банку Monobank
  bot.command('set_jar', async (ctx) => {
    const permitted = await isAdmin(ctx);
    if (!permitted) {
      return ctx.reply('⛔️ Тільки адміністратор може змінювати посилання на банку.');
    }

    const args = ctx.message.text.split(/\s+/).slice(1);
    if (args.length === 0) {
      const current = await queries.getSetting('jar_url', 'https://send.monobank.ua/jar/6fwMYmHxM1');
      return ctx.reply(`🏦 Поточне посилання на банку: <a href="${current}">${current}</a>`, { parse_mode: 'HTML' });
    }

    const newUrl = args[0].trim();
    await queries.setSetting('jar_url', newUrl);
    await ctx.reply(`✅ <b>Посилання на банку оновлено:</b>\n<a href="${newUrl}">${newUrl}</a>`, { parse_mode: 'HTML' });
  });

  // Команда /settings
  bot.command('settings', async (ctx) => {
    const permitted = await isAdmin(ctx);
    if (!permitted) {
      return ctx.reply('⛔️ У вас немає доступу до налаштувань бота.');
    }

    const { text, keyboard } = await buildSettingsView();
    await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  });

  // Команда /report — ручний виклик звіту
  bot.command('report', async (ctx) => {
    const permitted = await isAdmin(ctx);
    if (!permitted) {
      return ctx.reply('⛔️ Тільки адміністратор може ініціювати публікацію звіту.');
    }

    const reportText = await formatDailyReport();
    await ctx.reply(reportText, { parse_mode: 'HTML' });
  });

  // Команда /bank — стан штрафної банки
  bot.command('bank', async (ctx) => {
    const text = await formatBankReport();
    await ctx.reply(text, { parse_mode: 'HTML' });
  });

  // Команда /set — ручне встановлення кроків учасника адміном
  // Формат: /set @username 12000 [YYYY-MM-DD] або /set 12000 у відповідь на повідомлення
  bot.command('set', async (ctx) => {
    const permitted = await isAdmin(ctx);
    if (!permitted) {
      return ctx.reply('⛔️ Тільки адміністратор може коригувати кроки учасників.');
    }

    const args = ctx.message.text.split(/\s+/).slice(1);
    const tz = await queries.getSetting('timezone', 'Europe/Kyiv');
    const today = getTodayDateString(tz);

    let targetUser = null;
    let steps = null;
    let targetDate = today;

    if (ctx.message.reply_to_message?.from) {
      // Якщо це відповідь на повідомлення користувача
      const replyUser = ctx.message.reply_to_message.from;
      targetUser = await queries.getUser(replyUser.id);
      if (!targetUser) {
        await queries.upsertUser(replyUser.id, replyUser.first_name, replyUser.username);
        targetUser = await queries.getUser(replyUser.id);
      }

      if (args.length >= 1) {
        steps = Number(args[0].replace(/\D/g, ''));
      }
      if (args.length >= 2 && /^\d{4}-\d{2}-\d{2}$/.test(args[1])) {
        targetDate = args[1];
      }
    } else {
      // Якщо вказано аргументами: /set @username 12000 [дата]
      if (args.length < 2) {
        return ctx.reply(
          '⚠️ <b>Формат команди /set:</b>\n\n' +
          '• <code>/set @username 10500</code> — встановити кроки за сьогодні\n' +
          '• <code>/set @username 10500 2026-10-11</code> — встановити за конкретну дату\n' +
          '• Або дайте відповідь (reply) на повідомлення учасника командою: <code>/set 10500</code>',
          { parse_mode: 'HTML' }
        );
      }

      const identifier = args[0];
      targetUser = await queries.findUserByHandleOrId(identifier);
      if (!targetUser) {
        return ctx.reply(`⚠️ Користувача <code>${escapeHtml(identifier)}</code> не знайдено в базі бота. Переконайтеся, що він натискав /start.`);
      }

      steps = Number(args[1].replace(/\D/g, ''));
      if (args.length >= 3 && /^\d{4}-\d{2}-\d{2}$/.test(args[2])) {
        targetDate = args[2];
      }
    }

    if (!steps || isNaN(steps) || steps < 0 || steps > 150000) {
      return ctx.reply('⚠️ Вкажіть коректне число кроків від 0 до 150 000.');
    }

    await queries.saveDailySteps(targetUser.id, targetDate, steps, 'admin', `Встановлено адміном @${ctx.from.username || ctx.from.id}`);

    const name = targetUser.first_name ? escapeHtml(targetUser.first_name) : (targetUser.username ? `@${escapeHtml(targetUser.username)}` : 'Колезі');
    await ctx.reply(
      `✅ <b>Успішно оновлено!</b>\n\n` +
      `👤 Учасник: <b>${name}</b>\n` +
      `📅 Дата: <b>${escapeHtml(formatUkrainianDate(targetDate))}</b>\n` +
      `👟 Кроки: <b>${formatNumber(steps)}</b>`,
      { parse_mode: 'HTML' }
    );
  });

  // Команда /paid — фіксація сплати штрафу
  // Формат: /paid @username 100 [коментар] або /paid 100 у відповідь
  bot.command('paid', async (ctx) => {
    const permitted = await isAdmin(ctx);
    if (!permitted) {
      return ctx.reply('⛔️ Тільки адміністратор може відмічати оплату штрафів.');
    }

    const args = ctx.message.text.split(/\s+/).slice(1);
    let targetUser = null;
    let amount = null;
    let notes = '';

    if (ctx.message.reply_to_message?.from) {
      const replyUser = ctx.message.reply_to_message.from;
      targetUser = await queries.getUser(replyUser.id);
      if (!targetUser) {
        await queries.upsertUser(replyUser.id, replyUser.first_name, replyUser.username);
        targetUser = await queries.getUser(replyUser.id);
      }

      if (args.length >= 1) {
        amount = Number(args[0].replace(/\D/g, ''));
      }
      if (args.length >= 2) {
        notes = args.slice(1).join(' ');
      }
    } else {
      if (args.length < 2) {
        return ctx.reply(
          '⚠️ <b>Формат команди /paid:</b>\n\n' +
          '• <code>/paid @username 100</code> — зарахувати 100 грн у банку\n' +
          '• <code>/paid @username 200 Monobank</code> — з коментарем\n' +
          '• Або дайте відповідь (reply) на повідомлення боржника: <code>/paid 100</code>',
          { parse_mode: 'HTML' }
        );
      }

      const identifier = args[0];
      targetUser = await queries.findUserByHandleOrId(identifier);
      if (!targetUser) {
        return ctx.reply(`⚠️ Користувача <code>${escapeHtml(identifier)}</code> не знайдено.`);
      }

      amount = Number(args[1].replace(/\D/g, ''));
      if (args.length >= 3) {
        notes = args.slice(2).join(' ');
      }
    }

    if (!amount || isNaN(amount) || amount <= 0) {
      return ctx.reply('⚠️ Вкажіть коректну суму оплати в гривнях (наприклад: <code>100</code>).');
    }

    await queries.addPenaltyPayment(targetUser.id, amount, ctx.from.id, notes);

    const tz = await queries.getSetting('timezone', 'Europe/Kyiv');
    const today = getTodayDateString(tz);
    const monthStats = await queries.getUserMonthStats(targetUser.id, today.slice(0, 7), today);
    const totalBank = await queries.getAllPaymentsTotal();

    const name = targetUser.first_name ? escapeHtml(targetUser.first_name) : (targetUser.username ? `@${escapeHtml(targetUser.username)}` : 'Учасник');

    await ctx.reply(
      `💰 <b>Оплату зафіксовано!</b>\n\n` +
      `👤 Платник: <b>${name}</b>\n` +
      `💵 Сума: <b>+${formatNumber(amount)} грн</b>${notes ? ` (<i>${escapeHtml(notes)}</i>)` : ''}\n` +
      `💳 Залишок боргу учасника: <b>${formatNumber(monthStats.currentDebt)} грн</b>\n` +
      `🏦 Всього коштів у штрафній банці: <b>${formatNumber(totalBank)} грн</b> 🎉`,
      { parse_mode: 'HTML' }
    );
  });

  // Оновлення меню налаштувань
  bot.callbackQuery('admin_refresh_settings', async (ctx) => {
    await ctx.answerCallbackQuery({ text: 'Оновлено' });
    const { text, keyboard } = await buildSettingsView();
    try {
      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    } catch (err) {
      if (!err.message?.includes('message is not modified')) {
        console.warn('Помилка оновлення налаштувань:', err.message);
      }
    }
  });

  // Перегляд банку з налаштувань
  bot.callbackQuery('admin_view_bank', async (ctx) => {
    await ctx.answerCallbackQuery();
    const text = await formatBankReport();
    const keyboard = new InlineKeyboard().text('⬅️ До налаштувань', 'admin_refresh_settings');
    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  });

  // Перемикання увімкнення нагадувань
  bot.callbackQuery('toggle_reminders', async (ctx) => {
    const current = await queries.getSetting('reminders_enabled', '1');
    const newVal = current === '1' ? '0' : '1';
    await queries.setSetting('reminders_enabled', newVal);

    await ctx.answerCallbackQuery({ text: newVal === '1' ? 'Нагадування увімкнено' : 'Нагадування вимкнено' });
    const { text, keyboard } = await buildSettingsView();
    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  });

  // Вибір часу для нагадувань або звіту
  bot.callbackQuery(/^set_time:(reminder|report)$/, async (ctx) => {
    const type = ctx.match[1];
    const title = type === 'reminder' ? 'нагадувань' : 'підсумкового звіту';

    const times = ['18:00', '19:00', '20:00', '20:30', '21:00', '21:30', '22:00', '22:30', '23:00'];
    const keyboard = new InlineKeyboard();

    times.forEach((t, i) => {
      keyboard.text(t, `save_time:${type}:${t}`);
      if ((i + 1) % 3 === 0) keyboard.row();
    });
    keyboard.row().text('⬅️ Назад', 'admin_refresh_settings');

    await ctx.answerCallbackQuery();
    await ctx.editMessageText(`⏰ Оберіть новий час для <b>${title}</b>:`, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  });

  // Збереження обраного часу
  bot.callbackQuery(/^save_time:(reminder|report):([\d:]+)$/, async (ctx) => {
    const type = ctx.match[1];
    const time = ctx.match[2];

    const key = type === 'reminder' ? 'reminder_time' : 'report_time';
    await queries.setSetting(key, time);

    if (schedulerCallbacks.reloadJobs) {
      schedulerCallbacks.reloadJobs();
    }

    await ctx.answerCallbackQuery({ text: `Час встановлено на ${time}` });
    const { text, keyboard } = await buildSettingsView();
    await ctx.editMessageText(`✅ Час успішно змінено на <b>${time}</b>!\n\n` + text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  });

  // Меню зміни денної норми
  bot.callbackQuery('set_target_goal', async (ctx) => {
    const goals = [6000, 8000, 10000, 12000, 15000, 20000];
    const keyboard = new InlineKeyboard();

    goals.forEach((g, i) => {
      keyboard.text(`${formatNumber(g)} кр.`, `save_goal:${g}`);
      if ((i + 1) % 2 === 0) keyboard.row();
    });
    keyboard.row().text('⬅️ Назад', 'admin_refresh_settings');

    await ctx.answerCallbackQuery();
    await ctx.editMessageText('🎯 Оберіть щоденну норму кроків для всієї команди:', {
      reply_markup: keyboard,
    });
  });

  bot.callbackQuery(/^save_goal:(\d+)$/, async (ctx) => {
    const goal = ctx.match[1];
    await queries.setSetting('daily_goal', goal);

    await ctx.answerCallbackQuery({ text: `Норму встановлено: ${formatNumber(goal)}` });
    const { text, keyboard } = await buildSettingsView();
    await ctx.editMessageText(`✅ Денну норму змінено на <b>${formatNumber(goal)}</b> кроків!\n\n` + text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  });

  // Ручний запуск відправки звіту в групу
  bot.callbackQuery('admin_trigger_report', async (ctx) => {
    const groupChatId = await queries.getSetting('group_chat_id');
    if (!groupChatId) {
      await ctx.answerCallbackQuery({ text: 'Спочатку прив\'яжіть групу через /set_group!', show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery({ text: 'Надсилаю звіт у групу...' });
    const reportText = await formatDailyReport();

    try {
      await bot.api.sendMessage(groupChatId, reportText, { parse_mode: 'HTML' });
      await ctx.reply('✅ Звіт успішно надіслано в робочу групу!');
    } catch (err) {
      console.error('Помилка відправки звіту в групу:', err);
      await ctx.reply(`❌ Не вдалося надіслати повідомлення в групу: ${err.message}. Переконайтеся, що бот доданий у групу як адміністратор.`);
    }
  });

  // Ручний запуск розсилки нагадувань
  bot.callbackQuery('admin_trigger_remind', async (ctx) => {
    await ctx.answerCallbackQuery({ text: 'Розсилаю нагадування...' });
    const tz = await queries.getSetting('timezone', 'Europe/Kyiv');
    const today = getTodayDateString(tz);
    const missing = await queries.getMissingUsersForDate(today);

    if (missing.length === 0) {
      return ctx.reply('🎉 Всі зареєстровані учасники вже надіслали свої результати за сьогодні!');
    }

    const groupChatId = await queries.getSetting('group_chat_id');
    if (groupChatId) {
      try {
        const { formatGroupReminderMessage } = require('../services/leaderboard');
        const groupMsg = await formatGroupReminderMessage(missing, today);
        await bot.api.sendMessage(groupChatId, groupMsg, { parse_mode: 'HTML' });
      } catch (err) {
        console.error('Помилка відправки нагадування в групу:', err.message);
      }
    }

    let sentCount = 0;
    for (const user of missing) {
      try {
        const msg = formatReminderMessage(user.first_name);
        await bot.api.sendMessage(user.user_id, msg);
        sentCount++;
      } catch (err) {}
    }

    await ctx.reply(`🔔 Нагадування надіслано в робочу групу${sentCount > 0 ? ` (також ${sentCount} в особисті)` : ''}!`);
  });

  // Перегляд списку зареєстрованих колег
  bot.callbackQuery('admin_view_users', async (ctx) => {
    const users = await queries.getAllUsers();
    await ctx.answerCallbackQuery();

    if (users.length === 0) {
      return ctx.reply('Поки немає зареєстрованих колег. Вони мають натиснути /start у боті.');
    }

    let msg = `👥 <b>Список зареєстрованих колег (${users.length}):</b>\n\n`;
    users.forEach((u, idx) => {
      const status = u.is_active ? '🟢' : '⏸ (на паузі)';
      const handle = u.username ? `@${escapeHtml(u.username)}` : `ID: ${u.id}`;
      msg += `${idx + 1}. ${status} <b>${escapeHtml(u.first_name)}</b> (${handle})\n`;
    });

    const keyboard = new InlineKeyboard().text('⬅️ До налаштувань', 'admin_refresh_settings');
    await ctx.editMessageText(msg, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  });
}

module.exports = {
  registerAdminHandlers,
};
