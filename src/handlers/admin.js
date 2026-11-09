const { InlineKeyboard } = require('grammy');
const { config } = require('../config');
const queries = require('../db/queries');
const { 
  formatDailyReport, 
  formatDailyPenaltyReport,
  formatMonthlyStatusReport, 
  formatBankReport, 
  formatReminderMessage, 
  formatGroupReminderMessage,
  escapeHtml 
} = require('../services/leaderboard');
const {
  formatNumber,
  getTodayDateString,
  getYesterdayDateString,
  formatUkrainianDate,
  resolveTargetDate,
} = require('../utils/date');
const {
  extractTopicName,
  getKnownTopics,
  saveKnownTopic,
  resolveTopicThreadId,
  formatTopicLabel,
} = require('../utils/topic');
const {
  DEFAULT_SHEET_ID,
  DEFAULT_SHEET_GID,
  runImport,
  syncAllUsersToSheet,
  syncUserStepsToSheet,
} = require('../services/google_sheet');

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
  const knownTopics = await getKnownTopics();
  const reminderTime = settings.reminder_time || '11:00';
  const deadlineTime = settings.deadline_time || '12:00';
  const reportTime = settings.report_time || '13:00';
  const dailyGoal = settings.daily_goal || '10000';
  const graceLimit = settings.grace_days_limit || '2';
  const penaltyAmount = settings.penalty_amount || '100';
  const remindersEnabled = settings.reminders_enabled !== '0';
  const reportsEnabled = settings.reports_enabled !== '0';
  const groupChatId = settings.group_chat_id;
  const stepsTopicId = settings.steps_topic_id;
  const reportsTopicId = settings.reports_topic_id || stepsTopicId;
  const penaltiesTopicId = settings.penalties_topic_id || reportsTopicId || stepsTopicId;
  const remindersTopicId = settings.reminders_topic_id || stepsTopicId || reportsTopicId;

  const sheetId = settings.google_sheet_id || DEFAULT_SHEET_ID;
  const sheetGid = settings.google_sheet_gid || DEFAULT_SHEET_GID;
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/edit?gid=${sheetGid}#gid=${sheetGid}`;
  const hasWriteAccess = Boolean((settings.google_script_url || config.googleScriptUrl || settings.google_service_account || config.googleServiceAccountJson || '').trim());

  const activeUsers = await queries.getAllActiveUsers();
  const totalBank = await queries.getAllPaymentsTotal();
  const jarUrl = settings.jar_url || 'https://send.monobank.ua/jar/6fwMYmHxM1';

  let text = `⚙️ <b>Панель налаштувань бота</b>\n\n`;
  text += `⏰ <b>Нагадування (за вчора):</b> <code>${reminderTime}</code> (${remindersEnabled ? '✅ Увімкнено' : '❌ Вимкнено'})\n`;
  text += `🕛 <b>Дедлайн прийому (за вчора):</b> <code>${deadlineTime}</code>\n`;
  text += `📊 <b>Звіт за вчора в чат:</b> <code>${reportTime}</code> (${reportsEnabled ? '✅ Увімкнено' : '❌ Вимкнено'})\n`;
  text += `🎯 <b>Щоденна норма:</b> <code>${formatNumber(dailyGoal)}</code> кроків\n`;
  text += `🛡️ <b>Пільгових днів:</b> <code>${graceLimit}</code> на місяць\n`;
  text += `💸 <b>Штраф:</b> <code>${penaltyAmount} грн</code> (з 3-го пропуску)\n`;
  text += `🏦 <b>Штрафна банка:</b> <code>${formatNumber(totalBank)} грн</code> (<a href="${jarUrl}">Monobank</a>)\n`;
  text += `👥 <b>Активних учасників:</b> ${activeUsers.length}\n`;
  text += `📗 <b>Google Таблиця:</b> <a href="${sheetUrl}">Відкрити таблицю</a> (${hasWriteAccess ? '✅ Автозапис увімкнено' : '📥 Читання / очікує скрипт запису'})\n`;
  text += `💬 <b>Груповий чат:</b> ${groupChatId ? `<code>ID: ${groupChatId}</code> ✅` : '⚠️ Не підключено (напишіть /set_group у групі)'}\n\n`;

  text += `<b>📌 Розподіл по гілках (темах):</b>\n`;
  text += `• 📸 <b>Скріни кроків:</b> ${escapeHtml(formatTopicLabel(stepsTopicId, knownTopics, 'Авто «скріни кроків»'))}\n`;
  text += `• 📊 <b>Щоденні звіти (${reportTime}):</b> ${escapeHtml(formatTopicLabel(reportsTopicId, knownTopics, 'У гілку скрінів'))}\n`;
  text += `• 💸 <b>Штрафи та банка:</b> ${escapeHtml(formatTopicLabel(penaltiesTopicId, knownTopics, 'Разом зі звітами'))}\n`;
  text += `• 🔔 <b>Нагадування (${reminderTime}):</b> ${escapeHtml(formatTopicLabel(remindersTopicId, knownTopics, 'У гілку скрінів'))}\n\n`;
  text += `Оберіть параметр для зміни:`;

  const keyboard = new InlineKeyboard()
    .text('📌 Налаштувати гілки (куди що слати)', 'admin_topics_menu')
    .row()
    .text('⏰ Час нагадування', 'set_time:reminder')
    .text('🕛 Час дедлайну', 'set_time:deadline')
    .text('📊 Час звіту', 'set_time:report')
    .row()
    .text('🎯 Денна норма', 'set_target_goal')
    .text(remindersEnabled ? '🔔 Вимкнути нагадування' : '🔕 Увімкнути нагадування', 'toggle_reminders')
    .row()
    .text('📢 Надіслати звіт зараз', 'admin_trigger_report')
    .text('👟 Розіслати нагадування зараз', 'admin_trigger_remind')
    .row()
    .text('🔄 Звірити з Google Таблицею', 'admin_import_sheet')
    .text('📗 Налаштувати запис у Таблицю', 'admin_sheet_help')
    .row()
    .text('🏦 Штрафна банка', 'admin_view_bank')
    .text('👥 Список колег', 'admin_view_users')
    .row()
    .text('🗑 Очистити базу перед стартом', 'admin_prompt_reset_data')
    .row()
    .text('🔄 Оновити', 'admin_refresh_settings');

  return { text, keyboard };
}

/**
 * Будує меню вибору гілок (куди що відправляти)
 */
async function buildTopicsSettingsView() {
  const settings = await queries.getAllSettings();
  const knownTopics = await getKnownTopics();
  const stepsTopicId = settings.steps_topic_id;
  const reportsTopicId = settings.reports_topic_id || stepsTopicId;
  const penaltiesTopicId = settings.penalties_topic_id || reportsTopicId || stepsTopicId;
  const remindersTopicId = settings.reminders_topic_id || stepsTopicId || reportsTopicId;
  const reminderTime = settings.reminder_time || '11:00';
  const reportTime = settings.report_time || '13:00';

  let text = `📌 <b>Налаштування гілок (тем) у групі</b>\n\n`;
  text += `Тут ви можете вказати, у якій гілці бот має сканувати фото (ставити 👍), а в яку — надсилати звіти, штрафи та нагадування.\n\n`;
  text += `📸 <b>Сканування скрінів:</b> ${escapeHtml(formatTopicLabel(stepsTopicId, knownTopics, 'Авто «скріни кроків»'))}\n`;
  text += `📊 <b>Щоденні звіти (${reportTime}):</b> ${escapeHtml(formatTopicLabel(reportsTopicId, knownTopics, 'У гілку скрінів'))}\n`;
  text += `💸 <b>Штрафи та банка:</b> ${escapeHtml(formatTopicLabel(penaltiesTopicId, knownTopics, 'Разом зі звітами'))}\n`;
  text += `🔔 <b>Нагадування (${reminderTime}):</b> ${escapeHtml(formatTopicLabel(remindersTopicId, knownTopics, 'У гілку скрінів'))}\n\n`;
  text += `💡 <i>Порада: ви також можете просто зайти в потрібну гілку групи і написати там <code>/set_topic</code> або <code>/set_group</code>!</i>\n\n`;
  text += `Оберіть, що саме змінити:`;

  const keyboard = new InlineKeyboard()
    .text('📸 Гілка для скрінів кроків', 'pick_topic:steps')
    .row()
    .text(`📊 Гілка для звітів (${reportTime})`, 'pick_topic:reports')
    .row()
    .text('💸 Гілка для штрафів та банки', 'pick_topic:penalties')
    .row()
    .text(`🔔 Гілка для нагадувань (${reminderTime})`, 'pick_topic:reminders')
    .row()
    .text('⬅️ Назад до налаштувань', 'admin_refresh_settings');

  return { text, keyboard };
}

function registerAdminHandlers(bot, schedulerCallbacks = {}) {
  // Команда /set_group та /set_topic — прив'язка нової групи, авто-звірка з Google Таблицею та вибір призначення гілки
  bot.command(['set_group', 'set_topic'], async (ctx) => {
    if (ctx.chat.type === 'private') {
      return ctx.reply('⚠️ Цю команду потрібно викликати <b>всередині потрібної гілки</b> вашої робочої групи (або скористайтеся /settings -> 📌 Налаштувати гілки)!', {
        parse_mode: 'HTML',
      });
    }

    const permitted = await isAdmin(ctx);
    if (!permitted) {
      return ctx.reply('⛔️ Тільки адміністратор може налаштовувати гілки групи.');
    }

    const groupId = String(ctx.chat.id);
    const prevGroupId = await queries.getSetting('group_chat_id', '');
    await queries.setSetting('group_chat_id', groupId);

    // Якщо підключили новий чат — очищуємо старі збережені ID гілок від попереднього чату
    if (prevGroupId && prevGroupId !== groupId) {
      await queries.setSetting('steps_topic_id', '');
      await queries.setSetting('reports_topic_id', '');
      await queries.setSetting('penalties_topic_id', '');
      await queries.setSetting('reminders_topic_id', '');
      await queries.setSetting('known_topics', '{}');
    }

    const threadId = ctx.message?.message_thread_id ? String(ctx.message.message_thread_id) : 'general';
    const topicName = extractTopicName(ctx);
    if (threadId !== 'general') {
      await saveKnownTopic(threadId, topicName);
    }

    // Одразу прив'язуємо поточну гілку для сканування скрінів за замовчуванням (навіть якщо не натиснули кнопку)
    await queries.setSetting('steps_topic_id', threadId);

    // Автоматично синхронізуємо та звіряємо дані з Google Таблицею при підключенні до чату
    runImport().catch(err => console.warn('[AutoSync] Помилка звірки при /set_group:', err.message));

    const knownTopics = await getKnownTopics();
    const currentLabel = formatTopicLabel(threadId, knownTopics, 'Поточна гілка');

    const keyboard = new InlineKeyboard()
      .text('📸 Сканувати скріни кроків тут', `bind_here:steps:${threadId}`)
      .row()
      .text('📊 + 💸 Звіти ТА штрафи сюди', `bind_here:reports_penalties:${threadId}`)
      .row()
      .text('📊 Тільки звіти сюди', `bind_here:reports:${threadId}`)
      .text('💸 Тільки штрафи сюди', `bind_here:penalties:${threadId}`)
      .row()
      .text('🔔 Нагадування (11:00) сюди', `bind_here:reminders:${threadId}`)
      .row()
      .text('✅ Усе разом у цій гілці', `bind_here:all:${threadId}`);

    await ctx.reply(
      `📌 <b>Налаштування гілки:</b> ${escapeHtml(currentLabel)}\n\n` +
      `✅ Групу підключено та запущено звірку з Google Таблицею!\n` +
      `💡 <i>Щоб бот проаналізував скріни за попередні дні, які були надіслані до його додавання в чат, просто виділіть їх і перешліть (Forward) боту або сюди в гілку скрінів (або дайте відповідь <code>/scan</code> на фото).</i>\n\n` +
      `Оберіть кнопкою нижче, що саме бот має робити в цій гілці:`,
      {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      }
    );
  });

  // Команда /set_sheet — зміна посилання на Google Таблицю
  bot.command('set_sheet', async (ctx) => {
    const permitted = await isAdmin(ctx);
    if (!permitted) {
      return ctx.reply('⛔️ Тільки адміністратор може змінювати посилання на Google Таблицю.');
    }

    const args = ctx.message.text.split(/\s+/).slice(1);
    if (args.length === 0) {
      const sheetId = await queries.getSetting('google_sheet_id', DEFAULT_SHEET_ID);
      const gid = await queries.getSetting('google_sheet_gid', DEFAULT_SHEET_GID);
      return ctx.reply(
        `📗 <b>Поточна Google Таблиця:</b>\n` +
        `https://docs.google.com/spreadsheets/d/${sheetId}/edit?gid=${gid}#gid=${gid}\n\n` +
        `Щоб змінити таблицю, надішліть:\n<code>/set_sheet [посилання на таблицю]</code>`,
        { parse_mode: 'HTML' }
      );
    }

    const url = args[0].trim();
    const idMatch = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    const gidMatch = url.match(/[?&]gid=(\d+)/) || url.match(/#gid=(\d+)/);

    if (!idMatch) {
      return ctx.reply('⚠️ Не вдалося розпізнати ID Google Таблиці у посиланні.');
    }

    const newSheetId = idMatch[1];
    const newGid = gidMatch ? gidMatch[1] : '0';

    await queries.setSetting('google_sheet_id', newSheetId);
    await queries.setSetting('google_sheet_gid', newGid);

    const statusMsg = await ctx.reply('⏳ Таблицю оновлено! Запускаю звірку даних...');
    try {
      const res = await runImport();
      await ctx.api.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        `✅ <b>Google Таблицю успішно підключено та звірено!</b>\n\n` +
        `👥 Учасників у таблиці: <b>${res.totalUsersProcessed}</b>\n` +
        `👟 Записів кроків синхронізовано: <b>${res.totalStepsImported}</b>`,
        { parse_mode: 'HTML' }
      );
    } catch (err) {
      await ctx.reply(`❌ Помилка синхронізації: ${escapeHtml(err.message)}`);
    }
  });

  // Команда /set_sheet_url — підключення Google Apps Script Web App URL для автоматичного запису в таблицю
  bot.command(['set_sheet_url', 'set_script_url'], async (ctx) => {
    const permitted = await isAdmin(ctx);
    if (!permitted) {
      return ctx.reply('⛔️ Тільки адміністратор може налаштовувати запис у Google Таблицю.');
    }

    const args = ctx.message.text.split(/\s+/).slice(1);
    if (args.length === 0) {
      const current = await queries.getSetting('google_script_url', config.googleScriptUrl || '');
      return ctx.reply(
        `📗 <b>Автоматичний запис у Google Таблицю:</b>\n` +
        `Статус: ${current ? `✅ Підключено (<code>${escapeHtml(current)}</code>)` : '⚠️ Ще не вказано URL скрипта'}\n\n` +
        `<b>Як увімкнути запис у таблицю за 1 хвилину:</b>\n` +
        `1. Відкрийте вашу Google Таблицю -> меню <b>Розширення -> Apps Script</b>.\n` +
        `2. Вставте код із файлу <code>scripts/google_apps_script.gs</code> та натисніть 💾.\n` +
        `3. Натисніть <b>Розгорнути -> Нове розгортання -> Веб-додаток</b> (Доступ: <b>Усі / Anyone</b>).\n` +
        `4. Надішліть отриманий URL сюди:\n` +
        `<code>/set_sheet_url https://script.google.com/macros/s/.../exec</code>`,
        { parse_mode: 'HTML' }
      );
    }

    const scriptUrl = args[0].trim();
    if (!scriptUrl.startsWith('https://script.google.com/')) {
      return ctx.reply('⚠️ Посилання має починатися з <code>https://script.google.com/macros/s/.../exec</code>', {
        parse_mode: 'HTML',
      });
    }

    await queries.setSetting('google_script_url', scriptUrl);
    const statusMsg = await ctx.reply('⏳ Перевіряю з\'єднання та вивантажую актуальні дані й штрафи в Google Таблицю...');
    try {
      const pushRes = await syncAllUsersToSheet();
      await ctx.api.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        `✅ <b>Автоматичний запис у Google Таблицю успішно підключено!</b>\n\n` +
        `Тепер кожен надісланий скріншот, ручне введення та фіксація штрафів о 12:00 миттєво записуються прямо у вашу Google Таблицю! 🚀`,
        { parse_mode: 'HTML' }
      );
    } catch (err) {
      await ctx.reply(`⚠️ URL збережено, але виникла помилка при тестовому записі: ${escapeHtml(err.message)}`);
    }
  });

  // Команда /sync — синхронізація учасників чату та таблиці
  bot.command(['sync', 'sync_members'], async (ctx) => {
    const permitted = await isAdmin(ctx);
    if (!permitted) {
      return ctx.reply('⛔️ Тільки адміністратор може виконувати синхронізацію.');
    }

    await runImport();
    const activeUsers = await queries.getAllActiveUsers();
    await ctx.reply(
      `✅ <b>Синхронізацію учасників та звірку з Google Таблицею виконано!</b>\n\n` +
      `• Активних учасників у челенджі: <b>${activeUsers.length}</b>\n\n` +
      `<i>Усі учасники з таблиці активовані. Коли вони надсилають скріншоти в групу, їхній Telegram ID автоматично прив'язується до їхнього профілю.</i>`,
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

  // Команда /set_start або /join_date — дата старту для учасників, які доєдналися до челенджу пізніше
  // Формат: /set_start @username 05.11 або у відповідь на повідомлення: /set_start 05.11
  bot.command(['set_start', 'join_date', 'start_date'], async (ctx) => {
    const permitted = await isAdmin(ctx);
    if (!permitted) {
      return ctx.reply('⛔️ Тільки адміністратор може змінювати дату старту учасників.');
    }

    const args = ctx.message.text.split(/\s+/).slice(1);
    const tz = await queries.getSetting('timezone', 'Europe/Kyiv');

    let targetUser = null;
    let targetDate = null;

    if (ctx.message.reply_to_message?.from) {
      const replyUser = ctx.message.reply_to_message.from;
      targetUser = await queries.getUser(replyUser.id);
      if (!targetUser) {
        await queries.upsertUser(replyUser.id, replyUser.first_name, replyUser.username);
        targetUser = await queries.getUser(replyUser.id);
      }
      if (args.length >= 1) {
        targetDate = resolveTargetDate(args[0], tz);
      }
    } else {
      if (args.length < 2) {
        return ctx.reply(
          '⚠️ <b>Формат команди дати старту:</b>\n\n' +
          '• <code>/set_start @username 05.11</code> — встановити дату старту (наприклад, 5 листопада)\n' +
          '• Або дайте відповідь (reply) на повідомлення учасника: <code>/set_start 05.11</code>',
          { parse_mode: 'HTML' }
        );
      }

      const identifier = args[0];
      targetUser = await queries.findUserByHandleOrId(identifier);
      if (!targetUser) {
        return ctx.reply(`⚠️ Користувача <code>${escapeHtml(identifier)}</code> не знайдено в базі.`);
      }
      targetDate = resolveTargetDate(args[1], tz);
    }

    if (!targetDate) {
      return ctx.reply('⚠️ Вкажіть коректну дату (наприклад: <code>05.11</code> або <code>2026-11-05</code>).');
    }

    const createdAtStr = `${targetDate} 00:00:00`;
    await queries.setUserCreatedAt(targetUser.id, createdAtStr);

    // Синхронізуємо оновлені штрафи/пільги з Google Таблицею
    syncAllUsersToSheet().catch(err => console.warn('Помилка синхронізації після set_start:', err.message));

    const name = targetUser.first_name ? escapeHtml(targetUser.first_name) : (targetUser.username ? `@${escapeHtml(targetUser.username)}` : 'Учаснику');
    await ctx.reply(
      `✅ <b>Дату старту в челенджі оновлено!</b>\n\n` +
      `👤 Учасник: <b>${name}</b>\n` +
      `📅 Дата старту: <b>${escapeHtml(formatUkrainianDate(targetDate))}</b>\n\n` +
      `<i>Усі дні до цієї дати тепер не вважаються пропусками і не штрафуються. Google Таблицю оновлено!</i> 🎉`,
      { parse_mode: 'HTML' }
    );
  });

  // Команда /excuse — відмітити день як поважну причину (не штрафується, наприклад лікарняний)
  bot.command(['excuse', 'forgive'], async (ctx) => {
    const permitted = await isAdmin(ctx);
    if (!permitted) {
      return ctx.reply('⛔️ Тільки адміністратор може вибачати пропуски.');
    }

    const args = ctx.message.text.split(/\s+/).slice(1);
    const tz = await queries.getSetting('timezone', 'Europe/Kyiv');
    const today = getTodayDateString(tz);

    let targetUser = null;
    let targetDate = today;
    let reason = 'Поважна причина';

    if (ctx.message.reply_to_message?.from) {
      const replyUser = ctx.message.reply_to_message.from;
      targetUser = await queries.getUser(replyUser.id);
      if (args.length >= 1) targetDate = resolveTargetDate(args[0], tz);
      if (args.length >= 2) reason = args.slice(1).join(' ');
    } else {
      if (args.length < 2) {
        return ctx.reply(
          '⚠️ <b>Формат команди:</b>\n\n' +
          '• <code>/excuse @username 06.11 Лікарняний</code>\n' +
          '• Або дайте відповідь на повідомлення: <code>/excuse 06.11 Лікарняний</code>',
          { parse_mode: 'HTML' }
        );
      }
      targetUser = await queries.findUserByHandleOrId(args[0]);
      if (!targetUser) {
        return ctx.reply(`⚠️ Користувача <code>${escapeHtml(args[0])}</code> не знайдено.`);
      }
      targetDate = resolveTargetDate(args[1], tz);
      if (args.length >= 3) reason = args.slice(2).join(' ');
    }

    const existingSteps = await queries.getUserStepsForDate(targetUser.id, targetDate);
    const stepsCount = existingSteps ? existingSteps.steps : 0;
    await queries.saveDailySteps(targetUser.id, targetDate, stepsCount, 'admin', `не штрафується (${reason})`);
    syncAllUsersToSheet().catch(err => console.warn('Помилка синхронізації після excuse:', err.message));

    const name = targetUser.first_name ? escapeHtml(targetUser.first_name) : (targetUser.username ? `@${escapeHtml(targetUser.username)}` : 'Учаснику');
    await ctx.reply(
      `🛡️ <b>День відмічено як поважну причину!</b>\n\n` +
      `👤 Учасник: <b>${name}</b>\n` +
      `📅 Дата: <b>${escapeHtml(formatUkrainianDate(targetDate))}</b>\n` +
      `📝 Причина: <i>${escapeHtml(reason)}</i>\n\n` +
      `<i>Цей день не враховується як пропуск і не штрафується.</i>`,
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

  // Команда /report — ручний виклик звіту (за замовчуванням за вчора, або /report 8, /report сьогодні)
  bot.command('report', async (ctx) => {
    const permitted = await isAdmin(ctx);
    if (!permitted) {
      return ctx.reply('⛔️ Тільки адміністратор може ініціювати публікацію звіту.');
    }

    const args = ctx.message.text.split(/\s+/).slice(1);
    const tz = await queries.getSetting('timezone', 'Europe/Kyiv');
    const targetDate = resolveTargetDate(args[0], tz, true);
    const reportText = await formatDailyReport(targetDate);
    await ctx.reply(reportText, { parse_mode: 'HTML' });
  });

  // Команда /import або /sync_sheet — двостороння синхронізація та звірка з Google Таблицею
  bot.command(['import', 'sync_sheet'], async (ctx) => {
    const permitted = await isAdmin(ctx);
    if (!permitted) {
      return ctx.reply('⛔️ Тільки адміністратор може запускати імпорт.');
    }

    const statusMsg = await ctx.reply('⏳ Звіряю дані з Google Таблицею та синхронізую базу...');
    try {
      const res = await runImport();
      const users = await queries.getAllActiveUsers();
      const resultText = 
        `✅ <b>Дані успішно звірено та синхронізовано з Google Таблицею!</b>\n\n` +
        `👥 Активних учасників у базі: <b>${users.length}</b>\n` +
        `👟 Записів кроків з таблиці: <b>${res.totalStepsImported}</b>\n` +
        `📊 Тепер напишіть:\n` +
        `• <code>/status</code> — загальний стан команди за місяць\n` +
        `• <code>/report</code> — звіт за вчора\n` +
        `• <code>/report 5</code> — звіт за 5-те число`;

      try {
        await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, resultText, { parse_mode: 'HTML' });
      } catch {
        await ctx.reply(resultText, { parse_mode: 'HTML' });
      }
    } catch (err) {
      const errText = `❌ Помилка синхронізації: ${escapeHtml(err.message)}`;
      try {
        await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, errText);
      } catch {
        await ctx.reply(errText);
      }
    }
  });

  // Команда /bank — стан штрафної банки
  bot.command('bank', async (ctx) => {
    const text = await formatBankReport();
    await ctx.reply(text, { parse_mode: 'HTML' });
  });

  // Команда /set — ручне встановлення кроків учасника адміном
  // Формат: /set @username 12000 [дата] або /set 12000 у відповідь на повідомлення
  bot.command('set', async (ctx) => {
    const permitted = await isAdmin(ctx);
    if (!permitted) {
      return ctx.reply('⛔️ Тільки адміністратор може коригувати кроки учасників.');
    }

    const rawArgs = ctx.message.text.trim().split(/\s+/).slice(1);
    const replyMsg = !ctx.message.reply_to_message?.forum_topic_created ? ctx.message.reply_to_message : null;
    const tz = await queries.getSetting('timezone', 'Europe/Kyiv');
    const today = getTodayDateString(tz);

    let targetUser = null;
    let steps = null;
    let targetDate = today;

    // Шукаємо явно вказаний @username або ім'я в аргументах
    let usernameArg = null;
    let stepArg = null;
    let dateArg = null;

    for (const a of rawArgs) {
      if (!usernameArg && a.startsWith('@')) {
        usernameArg = a.replace(/^@/, '');
      } else if (stepArg === null && /^\d{2,6}$/.test(a.replace(/[\s,]/g, '')) && Number(a.replace(/[\s,]/g, '')) <= 150000) {
        stepArg = Number(a.replace(/[\s,]/g, ''));
      } else if (!dateArg && /(\d{1,2}\.\d{1,2}|\d{4}-\d{2}-\d{2})/.test(a)) {
        dateArg = a;
      }
    }

    // Якщо нікнейм без @ першим словом (наприклад: /set username 10500)
    if (!usernameArg && rawArgs.length >= 2 && isNaN(Number(rawArgs[0].replace(/\D/g, '')))) {
      usernameArg = rawArgs[0];
      if (stepArg === null && rawArgs[1]) {
        stepArg = Number(rawArgs[1].replace(/\D/g, ''));
      }
      if (!dateArg && rawArgs[2]) {
        dateArg = rawArgs[2];
      }
    }

    if (usernameArg) {
      targetUser = await queries.findUserByHandleOrId(usernameArg);
      if (!targetUser) {
        return ctx.reply(`⚠️ Користувача <code>${escapeHtml(usernameArg)}</code> не знайдено в базі бота.`, {
          parse_mode: 'HTML',
        });
      }
    } else if (replyMsg?.from) {
      const replyUser = replyMsg.from;
      targetUser = await queries.getUser(replyUser.id);
      if (!targetUser) {
        await queries.upsertUser(replyUser.id, replyUser.first_name, replyUser.username);
        targetUser = await queries.getUser(replyUser.id);
      }
      if (stepArg === null && rawArgs.length >= 1) {
        stepArg = Number(rawArgs[0].replace(/\D/g, ''));
      }
      if (!dateArg && rawArgs.length >= 2) {
        dateArg = rawArgs[1];
      }
    }

    if (!targetUser) {
      return ctx.reply(
        '⚠️ <b>Формат команди /set:</b>\n\n' +
        '• <code>/set @username 10500</code> — встановити кроки за сьогодні\n' +
        '• <code>/set @username 10500 08.11</code> — встановити за конкретну дату (або число місяця)\n' +
        '• Або дайте відповідь (reply) на повідомлення учасника командою: <code>/set 10500</code>',
        { parse_mode: 'HTML' }
      );
    }

    if (dateArg) {
      targetDate = resolveTargetDate(dateArg, tz);
    }
    steps = stepArg;

    if (steps === null || isNaN(steps) || steps < 0 || steps > 150000) {
      return ctx.reply('⚠️ Вкажіть коректне число кроків від 0 до 150 000.', { parse_mode: 'HTML' });
    }

    await queries.saveDailySteps(targetUser.id, targetDate, steps, 'admin', `Встановлено адміном @${ctx.from.username || ctx.from.id}`);
    await syncUserStepsToSheet(targetUser.id, targetDate, steps);

    const name = targetUser.first_name ? escapeHtml(targetUser.first_name) : (targetUser.username ? `@${escapeHtml(targetUser.username)}` : 'Колезі');
    await ctx.reply(
      `✅ <b>Успішно оновлено (база + Google Таблиця)!</b>\n\n` +
      `👤 Учасник: <b>${name}</b>\n` +
      `📅 Дата: <b>${escapeHtml(formatUkrainianDate(targetDate))}</b>\n` +
      `👟 Кроки: <b>${formatNumber(steps)}</b>`,
      { parse_mode: 'HTML' }
    );
  });

  // Команда /paid — фіксація сплати штрафу
  bot.command('paid', async (ctx) => {
    const permitted = await isAdmin(ctx);
    if (!permitted) {
      return ctx.reply('⛔️ Тільки адміністратор може відмічати оплату штрафів.');
    }

    const rawArgs = ctx.message.text.trim().split(/\s+/).slice(1);
    const replyMsg = !ctx.message.reply_to_message?.forum_topic_created ? ctx.message.reply_to_message : null;

    let targetUser = null;
    let amount = null;
    let notes = '';

    // Шукаємо аргументи: нікнейм, сума та коментар
    let usernameArg = null;
    let amountArg = null;
    const notesArr = [];

    for (const a of rawArgs) {
      if (!usernameArg && a.startsWith('@')) {
        usernameArg = a.replace(/^@/, '');
      } else if (amountArg === null && /^\d+$/.test(a.replace(/[,\s]/g, ''))) {
        amountArg = Number(a.replace(/[,\s]/g, ''));
      } else {
        notesArr.push(a);
      }
    }

    // Якщо нікнейм без @ першим словом (наприклад: /paid vinskevych 500)
    if (!usernameArg && rawArgs.length >= 2 && isNaN(Number(rawArgs[0].replace(/\D/g, '')))) {
      usernameArg = rawArgs[0];
      if (amountArg === null && rawArgs[1] && !isNaN(Number(rawArgs[1].replace(/\D/g, '')))) {
        amountArg = Number(rawArgs[1].replace(/\D/g, ''));
        notesArr.shift();
      }
    }

    amount = amountArg;
    notes = notesArr.join(' ');

    if (usernameArg) {
      targetUser = await queries.findUserByHandleOrId(usernameArg);
      if (!targetUser) {
        return ctx.reply(`⚠️ Користувача <code>${escapeHtml(usernameArg)}</code> не знайдено в базі бота.`, {
          parse_mode: 'HTML',
        });
      }
    } else if (replyMsg?.from) {
      const replyUser = replyMsg.from;
      targetUser = await queries.getUser(replyUser.id);
      if (!targetUser) {
        await queries.upsertUser(replyUser.id, replyUser.first_name, replyUser.username);
        targetUser = await queries.getUser(replyUser.id);
      }
    }

    if (!targetUser) {
      return ctx.reply(
        '⚠️ <b>Формат команди /paid:</b>\n\n' +
        '• <code>/paid @username 100</code> — зарахувати 100 грн у банку\n' +
        '• <code>/paid @username 200 Monobank</code> — з коментарем\n' +
        '• Або дайте відповідь (reply) на повідомлення боржника: <code>/paid 100</code>',
        { parse_mode: 'HTML' }
      );
    }

    if (!amount || isNaN(amount) || amount <= 0) {
      return ctx.reply('⚠️ Вкажіть коректну суму оплати в гривнях (наприклад: <code>/paid @username 100</code>).', {
        parse_mode: 'HTML',
      });
    }

    await queries.addPenaltyPayment(targetUser.id, amount, ctx.from.id, notes);

    const tz = await queries.getSetting('timezone', 'Europe/Kyiv');
    const today = getTodayDateString(tz);
    const monthStats = await queries.getUserMonthStats(targetUser.id, today.slice(0, 7), today);
    const totalBank = await queries.getAllPaymentsTotal();

    const name = targetUser.first_name ? escapeHtml(targetUser.first_name) : (targetUser.username ? `@${escapeHtml(targetUser.username)}` : 'Учасник');

    const payMsg =
      `💰 <b>Оплату зафіксовано!</b>\n\n` +
      `👤 Платник: <b>${name}</b>\n` +
      `💵 Сума: <b>+${formatNumber(amount)} грн</b>${notes ? ` (<i>${escapeHtml(notes)}</i>)` : ''}\n` +
      `💳 Залишок боргу учасника: <b>${formatNumber(monthStats.currentDebt)} грн</b>\n` +
      `🏦 Всього коштів у штрафній банці: <b>${formatNumber(totalBank)} грн</b> 🎉`;

    await ctx.reply(payMsg, { parse_mode: 'HTML' });

    const groupChatId = await queries.getSetting('group_chat_id');
    const penaltiesThreadId = await resolveTopicThreadId('penalties');
    const currentThreadId = ctx.message?.message_thread_id;
    if (groupChatId && penaltiesThreadId && String(currentThreadId || '') !== String(penaltiesThreadId)) {
      try {
        await bot.api.sendMessage(groupChatId, payMsg, {
          parse_mode: 'HTML',
          message_thread_id: penaltiesThreadId,
        });
      } catch {}
    }
  });

  // Обробка інлайн-кнопок швидкої прив'язки поточної гілки (/set_topic або /set_group)
  bot.callbackQuery(/^bind_here:(steps|reports|penalties|reminders|reports_penalties|all):(.+)$/, async (ctx) => {
    const permitted = await isAdmin(ctx);
    if (!permitted) {
      return ctx.answerCallbackQuery({ text: 'Тільки адміністратор може змінювати налаштування!', show_alert: true });
    }

    const mode = ctx.match[1];
    const threadId = ctx.match[2];

    if (ctx.chat && ctx.chat.type !== 'private') {
      await queries.setSetting('group_chat_id', String(ctx.chat.id));
    }

    let actionDesc = '';
    if (mode === 'steps') {
      await queries.setSetting('steps_topic_id', threadId);
      actionDesc = '📸 Цю гілку призначено для <b>сканування скрінів кроків</b>!';
    } else if (mode === 'reports') {
      await queries.setSetting('reports_topic_id', threadId);
      actionDesc = '📊 Цю гілку призначено для <b>публікації щоденних звітів (13:00)</b>!';
    } else if (mode === 'penalties') {
      await queries.setSetting('penalties_topic_id', threadId);
      actionDesc = '💸 Цю гілку призначено для <b>публікації штрафів та стану банки</b>!';
    } else if (mode === 'reminders') {
      await queries.setSetting('reminders_topic_id', threadId);
      actionDesc = '🔔 Цю гілку призначено для <b>щоденних нагадувань (11:00)</b>!';
    } else if (mode === 'reports_penalties') {
      await queries.setSetting('reports_topic_id', threadId);
      await queries.setSetting('penalties_topic_id', threadId);
      actionDesc = '📊 + 💸 Цю гілку призначено для <b>щоденних звітів та штрафів</b>!';
    } else if (mode === 'all') {
      await queries.setSetting('steps_topic_id', threadId);
      await queries.setSetting('reports_topic_id', threadId);
      await queries.setSetting('penalties_topic_id', threadId);
      await queries.setSetting('reminders_topic_id', threadId);
      actionDesc = '✅ Цю гілку призначено для <b>всіх дій бота</b> (скріни, звіти, штрафи та нагадування)!';
    }

    const knownTopics = await getKnownTopics();
    const settings = await queries.getAllSettings();
    const summary =
      `${actionDesc}\n\n` +
      `<b>Поточний розподіл по гілках:</b>\n` +
      `• 📸 Скріни: ${escapeHtml(formatTopicLabel(settings.steps_topic_id, knownTopics, 'Авто «скріни кроків»'))}\n` +
      `• 📊 Звіти (13:00): ${escapeHtml(formatTopicLabel(settings.reports_topic_id || settings.steps_topic_id, knownTopics, 'У гілку скрінів'))}\n` +
      `• 💸 Штрафи: ${escapeHtml(formatTopicLabel(settings.penalties_topic_id || settings.reports_topic_id || settings.steps_topic_id, knownTopics, 'Разом зі звітами'))}\n` +
      `• 🔔 Нагадування (11:00): ${escapeHtml(formatTopicLabel(settings.reminders_topic_id || settings.steps_topic_id, knownTopics, 'У гілку скрінів'))}`;

    await ctx.answerCallbackQuery({ text: 'Налаштування збережено!' });
    try {
      await ctx.editMessageText(summary, {
        parse_mode: 'HTML',
        reply_markup: ctx.callbackQuery.message?.reply_markup,
      });
    } catch {}
  });

  // Меню налаштування гілок у /settings
  bot.callbackQuery('admin_topics_menu', async (ctx) => {
    const permitted = await isAdmin(ctx);
    if (!permitted) {
      return ctx.answerCallbackQuery({ text: 'Немає доступу!', show_alert: true });
    }
    await ctx.answerCallbackQuery();
    const { text, keyboard } = await buildTopicsSettingsView();
    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  });

  // Інструкція з підключення автозапису в Google Таблицю
  bot.callbackQuery('admin_sheet_help', async (ctx) => {
    const permitted = await isAdmin(ctx);
    if (!permitted) {
      return ctx.answerCallbackQuery({ text: 'Немає доступу!', show_alert: true });
    }
    await ctx.answerCallbackQuery();
    const currentUrl = await queries.getSetting('google_script_url', config.googleScriptUrl || '');
    const sheetId = await queries.getSetting('google_sheet_id', DEFAULT_SHEET_ID);
    const sheetGid = await queries.getSetting('google_sheet_gid', DEFAULT_SHEET_GID);
    const sheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/edit?gid=${sheetGid}#gid=${sheetGid}`;

    const text =
      `📗 <b>Підключення автоматичного запису в Google Таблицю</b>\n\n` +
      `Поточна таблиця: <a href="${sheetUrl}">Листопад кроки</a>\n` +
      `Статус запису: ${currentUrl ? `✅ <b>Підключено</b>` : '⚠️ <b>Очікує URL веб-додатку Apps Script</b>'}\n\n` +
      `Щоб бот сам автоматично вписував кроки та штрафні дні (<code>0/2</code>, <code>1/2</code>...) прямо в клітинки таблиці:\n` +
      `1️⃣ Відкрийте таблицю за посиланням вище.\n` +
      `2️⃣ Натисніть у верхньому меню: <b>Розширення (Extensions) -> Apps Script</b>.\n` +
      `3️⃣ Вставте туди код із файлу <code>scripts/google_apps_script.gs</code> та натисніть 💾 (Зберегти).\n` +
      `4️⃣ Натисніть синю кнопку <b>Розгорнути -> Нове розгортання -> Веб-додаток</b>.\n` +
      `5️⃣ У полі «Хто має доступ» оберіть <b>Усі (Anyone)</b>, натисніть «Розгорнути» та скопіюйте URL.\n` +
      `6️⃣ Надішліть боту команду:\n` +
      `<code>/set_sheet_url https://script.google.com/macros/s/.../exec</code>`;

    const keyboard = new InlineKeyboard().text('⬅️ Назад до налаштувань', 'admin_refresh_settings');
    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  });

  // Вибір конкретної гілки для ролі (steps | reports | penalties | reminders)
  bot.callbackQuery(/^pick_topic:(steps|reports|penalties|reminders)$/, async (ctx) => {
    const permitted = await isAdmin(ctx);
    if (!permitted) {
      return ctx.answerCallbackQuery({ text: 'Немає доступу!', show_alert: true });
    }

    const role = ctx.match[1];
    const roleTitles = {
      steps: '📸 сканування скрінів кроків',
      reports: '📊 щоденних звітів (13:00)',
      penalties: '💸 штрафів та штрафної банки',
      reminders: '🔔 нагадувань (11:00)',
    };

    const knownTopics = await getKnownTopics();
    const keyboard = new InlineKeyboard();

    const entries = Object.entries(knownTopics);
    for (const [tid, tName] of entries) {
      keyboard.text(`📌 ${tName} (ID: ${tid})`, `save_topic:${role}:${tid}`).row();
    }

    keyboard.text('💬 Основний чат (General)', `save_topic:${role}:general`).row();
    if (role !== 'steps') {
      keyboard.text('🔄 Як у гілці скрінів (за замовчуванням)', `save_topic:${role}:default`).row();
    }
    keyboard.text('⬅️ Назад до меню гілок', 'admin_topics_menu');

    let hint = `📌 Оберіть гілку для <b>${roleTitles[role]}</b>:\n\n`;
    if (entries.length === 0) {
      hint += `<i>Поки що бот не бачив повідомлень в інших гілках. Напишіть будь-яке повідомлення або команду <code>/set_topic</code> у потрібній гілці групи, і вона з'явиться тут у списку!</i>`;
    } else {
      hint += `<i>Якщо потрібної гілки ще немає у списку — напишіть у ній <code>/set_topic</code>.</i>`;
    }

    await ctx.answerCallbackQuery();
    await ctx.editMessageText(hint, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  });

  // Збереження обраної гілки з меню /settings
  bot.callbackQuery(/^save_topic:(steps|reports|penalties|reminders):(.+)$/, async (ctx) => {
    const permitted = await isAdmin(ctx);
    if (!permitted) {
      return ctx.answerCallbackQuery({ text: 'Немає доступу!', show_alert: true });
    }

    const role = ctx.match[1];
    const val = ctx.match[2] === 'default' ? '' : ctx.match[2];
    const settingKeyMap = {
      steps: 'steps_topic_id',
      reports: 'reports_topic_id',
      penalties: 'penalties_topic_id',
      reminders: 'reminders_topic_id',
    };

    await queries.setSetting(settingKeyMap[role], val);
    await ctx.answerCallbackQuery({ text: 'Гілку збережено!' });

    const { text, keyboard } = await buildTopicsSettingsView();
    await ctx.editMessageText(`✅ Налаштування гілки оновлено!\n\n` + text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
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

  // Вибір часу для нагадувань, дедлайну або звіту
  bot.callbackQuery(/^set_time:(reminder|deadline|report)$/, async (ctx) => {
    const type = ctx.match[1];
    const titles = {
      reminder: 'ранкових нагадувань за вчора (рекомендовано 11:00)',
      deadline: 'дедлайну прийому скрінів за вчора (рекомендовано 12:00)',
      report: 'публікації звіту за вчора (рекомендовано 13:00)',
    };

    const times = ['10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '14:00'];
    const keyboard = new InlineKeyboard();

    times.forEach((t, i) => {
      keyboard.text(t, `save_time:${type}:${t}`);
      if ((i + 1) % 3 === 0) keyboard.row();
    });
    keyboard.row().text('⬅️ Назад', 'admin_refresh_settings');

    await ctx.answerCallbackQuery();
    await ctx.editMessageText(`⏰ Оберіть час для <b>${titles[type]}</b>:`, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  });

  // Збереження обраного часу
  bot.callbackQuery(/^save_time:(reminder|deadline|report):([\d:]+)$/, async (ctx) => {
    const type = ctx.match[1];
    const time = ctx.match[2];

    const keyMap = {
      reminder: 'reminder_time',
      deadline: 'deadline_time',
      report: 'report_time',
    };
    await queries.setSetting(keyMap[type], time);

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

  // Ручний запуск відправки звіту (за вчора) в групу
  bot.callbackQuery('admin_trigger_report', async (ctx) => {
    const groupChatId = await queries.getSetting('group_chat_id');
    if (!groupChatId) {
      await ctx.answerCallbackQuery({ text: 'Спочатку прив\'яжіть групу через /set_group!', show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery({ text: 'Надсилаю звіт за вчора у групу...' });
    const tz = await queries.getSetting('timezone', 'Europe/Kyiv');
    const yesterday = getYesterdayDateString(tz);
    const reportsThreadId = await resolveTopicThreadId('reports');
    const penaltiesThreadId = await resolveTopicThreadId('penalties');
    const reportText = await formatDailyReport(yesterday);

    try {
      const sendOpts = { parse_mode: 'HTML' };
      if (reportsThreadId) {
        sendOpts.message_thread_id = reportsThreadId;
      }
      await bot.api.sendMessage(groupChatId, reportText, sendOpts);

      if (penaltiesThreadId !== reportsThreadId) {
        const penaltyText = await formatDailyPenaltyReport(yesterday);
        const penOpts = { parse_mode: 'HTML' };
        if (penaltiesThreadId) {
          penOpts.message_thread_id = penaltiesThreadId;
        }
        await bot.api.sendMessage(groupChatId, penaltyText, penOpts);
      }

      await ctx.reply(`✅ Звіт за ${formatUkrainianDate(yesterday)} успішно надіслано у налаштовану гілку!`);
    } catch (err) {
      console.error('Помилка відправки звіту в групу:', err);
      await ctx.reply(`❌ Не вдалося надіслати повідомлення в групу: ${err.message}. Переконайтеся, що бот доданий у групу як адміністратор.`);
    }
  });

  // Ручний запуск розсилки нагадувань (за вчора)
  bot.callbackQuery('admin_trigger_remind', async (ctx) => {
    await ctx.answerCallbackQuery({ text: 'Розсилаю нагадування...' });
    const tz = await queries.getSetting('timezone', 'Europe/Kyiv');
    const yesterday = getYesterdayDateString(tz);
    const missing = await queries.getMissingUsersForDate(yesterday);

    if (missing.length === 0) {
      return ctx.reply(`🎉 Всі зареєстровані учасники вже надіслали свої результати за вчора (${formatUkrainianDate(yesterday)})!`);
    }

    const groupChatId = await queries.getSetting('group_chat_id');
    const remindersThreadId = await resolveTopicThreadId('reminders');
    if (groupChatId) {
      try {
        const groupMsg = await formatGroupReminderMessage(missing, yesterday);
        const sendOpts = { parse_mode: 'HTML' };
        if (remindersThreadId) {
          sendOpts.message_thread_id = remindersThreadId;
        }
        await bot.api.sendMessage(groupChatId, groupMsg, sendOpts);
      } catch (err) {
        console.error('Помилка відправки нагадування в групу:', err.message);
      }
    }

    let sentCount = 0;
    for (const user of missing) {
      try {
        const msg = formatReminderMessage(user.first_name, yesterday);
        await bot.api.sendMessage(user.user_id, msg);
        sentCount++;
      } catch {}
    }

    await ctx.reply(`🔔 Нагадування за ${formatUkrainianDate(yesterday)} надіслано у налаштовану гілку${sentCount > 0 ? ` (також ${sentCount} в особисті)` : ''}!`);
  });

  // Перегляд списку зареєстрованих колег
  bot.callbackQuery('admin_view_users', async (ctx) => {
    const users = await queries.getAllUsers();
    await ctx.answerCallbackQuery();

    if (users.length === 0) {
      return ctx.reply('Поки немає зареєстрованих колег.');
    }

    let msg = `👥 <b>Список зареєстрованих колег (${users.length}):</b>\n\n`;
    users.forEach((u, idx) => {
      const status = u.is_active ? '🟢' : '⏸ (неактивний)';
      const handle = u.username ? `@${escapeHtml(u.username)}` : `без @username`;
      msg += `${idx + 1}. ${status} <b>${escapeHtml(u.first_name)}</b> (${handle})\n`;
    });

    const keyboard = new InlineKeyboard().text('⬅️ До налаштувань', 'admin_refresh_settings');
    await ctx.editMessageText(msg, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  });

  // Команда /reset_data або /reset_all
  bot.command(['reset_data', 'reset_all'], async (ctx) => {
    const permitted = await isAdmin(ctx);
    if (!permitted) {
      return ctx.reply('⛔️ Тільки адміністратор може скидати базу даних.');
    }

    const keyboard = new InlineKeyboard()
      .text('🗑 Так, очистити все', 'confirm_clear_all_data')
      .row()
      .text('❌ Скасувати', 'cancel_clear_all_data');

    await ctx.reply(
      '⚠️ <b>УВАГА: Очищення бази перед стартом челенджу</b>\n\n' +
      'Ця дія видалить усіх учасників, усі збережені кроки та історію оплат штрафної банки.\n' +
      'Системні налаштування залишаться незмінними.\n\n' +
      'Ви впевнені, що хочете очистити базу?',
      { parse_mode: 'HTML', reply_markup: keyboard }
    );
  });

  // Запит з меню налаштувань
  bot.callbackQuery('admin_prompt_reset_data', async (ctx) => {
    const permitted = await isAdmin(ctx);
    if (!permitted) {
      return ctx.answerCallbackQuery({ text: 'Немає доступу!', show_alert: true });
    }

    await ctx.answerCallbackQuery();
    const keyboard = new InlineKeyboard()
      .text('🗑 Так, очистити все', 'confirm_clear_all_data')
      .row()
      .text('⬅️ Назад до налаштувань', 'admin_refresh_settings');

    await ctx.editMessageText(
      '⚠️ <b>УВАГА: Повне очищення перед запуском</b>\n\n' +
      'Ви збираєтеся очистити список учасників, їхні кроки та штрафи, щоб почати з чистого аркуша.\n\n' +
      'Очистити зараз?',
      { parse_mode: 'HTML', reply_markup: keyboard }
    );
  });

  // Підтвердження повного очищення
  bot.callbackQuery('confirm_clear_all_data', async (ctx) => {
    const permitted = await isAdmin(ctx);
    if (!permitted) {
      return ctx.answerCallbackQuery({ text: 'Немає доступу!', show_alert: true });
    }

    await queries.clearAllChallengeData();
    await ctx.answerCallbackQuery({ text: 'Базу успішно очищено!' });

    const keyboard = new InlineKeyboard().text('⚙️ До налаштувань', 'admin_refresh_settings');
    await ctx.editMessageText(
      '🎉 <b>Базу даних успішно очищено!</b>\n\n' +
      'Щоб завантажити учасників і дані з поточної Google Таблиці, натисніть <code>/import</code>.',
      { parse_mode: 'HTML', reply_markup: keyboard }
    );
  });

  // Скасування очищення
  bot.callbackQuery('cancel_clear_all_data', async (ctx) => {
    await ctx.answerCallbackQuery({ text: 'Дію скасовано' });
    await ctx.editMessageText('❌ Очищення бази скасовано.');
  });

  // Обробник інлайн-кнопки імпорту з Google Таблиці
  bot.callbackQuery('admin_import_sheet', async (ctx) => {
    const permitted = await isAdmin(ctx);
    if (!permitted) {
      return ctx.answerCallbackQuery({ text: 'Немає доступу!', show_alert: true });
    }

    await ctx.answerCallbackQuery({ text: 'Звірка з Google Таблицею...' });
    try {
      const res = await runImport();
      const users = await queries.getAllActiveUsers();
      const keyboard = new InlineKeyboard().text('⚙️ До налаштувань', 'admin_refresh_settings');
      await ctx.editMessageText(
        `✅ <b>Дані успішно звірено з Google Таблицею!</b>\n\n` +
        `👥 Всього учасників: <b>${users.length}</b>.\n` +
        `👟 Записів кроків звірено: <b>${res.totalStepsImported}</b>.\n\n` +
        `Тепер скористайтеся <code>/status</code> або <code>/report</code> у чаті.`,
        { parse_mode: 'HTML', reply_markup: keyboard }
      );
    } catch (err) {
      await ctx.editMessageText(`❌ Помилка синхронізації: ${escapeHtml(err.message)}`);
    }
  });
}

module.exports = {
  registerAdminHandlers,
};
