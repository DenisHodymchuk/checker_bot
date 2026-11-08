const { InlineKeyboard } = require('grammy');
const { config } = require('../config');
const { analyzeStepPhoto } = require('../services/gemini');
const queries = require('../db/queries');
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
 * Витягує автора та оригінальний час повідомлення (підтримує переслані старі скріни з історії чату)
 */
async function resolveMessageSenderAndDate(msg, fallbackFrom) {
  // 1. Telegram Bot API 7.0+ (forward_origin)
  const fwd = msg?.forward_origin;
  if (fwd) {
    const originDate = fwd.date ? new Date(fwd.date * 1000) : (msg.date ? new Date(msg.date * 1000) : new Date());
    if (fwd.type === 'user' && fwd.sender_user) {
      return {
        userId: fwd.sender_user.id,
        firstName: fwd.sender_user.first_name || 'Колега',
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
      };
    }
  }

  // 2. Telegram Bot API класичний forward_from / forward_sender_name
  if (msg?.forward_from) {
    const originDate = msg.forward_date ? new Date(msg.forward_date * 1000) : new Date();
    return {
      userId: msg.forward_from.id,
      firstName: msg.forward_from.first_name || 'Колега',
      username: msg.forward_from.username || null,
      messageDate: originDate,
      isForwarded: true,
    };
  }
  if (msg?.forward_sender_name) {
    const originDate = msg.forward_date ? new Date(msg.forward_date * 1000) : new Date();
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

  // 3. Якщо в описі (caption) вказано @username або ім'я колеги
  if (msg?.caption) {
    const handleMatch = msg.caption.match(/@([a-zA-Z0-9_]{3,32})/);
    if (handleMatch) {
      const matched = await queries.findUserByHandleOrId(handleMatch[1]);
      if (matched) {
        const messageDate = msg?.date ? new Date(msg.date * 1000) : new Date();
        return {
          userId: matched.id,
          firstName: matched.first_name,
          username: matched.username,
          messageDate,
          isForwarded: true,
        };
      }
    }
  }

  const sender = msg?.from || fallbackFrom;
  const messageDate = msg?.date ? new Date(msg.date * 1000) : new Date();
  return {
    userId: sender.id,
    firstName: sender.first_name || 'Колега',
    username: sender.username || null,
    messageDate,
    isForwarded: false,
  };
}

/**
 * Розбирає підпис (caption) до фото на наявність явної дати (напр. "06.11", "за 7 число") або кроків
 */
function parseCaptionHints(caption, tz = 'Europe/Kyiv') {
  if (!caption) return { captionSteps: null, captionDate: null };
  const raw = caption.trim();
  let captionDate = null;
  let captionSteps = null;

  const today = getTodayDateString(tz);
  const yearMonth = today.slice(0, 7);
  const year = today.slice(0, 4);

  // Перевірка на дату DD.MM (наприклад "06.11" або "7.11")
  const dmMatch = raw.match(/\b(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?\b/);
  if (dmMatch) {
    const d = String(dmMatch[1]).padStart(2, '0');
    const m = String(dmMatch[2]).padStart(2, '0');
    const y = dmMatch[3] || year;
    captionDate = `${y}-${m}-${d}`;
  } else {
    // Перевірка на "за 6 число", "6 листопада", "день 6"
    const dayTextMatch = raw.match(/(?:за\s+|день\s+)(\d{1,2})\b|\b(\d{1,2})\s*(?:листопада|жовтня|грудня|число|числа)/i);
    if (dayTextMatch) {
      const dayNum = Number(dayTextMatch[1] || dayTextMatch[2]);
      if (dayNum >= 1 && dayNum <= 31) {
        captionDate = `${yearMonth}-${String(dayNum).padStart(2, '0')}`;
      }
    }
  }

  // Перевірка на число кроків у підписі
  const cleanedDigits = raw.replace(/\s+/g, '');
  if (/^\d{3,6}$/.test(cleanedDigits)) {
    const val = Number(cleanedDigits);
    if (val >= 100 && val <= 150000) {
      captionSteps = val;
    }
  }

  return { captionSteps, captionDate };
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
 * Реєстрація обробників фото та підтвердження
 */
function registerPhotoHandlers(bot) {
  // Команда /scan у відповідь на старе фото в чаті (для аналізу попередніх днів)
  bot.command('scan', async (ctx) => {
    const replyMsg = ctx.message?.reply_to_message;
    if (!replyMsg || !replyMsg.photo) {
      return ctx.reply('⚠️ Надішліть <code>/scan</code> (або <code>/scan 06.11</code>) у відповідь (reply) на повідомлення зі скріншотом кроків.', {
        parse_mode: 'HTML',
      });
    }

    const tz = await queries.getSetting('timezone', 'Europe/Kyiv');
    const deadlineTime = await queries.getSetting('deadline_time', '12:00');
    const dailyGoal = Number(await queries.getSetting('daily_goal', '10000'));

    const { userId, firstName, username, messageDate } = await resolveMessageSenderAndDate(
      replyMsg,
      replyMsg.from
    );
    await queries.upsertUser(userId, firstName, username);

    const args = ctx.message.text.split(/\s+/).slice(1);
    let targetDate = null;
    if (args[0]) {
      targetDate = resolveTargetDate(args[0], tz);
    } else {
      const { captionDate } = parseCaptionHints(replyMsg.caption, tz);
      targetDate = captionDate || await resolveSubmissionDate({
        userId,
        messageDate,
        timeZone: tz,
        deadlineTime,
        dailyGoal,
        getUserStepsForDate: queries.getUserStepsForDate,
      });
    }

    const rec = await downloadAndRecognizePhoto(ctx, replyMsg.photo);
    if (!rec || !rec.steps) {
      await reactToMessage(ctx, '🤔', replyMsg.message_id);
      return;
    }

    const current = await queries.getUserStepsForDate(userId, targetDate);
    const prevSteps = current && current.source !== 'google_sheet' ? (Number(current.steps) || 0) : 0;
    const totalSteps = prevSteps + rec.steps;

    await queries.saveDailySteps(
      userId,
      targetDate,
      totalSteps,
      'photo',
      prevSteps > 0 ? `Скановано (+${rec.steps} до ${prevSteps})` : 'Скановано з історії чату'
    );

    await reactToMessage(ctx, '👍', replyMsg.message_id);
    await reactToMessage(ctx, '👍', ctx.message.message_id);
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

    const { userId, firstName, username, messageDate, isForwarded } = await resolveMessageSenderAndDate(
      ctx.message,
      ctx.from
    );

    // Реєструємо/оновлюємо користувача в базі
    await queries.upsertUser(userId, firstName, username);

    const { captionSteps, captionDate } = parseCaptionHints(ctx.message.caption, tz);

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

    // Обробка поодинокого фото
    let detectedSteps = captionSteps;
    let source = captionSteps ? 'caption' : 'photo';
    let notes = captionSteps ? 'Вказано в описі фото' : '';

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

    // Якщо число кроків успішно визначено:
    if (detectedSteps && detectedSteps > 0) {
      const current = await queries.getUserStepsForDate(userId, targetDate);
      const previousSteps = current ? (Number(current.steps) || 0) : 0;

      // Якщо це пересланий скрін з історії чату і в базі вже рівно та сама кількість кроків — оновлюємо таблицю та ставимо 👍
      if (isForwarded && previousSteps === detectedSteps) {
        if (global.onStepsSavedHook) {
          try {
            await global.onStepsSavedHook(userId, targetDate, detectedSteps);
          } catch (_) {}
        }
        await reactToMessage(ctx, '👍');
        return;
      }

      if (previousSteps > 0 && !(isForwarded && current?.source === 'google_sheet')) {
        const totalSteps = previousSteps + detectedSteps;
        await queries.saveDailySteps(
          userId,
          targetDate,
          totalSteps,
          source,
          notes ? `${notes} (+${detectedSteps} до ${previousSteps})` : `Додано +${detectedSteps} до ${previousSteps}`
        );
      } else {
        await queries.saveDailySteps(userId, targetDate, detectedSteps, source, notes);
      }

      // Замість текстового повідомлення просто ставимо реакцію 👍
      await reactToMessage(ctx, '👍');
    } else {
      // Якщо не вдалося розпізнати кроки на зображенні
      await reactToMessage(ctx, '🤔');
      if (ctx.chat.type === 'private') {
        const userDisplayName = firstName || (username ? `@${username}` : 'колеги');
        const keyboard = new InlineKeyboard()
          .text(`✏️ Ввести кроки вручну`, `manual_input:${userId}:${targetDate}`)
          .text('❌ Закрити', 'cancel_action');

        await ctx.reply(
          `⚠️ <b>Не вдалося розпізнати число кроків на цьому фото</b> ☝️\n\n` +
          `👤 Учасник: <b>${escapeHtml(userDisplayName)}</b>\n` +
          `📅 Дата: <b>${escapeHtml(formatUkrainianDate(targetDate))}</b>\n\n` +
          `Натисніть кнопку нижче або надішліть число кроків у відповідь на це повідомлення:`,
          {
            parse_mode: 'HTML',
            reply_markup: keyboard,
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
};
