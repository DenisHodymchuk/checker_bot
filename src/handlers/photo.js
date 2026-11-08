const { InlineKeyboard } = require('grammy');
const { config } = require('../config');
const { analyzeStepPhoto } = require('../services/gemini');
const queries = require('../db/queries');
const { syncUserStepsToSheet } = require('../services/google_sheet');
const { escapeHtml, formatStepSuccessMessage } = require('../services/leaderboard');
const {
  getTodayDateString,
  resolveSubmissionDate,
  resolveTargetDate,
  formatUkrainianDate,
  formatNumber,
} = require('../utils/date');
const { isAllowedStepsTopic } = require('../utils/topic');

// Зберігаємо тимчасовий стан користувачів для очікування ручного вводу
const userAwaitingManualInput = new Map();

// Буфер для обробки альбомів (media_group_id)
const mediaGroupBuffer = new Map();

/**
 * Безпечно ставить емодзі-реакцію на повідомлення замість текстової відповіді
 */
async function reactToMessage(ctx, emoji = '👍', targetMessageId = null) {
  const chatId = ctx.chat?.id;
  const msgId = targetMessageId || ctx.message?.message_id;
  if (!chatId || !msgId) return;

  try {
    await ctx.api.setMessageReaction(chatId, msgId, [{ type: 'emoji', emoji }]);
  } catch (err) {
    if (emoji !== '👍') {
      try {
        await ctx.api.setMessageReaction(chatId, msgId, [{ type: 'emoji', emoji: '👍' }]);
      } catch {}
    }
  }
}

/**
 * Витягує автора та оригінальний час повідомлення (підтримує переслані старі скріни з історії чату та @username у підписі)
 */
async function resolveMessageSenderAndDate(msg, fallbackFrom) {
  const fwd = msg?.forward_origin;
  const originDate = fwd?.date
    ? new Date(fwd.date * 1000)
    : msg?.forward_date
    ? new Date(msg.forward_date * 1000)
    : msg?.date
    ? new Date(msg.date * 1000)
    : new Date();

  // 1. Найвищий пріоритет: якщо в описі (caption або text) явно вказано @username
  const textOrCaption = msg?.caption || msg?.text || '';
  if (textOrCaption) {
    const handleMatch = textOrCaption.match(/@([a-zA-Z0-9_]{3,32})/);
    if (handleMatch) {
      const matched = await queries.findUserByHandleOrId(handleMatch[1]);
      if (matched) {
        return {
          userId: matched.id,
          firstName: matched.first_name,
          username: matched.username,
          messageDate: originDate,
          isForwarded: true,
        };
      }
    }
  }

  // 2. Telegram Bot API 7.0+ (forward_origin)
  if (fwd) {
    if (fwd.type === 'user' && fwd.sender_user) {
      const fullName = [fwd.sender_user.first_name, fwd.sender_user.last_name].filter(Boolean).join(' ') || 'Колега';
      if (!fwd.sender_user.username) {
        const matched = await queries.findUserByHandleOrId(fullName);
        if (matched) {
          return {
            userId: fwd.sender_user.id,
            firstName: matched.first_name || fullName,
            username: matched.username || null,
            messageDate: originDate,
            isForwarded: true,
          };
        }
      }
      return {
        userId: fwd.sender_user.id,
        firstName: fullName,
        username: fwd.sender_user.username || null,
        messageDate: originDate,
        isForwarded: true,
      };
    }
    if (fwd.type === 'hidden_user' && fwd.sender_user_name) {
      const matched = await queries.findUserByHandleOrId(fwd.sender_user_name);
      if (matched) {
        return {
          userId: matched.id,
          firstName: matched.first_name,
          username: matched.username,
          messageDate: originDate,
          isForwarded: true,
        };
      }
      return {
        userId: fallbackFrom.id,
        firstName: fwd.sender_user_name,
        username: null,
        messageDate: originDate,
        isForwarded: true,
        unmatchedHiddenName: fwd.sender_user_name,
      };
    }
  }

  // 3. Telegram Bot API класичний forward_from / forward_sender_name
  if (msg?.forward_from) {
    const fullName = [msg.forward_from.first_name, msg.forward_from.last_name].filter(Boolean).join(' ') || 'Колега';
    return {
      userId: msg.forward_from.id,
      firstName: fullName,
      username: msg.forward_from.username || null,
      messageDate: originDate,
      isForwarded: true,
    };
  }
  if (msg?.forward_sender_name) {
    const matched = await queries.findUserByHandleOrId(msg.forward_sender_name);
    if (matched) {
      return {
        userId: matched.id,
        firstName: matched.first_name,
        username: matched.username,
        messageDate: originDate,
        isForwarded: true,
      };
    }
  }

  const sender = msg?.from || fallbackFrom;
  return {
    userId: sender.id,
    firstName: sender.first_name || 'Колега',
    username: sender.username || null,
    messageDate: originDate,
    isForwarded: false,
  };
}

/**
 * Розбирає підпис (caption) або текст команди на наявність:
 * - команди (/steps 12500, /s 12500, /k 12500)
 * - @username учасника
 * - явної дати (напр. "06.11", "за 7 число")
 * - кількості кроків (напр. "12500", "12 500", "+3000")
 */
function parseCaptionHints(caption, tz = 'Europe/Kyiv') {
  if (!caption) return { captionSteps: null, captionDate: null, captionUsername: null, isPlus: false };
  let working = caption.trim();
  let captionDate = null;
  let captionSteps = null;
  let captionUsername = null;
  let isPlus = false;

  const today = getTodayDateString(tz);
  const yearMonth = today.slice(0, 7);
  const year = today.slice(0, 4);

  // 1. Витягуємо @username, якщо вказано
  const handleMatch = working.match(/@([a-zA-Z0-9_]{3,32})/);
  if (handleMatch) {
    captionUsername = handleMatch[1];
    working = working.replace(handleMatch[0], ' ');
  }

  // 2. Прибираємо команду на початку (/steps, /s, /set, /scan, /k, /кроки)
  working = working.replace(/^\/[a-zA-Zа-яА-ЯіїєґІЇЄҐ0-9_]+(@[a-zA-Z0-9_]+)?\s*/i, ' ');

  // 3. Перевірка на дату DD.MM (наприклад "06.11" або "7.11.2026")
  const dmMatch = working.match(/\b(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?\b/);
  if (dmMatch) {
    const d = String(dmMatch[1]).padStart(2, '0');
    const m = String(dmMatch[2]).padStart(2, '0');
    const y = dmMatch[3] || year;
    captionDate = `${y}-${m}-${d}`;
    working = working.replace(dmMatch[0], ' ');
  } else {
    // Перевірка на "за 6 число", "6 листопада", "день 6"
    const dayTextMatch = working.match(/(?:за\s+|день\s+)(\d{1,2})\b|\b(\d{1,2})\s*(?:листопада|жовтня|грудня|число|числа)/i);
    if (dayTextMatch) {
      const dayNum = Number(dayTextMatch[1] || dayTextMatch[2]);
      if (dayNum >= 1 && dayNum <= 31) {
        captionDate = `${yearMonth}-${String(dayNum).padStart(2, '0')}`;
        working = working.replace(dayTextMatch[0], ' ');
      }
    }
  }

  // 4. Шукаємо число кроків (підтримуємо "12500", "12 500", "+3000", "12,500")
  const stepMatch = working.match(/(\+)?\b(\d{1,3}(?:[\s,]\d{3})+|\d{3,6})\b/);
  if (stepMatch) {
    isPlus = Boolean(stepMatch[1]);
    const val = Number(stepMatch[2].replace(/[\s,]/g, ''));
    if (val >= 100 && val <= 150000) {
      captionSteps = val;
    }
  }

  return { captionSteps, captionDate, captionUsername, isPlus };
}

/**
 * Завантажує та розпізнає зображення через Gemini Vision AI
 */
async function downloadAndRecognizePhoto(ctx, photoItem) {
  try {
    const photos = photoItem || ctx.message.photo;
    const bestPhoto = photos[photos.length - 1];
    const fileId = bestPhoto.file_id;

    const file = await ctx.api.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;

    const response = await fetch(fileUrl);
    if (!response.ok) {
      throw new Error(`Помилка завантаження фото: ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const imageBuffer = Buffer.from(arrayBuffer);
    const mimeType = file.file_path.endsWith('.png') ? 'image/png' : 'image/jpeg';

    const result = await analyzeStepPhoto(imageBuffer, mimeType);
    if (result.success && result.steps > 0) {
      return {
        steps: result.steps,
        date: result.date || null,
        notes: result.notes || 'Розпізнано з фото',
      };
    }
  } catch (err) {
    console.error('Помилка при аналізі фото:', err);
  }
  return null;
}

/**
 * Обробляє пачку фотографій з альбому (media group)
 */
async function handleMediaGroupBatch(mediaGroupId) {
  const batch = mediaGroupBuffer.get(mediaGroupId);
  mediaGroupBuffer.delete(mediaGroupId);
  if (!batch || batch.length === 0) return;

  const firstCtx = batch[0].ctx;
  const { userId, firstName, username, messageDate } = await resolveMessageSenderAndDate(
    firstCtx.message,
    firstCtx.from
  );

  await queries.upsertUser(userId, firstName, username);

  const tz = await queries.getSetting('timezone', 'Europe/Kyiv');
  const deadlineTime = await queries.getSetting('deadline_time', '12:00');
  const dailyGoal = Number(await queries.getSetting('daily_goal', '10000'));

  let explicitDate = batch.find(b => b.captionDate)?.captionDate || null;

  // Аналізуємо кожне фото в альбомі
  const detectedList = [];
  for (const item of batch) {
    let steps = item.captionSteps;
    if (!steps) {
      const rec = await downloadAndRecognizePhoto(item.ctx, item.ctx.message.photo);
      if (rec && rec.steps > 0) {
        steps = rec.steps;
      }
    }
    if (steps && steps > 0) {
      detectedList.push(steps);
    }
  }

  if (detectedList.length === 0) {
    await reactToMessage(firstCtx, '🤔');
    return;
  }

  const targetDate = explicitDate || await resolveSubmissionDate({
    userId,
    messageDate,
    timeZone: tz,
    deadlineTime,
    dailyGoal,
    getUserStepsForDate: queries.getUserStepsForDate,
  });

  // Сума всіх кроків з альбому
  const albumSum = detectedList.reduce((acc, s) => acc + s, 0);

  // Перевіряємо, чи були вже збережені кроки за цільову дату
  const current = await queries.getUserStepsForDate(userId, targetDate);
  const previousSteps = current ? (Number(current.steps) || 0) : 0;
  const newTotal = previousSteps + albumSum;

  await queries.saveDailySteps(
    userId,
    targetDate,
    newTotal,
    'photo_album',
    previousSteps > 0
      ? `Альбом (+${albumSum} до ${previousSteps})`
      : `Альбом (${detectedList.join(' + ')})`
  );

  // Ставимо реакцію на повідомлення альбому замість текстової відповіді
  for (const item of batch) {
    await reactToMessage(item.ctx, '👍');
  }
}

/**
 * Обробка команди /scan (або /s у відповідь на фото) для сканування фото за допомогою AI
 */
async function handleScanCommand(ctx, targetReplyMsg = null) {
  const replyMsg = targetReplyMsg || ctx.message?.reply_to_message;
  if (!replyMsg || !replyMsg.photo) {
    if (ctx.chat && ctx.chat.type !== 'private') {
      const tipMsg = await ctx.reply('⚠️ Надішліть <code>/scan</code> у відповідь (reply) на повідомлення зі скріншотом кроків.', {
        parse_mode: 'HTML',
        reply_parameters: { message_id: ctx.message?.message_id },
      });
      setTimeout(async () => {
        try {
          await ctx.api.deleteMessage(ctx.chat.id, tipMsg.message_id);
        } catch {}
      }, 7000);
      return;
    }
    return ctx.reply('⚠️ Надішліть <code>/scan</code> (або <code>/scan 06.11</code>) у відповідь (reply) на повідомлення зі скріншотом кроків.', {
      parse_mode: 'HTML',
    });
  }

  // Якщо /scan викликано в групі чи гілці — автоматично запам'ятовуємо цю гілку як активну для скрінів
  if (ctx.chat && ctx.chat.type !== 'private') {
    const threadId = ctx.message?.message_thread_id ? String(ctx.message.message_thread_id) : 'general';
    await queries.setSetting('group_chat_id', String(ctx.chat.id));
    await queries.setSetting('steps_topic_id', threadId);
  }

  const tz = await queries.getSetting('timezone', 'Europe/Kyiv');
  const deadlineTime = await queries.getSetting('deadline_time', '12:00');
  const dailyGoal = Number(await queries.getSetting('daily_goal', '10000'));

  const { userId, firstName, username, messageDate } = await resolveMessageSenderAndDate(
    replyMsg,
    replyMsg.from
  );
  await queries.upsertUser(userId, firstName, username);

  const { captionSteps, captionDate, isPlus } = parseCaptionHints(replyMsg.caption, tz);

  const args = ctx.message.text.split(/\s+/).slice(1);
  let targetDate = null;
  if (args[0]) {
    targetDate = resolveTargetDate(args[0], tz);
  } else {
    targetDate = captionDate || await resolveSubmissionDate({
      userId,
      messageDate,
      timeZone: tz,
      deadlineTime,
      dailyGoal,
      getUserStepsForDate: queries.getUserStepsForDate,
    });
  }

  let detectedSteps = captionSteps;
  if (!detectedSteps) {
    const rec = await downloadAndRecognizePhoto(ctx, replyMsg.photo);
    detectedSteps = rec?.steps || null;
  }

  if (!detectedSteps) {
    await reactToMessage(ctx, '🤔', replyMsg.message_id);
    return;
  }

  const current = await queries.getUserStepsForDate(userId, targetDate);
  const prevSteps = isPlus && current ? (Number(current.steps) || 0) : 0;
  const totalSteps = prevSteps + detectedSteps;

  await queries.saveDailySteps(
    userId,
    targetDate,
    totalSteps,
    'photo',
    prevSteps > 0 ? `Скановано (+${detectedSteps} до ${prevSteps})` : 'Скановано командою /scan'
  );
  await syncUserStepsToSheet(userId, targetDate, totalSteps);

  await reactToMessage(ctx, '👍', replyMsg.message_id);
  if (ctx.message?.message_id && ctx.message.message_id !== replyMsg.message_id) {
    await reactToMessage(ctx, '👍', ctx.message.message_id);
  }
}

/**
 * Реєстрація обробників фото та підтвердження
 */
function registerPhotoHandlers(bot) {
  // Команда /scan у відповідь на старе фото в чаті (для аналізу попередніх днів)
  bot.command('scan', async (ctx) => {
    await handleScanCommand(ctx);
  });

  // Обробка отриманого фото (лише в особистих повідомленнях або в гілці «скріни кроків»)
  bot.on('message:photo', async (ctx) => {
    const allowed = await isAllowedStepsTopic(ctx);
    if (!allowed) {
      return;
    }

    const tz = await queries.getSetting('timezone', 'Europe/Kyiv');
    const deadlineTime = await queries.getSetting('deadline_time', '12:00');
    const dailyGoal = Number(await queries.getSetting('daily_goal', '10000'));

    const { userId, firstName, username, messageDate, isForwarded, unmatchedHiddenName } = await resolveMessageSenderAndDate(
      ctx.message,
      ctx.from
    );

    if (!unmatchedHiddenName) {
      await queries.upsertUser(userId, firstName, username);
    }
    const dbUser = await queries.getUser(userId);
    const resolvedName = dbUser?.first_name || firstName || 'Колега';
    const resolvedUsername = dbUser?.username || username || null;
    const userDisplayName = resolvedUsername ? `${resolvedName} (@${resolvedUsername})` : resolvedName;

    const { captionSteps, captionDate, isPlus } = parseCaptionHints(ctx.message.caption, tz);

    // Якщо це альбом (кілька фото в одному повідомленні) і не переслана пачка різних авторів
    const mediaGroupId = ctx.message.media_group_id;
    if (mediaGroupId && !isForwarded) {
      if (!mediaGroupBuffer.has(mediaGroupId)) {
        mediaGroupBuffer.set(mediaGroupId, []);
        setTimeout(() => {
          handleMediaGroupBatch(mediaGroupId).catch(err => {
            console.error('Помилка обробки альбому фото:', err);
          });
        }, 750);
      }
      mediaGroupBuffer.get(mediaGroupId).push({ ctx, captionSteps, captionDate });
      return;
    }

    // Обробка поодинокого фото: спочатку перевіряємо команду/число в підписі, потім AI
    let detectedSteps = captionSteps;
    let source = captionSteps ? 'caption' : 'photo';
    let notes = captionSteps ? 'Вказано в підписі до фото' : '';

    if (!detectedSteps) {
      const rec = await downloadAndRecognizePhoto(ctx);
      if (rec && rec.steps > 0) {
        detectedSteps = rec.steps;
        notes = rec.notes;
      }
    }

    // Визначаємо дату, за яку зараховуємо скрін (до 12:00 наступного дня -> за вчора, якщо вчора ще не закрито)
    const targetDate = captionDate || await resolveSubmissionDate({
      userId,
      messageDate,
      timeZone: tz,
      deadlineTime,
      dailyGoal,
      getUserStepsForDate: queries.getUserStepsForDate,
    });

    // Перевіряємо, чи не є автор прихованим/адміном при пересиланні в особисті без тегу @username
    const isAdminSender = resolvedUsername && resolvedUsername.toLowerCase() === 'godymchuk_d_d';
    if (ctx.chat.type === 'private' && (unmatchedHiddenName || isAdminSender)) {
      await reactToMessage(ctx, '🤔');
      const hintSteps = detectedSteps || 10500;
      const shortDate = `${targetDate.slice(8, 10)}.${targetDate.slice(5, 7)}`;
      await ctx.reply(
        `⚠️ <b>Не вдалося визначити учасника з таблиці</b> (автор скріна: <b>${escapeHtml(unmatchedHiddenName || resolvedName)}</b> прихований або не в списку).\n\n` +
        `${detectedSteps ? `👟 На скріні розпізнано: <b>${formatNumber(detectedSteps)}</b> кроків за <b>${escapeHtml(formatUkrainianDate(targetDate))}</b>.\n\n` : ''}` +
        `Напишіть у відповідь тег учасника та кроки:\n` +
        `<code>/steps @username ${hintSteps} ${shortDate}</code>`,
        {
          parse_mode: 'HTML',
          reply_parameters: { message_id: ctx.message.message_id },
        }
      );
      return;
    }

    // Якщо число кроків успішно визначено:
    if (detectedSteps && detectedSteps > 0) {
      const current = await queries.getUserStepsForDate(userId, targetDate);
      const previousSteps = current ? (Number(current.steps) || 0) : 0;
      let finalSteps = detectedSteps;

      // Якщо це пересланий скрін з історії чату і в базі вже рівно та сама кількість кроків — оновлюємо таблицю та ставимо 👍
      if (isForwarded && previousSteps === detectedSteps && !isPlus) {
        await syncUserStepsToSheet(userId, targetDate, detectedSteps);
        await reactToMessage(ctx, '👍');
        if (ctx.chat.type === 'private') {
          await ctx.reply(
            `✅ <b>Записано в Google Таблицю:</b> <b>${formatNumber(detectedSteps)}</b> кр. — <b>${escapeHtml(userDisplayName)}</b> за <b>${escapeHtml(formatUkrainianDate(targetDate))}</b>`,
            { parse_mode: 'HTML', reply_parameters: { message_id: ctx.message.message_id } }
          );
        }
        return;
      }

      if (isPlus && previousSteps > 0) {
        finalSteps = previousSteps + detectedSteps;
        await queries.saveDailySteps(
          userId,
          targetDate,
          finalSteps,
          source,
          `Додано +${detectedSteps} до ${previousSteps}`
        );
      } else {
        finalSteps = detectedSteps;
        await queries.saveDailySteps(userId, targetDate, finalSteps, source, notes);
      }

      await syncUserStepsToSheet(userId, targetDate, finalSteps);
      await reactToMessage(ctx, '👍');

      if (ctx.chat.type === 'private') {
        await ctx.reply(
          `✅ <b>Записано в Google Таблицю:</b> <b>${formatNumber(finalSteps)}</b> кр. — <b>${escapeHtml(userDisplayName)}</b> за <b>${escapeHtml(formatUkrainianDate(targetDate))}</b>`,
          { parse_mode: 'HTML', reply_parameters: { message_id: ctx.message.message_id } }
        );
      }
    } else {
      // Якщо не вдалося розпізнати кроки або не вказано команду /steps у підписі
      await reactToMessage(ctx, '🤔');
      userAwaitingManualInput.set(ctx.from.id, {
        targetUserId: userId,
        date: targetDate,
        targetName: resolvedName,
        photoMessageId: ctx.message.message_id,
      });

      if (ctx.chat.type === 'private') {
        const keyboard = new InlineKeyboard()
          .text(`✏️ Ввести кроки вручну`, `manual_input:${userId}:${targetDate}`)
          .text('❌ Закрити', 'cancel_action');

        await ctx.reply(
          `⚠️ <b>Вкажіть кількість кроків для цього скріна</b> ☝️\n\n` +
          `👤 Учасник: <b>${escapeHtml(userDisplayName)}</b>\n` +
          `📅 Дата: <b>${escapeHtml(formatUkrainianDate(targetDate))}</b>\n\n` +
          `Надішліть у відповідь <code>/steps 10500</code> (або просто число <code>10500</code>), чи натисніть кнопку нижче:`,
          {
            parse_mode: 'HTML',
            reply_markup: keyboard,
            reply_parameters: { message_id: ctx.message.message_id },
          }
        );
      } else {
        await ctx.reply(
          `⚠️ <b>${escapeHtml(resolvedName)}</b>, будь ласка, додайте команду з кількістю кроків до скріна!\n` +
          `Напишіть у відповідь (Reply) на свій скрін: <code>/steps 10500</code> (або підписуйте фото одразу при відправці: <code>/steps 10500</code>).`,
          {
            parse_mode: 'HTML',
            reply_parameters: { message_id: ctx.message.message_id },
          }
        );
      }
    }
  });

  // Кнопка заміни кроків лише на останній новий скріншот
  bot.callbackQuery(/^replace_steps:(\d+):([\d-]+):(\d+)$/, async (ctx) => {
    const targetUserId = Number(ctx.match[1]);
    const date = ctx.match[2];
    const newSteps = Number(ctx.match[3]);

    if (ctx.from.id !== targetUserId && config.adminId !== ctx.from.id) {
      return ctx.answerCallbackQuery({ text: 'Ви можете редагувати лише свій результат!', show_alert: true });
    }

    const dailyGoal = Number(await queries.getSetting('daily_goal', '10000'));
    await queries.saveDailySteps(targetUserId, date, newSteps, 'photo', 'Замінено на новий результат');

    const firstName = ctx.from.first_name || 'Колега';
    const updatedText = formatStepSuccessMessage({
      name: firstName,
      steps: newSteps,
      dailyGoal,
    });

    const keyboard = new InlineKeyboard().text('✏️ Редагувати', `group_edit:${targetUserId}:${date}`);

    await ctx.answerCallbackQuery({ text: `Встановлено: ${formatNumber(newSteps)} кр.` });
    try {
      await ctx.editMessageText(
        `🔄 <b>Результат оновлено:</b>\n\n` + updatedText,
        {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        }
      );
    } catch (err) {
      if (!err.message?.includes('message is not modified')) {
        console.warn('Не вдалося оновити replace_steps:', err.message);
      }
    }
  });

  // Кнопка редагування в групі
  bot.callbackQuery(/^group_edit:(\d+):([\d-]+)$/, async (ctx) => {
    const targetUserId = Number(ctx.match[1]);
    const date = ctx.match[2];

    if (ctx.from.id !== targetUserId && config.adminId !== ctx.from.id) {
      return ctx.answerCallbackQuery({ text: 'Ви можете редагувати лише свій результат!', show_alert: true });
    }

    await ctx.answerCallbackQuery();
    await ctx.reply(
      `✏️ <b>Редагування результату:</b>\n\n` +
      `• <code>/steps 12000</code> — встановити точне значення\n` +
      `• <code>/steps +3000</code> — доплюсувати кроки до наявних`,
      { parse_mode: 'HTML' }
    );
  });

  // Підтвердження збереження в особистих
  bot.callbackQuery(/^save_steps:(\d+):([\d-]+)$/, async (ctx) => {
    const steps = Number(ctx.match[1]);
    const date = ctx.match[2];
    const userId = ctx.from.id;
    const firstName = ctx.from.first_name || 'Колега';

    await queries.upsertUser(userId, firstName, ctx.from.username);
    await queries.saveDailySteps(userId, date, steps, 'photo', 'Збережено з фото');

    const dailyGoal = Number(await queries.getSetting('daily_goal', '10000'));
    const successMsg = formatStepSuccessMessage({
      name: firstName,
      steps,
      dailyGoal,
    });

    await ctx.answerCallbackQuery({ text: 'Кроки збережено!' });
    await ctx.editMessageText(successMsg, { parse_mode: 'HTML' });
  });

  // Запит на ручний ввід в особистих
  bot.callbackQuery(/^manual_input:(\d+)?:?([\d-]+)$/, async (ctx) => {
    let targetUserId = ctx.match[1] ? Number(ctx.match[1]) : ctx.from.id;
    const date = ctx.match[2] || ctx.match[1];
    if (!targetUserId || isNaN(targetUserId)) targetUserId = ctx.from.id;

    const targetUser = await queries.getUser(targetUserId);
    const targetName = targetUser?.first_name || 'колеги';

    userAwaitingManualInput.set(ctx.from.id, { targetUserId, date, targetName });

    await ctx.answerCallbackQuery();
    await ctx.reply(
      `✏️ Надішліть число кроків для <b>${escapeHtml(targetName)}</b> за <b>${escapeHtml(formatUkrainianDate(date))}</b> (наприклад: <code>10500</code> або <code>+3000</code>):`,
      { parse_mode: 'HTML', reply_parameters: { message_id: ctx.callbackQuery.message?.message_id } }
    );
  });

  // Скасування в особистих
  bot.callbackQuery('cancel_action', async (ctx) => {
    await ctx.answerCallbackQuery({ text: 'Дію скасовано' });
    await ctx.editMessageText('❌ Дію скасовано.');
  });
}

module.exports = {
  registerPhotoHandlers,
  userAwaitingManualInput,
  reactToMessage,
  resolveMessageSenderAndDate,
  parseCaptionHints,
  handleScanCommand,
};
