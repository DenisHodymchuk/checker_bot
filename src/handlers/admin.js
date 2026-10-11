const { InlineKeyboard } = require('grammy');
const { config } = require('../config');
const queries = require('../db/queries');
const { formatDailyReport, formatReminderMessage, escapeHtml } = require('../services/leaderboard');
const { formatNumber, getTodayDateString } = require('../utils/date');

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
function buildSettingsView() {
  const settings = queries.getAllSettings();
  const reminderTime = settings.reminder_time || '20:30';
  const reportTime = settings.report_time || '22:00';
  const dailyGoal = settings.daily_goal || '10000';
  const remindersEnabled = settings.reminders_enabled !== '0';
  const reportsEnabled = settings.reports_enabled !== '0';
  const groupChatId = settings.group_chat_id;
  const activeUsers = queries.getAllActiveUsers();

  let text = `⚙️ <b>Панель налаштувань бота</b>\n\n`;
  text += `⏰ <b>Час нагадувань:</b> <code>${reminderTime}</code> (${remindersEnabled ? '✅ Увімкнено' : '❌ Вимкнено'})\n`;
  text += `📊 <b>Час звіту в чат:</b> <code>${reportTime}</code> (${reportsEnabled ? '✅ Увімкнено' : '❌ Вимкнено'})\n`;
  text += `🎯 <b>Денна ціль:</b> <code>${formatNumber(dailyGoal)}</code> кроків\n`;
  text += `👥 <b>Активних учасників:</b> ${activeUsers.length}\n`;
  text += `💬 <b>Груповий чат:</b> ${groupChatId ? `<code>ID: ${groupChatId}</code> ✅` : '⚠️ Не підключено (напишіть /set_group у групі)'}\n\n`;
  text += `Оберіть параметр для зміни:`;

  const keyboard = new InlineKeyboard()
    .text('⏰ Час нагадування', 'set_time:reminder')
    .text('📊 Час звіту', 'set_time:report')
    .row()
    .text('🎯 Денна ціль', 'set_target_goal')
    .text(remindersEnabled ? '🔔 Вимкнути нагадування' : '🔕 Увімкнути нагадування', 'toggle_reminders')
    .row()
    .text('📢 Надіслати звіт зараз', 'admin_trigger_report')
    .text('👟 Розіслати нагадування зараз', 'admin_trigger_remind')
    .row()
    .text('👥 Список колег', 'admin_view_users')
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
    queries.setSetting('group_chat_id', groupId);

    await ctx.reply(
      `🎉 <b>Успішно!</b> Цю групу прив'язано для публікації щоденних звітів команди кроків.\n\n` +
      `Щодня о <b>${queries.getSetting('report_time', '22:00')}</b> сюди публікуватиметься турнірна таблиця.\n` +
      `Ви можете протестувати надсилання прямо зараз командою /report.`,
      { parse_mode: 'HTML' }
    );
  });

  // Команда /settings
  bot.command('settings', async (ctx) => {
    const permitted = await isAdmin(ctx);
    if (!permitted) {
      return ctx.reply('⛔️ У вас немає доступу до налаштувань бота.');
    }

    const { text, keyboard } = buildSettingsView();
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

    const reportText = formatDailyReport();
    await ctx.reply(reportText, { parse_mode: 'HTML' });
  });

  // Обробка інлайн-кнопок меню налаштувань
  bot.callbackQuery('admin_refresh_settings', async (ctx) => {
    await ctx.answerCallbackQuery({ text: 'Оновлено' });
    const { text, keyboard } = buildSettingsView();
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

  // Перемикання увімкнення нагадувань
  bot.callbackQuery('toggle_reminders', async (ctx) => {
    const current = queries.getSetting('reminders_enabled', '1');
    const newVal = current === '1' ? '0' : '1';
    queries.setSetting('reminders_enabled', newVal);

    await ctx.answerCallbackQuery({ text: newVal === '1' ? 'Нагадування увімкнено' : 'Нагадування вимкнено' });
    const { text, keyboard } = buildSettingsView();
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
    queries.setSetting(key, time);

    if (schedulerCallbacks.reloadJobs) {
      schedulerCallbacks.reloadJobs();
    }

    await ctx.answerCallbackQuery({ text: `Час встановлено на ${time}` });
    const { text, keyboard } = buildSettingsView();
    await ctx.editMessageText(`✅ Час успішно змінено на <b>${time}</b>!\n\n` + text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  });

  // Меню зміни денної цілі
  bot.callbackQuery('set_target_goal', async (ctx) => {
    const goals = [6000, 8000, 10000, 12000, 15000, 20000];
    const keyboard = new InlineKeyboard();

    goals.forEach((g, i) => {
      keyboard.text(`${formatNumber(g)} кр.`, `save_goal:${g}`);
      if ((i + 1) % 2 === 0) keyboard.row();
    });
    keyboard.row().text('⬅️ Назад', 'admin_refresh_settings');

    await ctx.answerCallbackQuery();
    await ctx.editMessageText('🎯 Оберіть нову денну ціль кроків для всієї команди:', {
      reply_markup: keyboard,
    });
  });

  bot.callbackQuery(/^save_goal:(\d+)$/, async (ctx) => {
    const goal = ctx.match[1];
    queries.setSetting('daily_goal', goal);

    await ctx.answerCallbackQuery({ text: `Ціль встановлено: ${formatNumber(goal)}` });
    const { text, keyboard } = buildSettingsView();
    await ctx.editMessageText(`✅ Денну ціль змінено на <b>${formatNumber(goal)}</b> кроків!\n\n` + text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  });

  // Ручний запуск відправки звіту в групу
  bot.callbackQuery('admin_trigger_report', async (ctx) => {
    const groupChatId = queries.getSetting('group_chat_id');
    if (!groupChatId) {
      await ctx.answerCallbackQuery({ text: 'Спочатку прив\'яжіть групу через /set_group!', show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery({ text: 'Надсилаю звіт у групу...' });
    const reportText = formatDailyReport();

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
    const today = getTodayDateString(queries.getSetting('timezone', 'Europe/Kyiv'));
    const missing = queries.getMissingUsersForDate(today);

    if (missing.length === 0) {
      return ctx.reply('🎉 Всі зареєстровані учасники вже надіслали свої результати за сьогодні!');
    }

    const groupChatId = queries.getSetting('group_chat_id');
    if (groupChatId) {
      try {
        const { formatGroupReminderMessage } = require('../services/leaderboard');
        const groupMsg = formatGroupReminderMessage(missing, today);
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
    const users = queries.getAllUsers();
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
