const { InlineKeyboard } = require('grammy');
const { config } = require('../config');
const { analyzeStepPhoto } = require('../services/gemini');
const queries = require('../db/queries');
const { escapeHtml, formatStepSuccessMessage } = require('../services/leaderboard');
const { getTodayDateString, formatUkrainianDate, formatNumber } = require('../utils/date');
const { isAllowedStepsTopic } = require('../utils/topic');

// Зберігаємо тимчасовий стан користувачів для очікування ручного вводу
const userAwaitingManualInput = new Map();

// Буфер для обробки альбомів (media_group_id)
const mediaGroupBuffer = new Map();

/**
 * Завантажує та розпізнає зображення
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
  const isGroup = firstCtx.chat.type !== 'private';
  const userId = firstCtx.from.id;
  const firstName = firstCtx.from.first_name || 'Колега';
  const username = firstCtx.from.username || null;
  const name = firstName ? escapeHtml(firstName) : (username ? '@' + escapeHtml(username) : 'Колега');

  await queries.upsertUser(userId, firstName, username);

  const tz = await queries.getSetting('timezone', 'Europe/Kyiv');
  const today = getTodayDateString(tz);
  const dailyGoal = Number(await queries.getSetting('daily_goal', '10000'));

  if (isGroup) {
    try {
      await firstCtx.replyWithChatAction('typing');
    } catch {}
  }

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
    return firstCtx.reply(
      `⚠️ <b>${name}</b>, не вдалося розпізнати кроки на надісланих скріншотах. Будь ласка, вкажіть число командою: <code>/steps 10500</code>`,
      {
        parse_mode: 'HTML',
        reply_parameters: { message_id: firstCtx.message.message_id },
      }
    );
  }

  // Сума всіх кроків з альбому
  const albumSum = detectedList.reduce((acc, s) => acc + s, 0);

  // Перевіряємо, чи були вже збережені кроки за сьогодні
  const current = await queries.getUserStepsForDate(userId, today);
  const previousSteps = current ? (Number(current.steps) || 0) : 0;
  const newTotal = previousSteps + albumSum;

  await queries.saveDailySteps(
    userId,
    today,
    newTotal,
    'photo_album',
    previousSteps > 0
      ? `Альбом (+${albumSum} до ${previousSteps})`
      : `Альбом (${detectedList.join(' + ')})`
  );

  const replyText = formatStepSuccessMessage({
    name: firstName,
    username,
    steps: newTotal,
    dailyGoal,
    previousSteps,
    addedSteps: albumSum,
    albumSteps: detectedList.length > 1 ? detectedList : null,
  });

  return firstCtx.reply(replyText, {
    parse_mode: 'HTML',
    reply_parameters: { message_id: firstCtx.message.message_id },
  });
}

/**
 * Реєстрація обробників фото та підтвердження
 */
function registerPhotoHandlers(bot) {
  // Обробка отриманого фото (лише в особистих повідомленнях або в гілці «скріни кроків»)
  bot.on('message:photo', async (ctx) => {
    const allowed = await isAllowedStepsTopic(ctx);
    if (!allowed) {
      return;
    }

    const isGroup = ctx.chat.type !== 'private';
    const userId = ctx.from.id;
    const firstName = ctx.from.first_name || 'Колега';
    const username = ctx.from.username || null;
    const name = firstName ? escapeHtml(firstName) : (username ? '@' + escapeHtml(username) : 'Колега');

    // Реєструємо/оновлюємо користувача в базі
    await queries.upsertUser(userId, firstName, username);

    const caption = ctx.message.caption?.trim();
    let captionSteps = null;
    if (caption) {
      const cleanedDigits = caption.replace(/\s+/g, '');
      if (/^\d{3,6}$/.test(cleanedDigits)) {
        const val = Number(cleanedDigits);
        if (val >= 100 && val <= 150000) {
          captionSteps = val;
        }
      }
    }

    // Якщо це альбом (кілька фото в одному повідомленні)
    const mediaGroupId = ctx.message.media_group_id;
    if (mediaGroupId) {
      if (!mediaGroupBuffer.has(mediaGroupId)) {
        mediaGroupBuffer.set(mediaGroupId, []);
        // Чекаємо 750мс, поки Telegram надішле всі елементи альбому
        setTimeout(() => {
          handleMediaGroupBatch(mediaGroupId).catch(err => {
            console.error('Помилка обробки альбому фото:', err);
          });
        }, 750);
      }
      mediaGroupBuffer.get(mediaGroupId).push({ ctx, captionSteps });
      return;
    }

    // Обробка поодинокого фото
    let detectedSteps = captionSteps;
    let source = captionSteps ? 'caption' : 'photo';
    let notes = captionSteps ? 'Вказано в описі фото' : '';

    let statusMsg = null;
    if (!detectedSteps) {
      if (!isGroup) {
        statusMsg = await ctx.reply('⏳ Аналізую фото через Vision AI... Зачекайте декілька секунд.');
      } else {
        try {
          await ctx.replyWithChatAction('typing');
        } catch {}
      }

      const rec = await downloadAndRecognizePhoto(ctx);
      if (rec && rec.steps > 0) {
        detectedSteps = rec.steps;
        notes = rec.notes;
      }
    }

    const tz = await queries.getSetting('timezone', 'Europe/Kyiv');
    const today = getTodayDateString(tz);
    const dailyGoal = Number(await queries.getSetting('daily_goal', '10000'));

    // Якщо число кроків успішно визначено:
    if (detectedSteps && detectedSteps > 0) {
      const current = await queries.getUserStepsForDate(userId, today);
      const previousSteps = current ? (Number(current.steps) || 0) : 0;

      if (previousSteps > 0) {
        // У користувача вже були кроки за сьогодні -> ДОПЛЮСОВУЄМО!
        const totalSteps = previousSteps + detectedSteps;
        await queries.saveDailySteps(
          userId,
          today,
          totalSteps,
          source,
          notes ? `${notes} (+${detectedSteps} до ${previousSteps})` : `Додано +${detectedSteps} до ${previousSteps}`
        );

        const replyText = formatStepSuccessMessage({
          name: firstName,
          username,
          steps: totalSteps,
          dailyGoal,
          previousSteps,
          addedSteps: detectedSteps,
        });

        if (isGroup) {
          return ctx.reply(replyText, {
            parse_mode: 'HTML',
            reply_parameters: { message_id: ctx.message.message_id },
          });
        } else {
          if (statusMsg) {
            await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, replyText, {
              parse_mode: 'HTML',
            });
          } else {
            await ctx.reply(replyText, {
              parse_mode: 'HTML',
            });
          }
        }
      } else {
        // Перший скріншот за сьогодні
        await queries.saveDailySteps(userId, today, detectedSteps, source, notes);

        const replyText = formatStepSuccessMessage({
          name: firstName,
          username,
          steps: detectedSteps,
          dailyGoal,
        });

        if (isGroup) {
          return ctx.reply(replyText, {
            parse_mode: 'HTML',
            reply_parameters: { message_id: ctx.message.message_id },
          });
        } else {
          if (statusMsg) {
            await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, replyText, {
              parse_mode: 'HTML',
            });
          } else {
            await ctx.reply(replyText, {
              parse_mode: 'HTML',
            });
          }
        }
      }
    } else {
      // Якщо не вдалося розпізнати
      if (isGroup) {
        return ctx.reply(
          `⚠️ <b>${name}</b>, не вдалося розпізнати число кроків на фото. Будь ласка, вкажіть число командою: <code>/steps 10500</code>`,
          {
            parse_mode: 'HTML',
            reply_parameters: { message_id: ctx.message.message_id },
          }
        );
      } else {
        const keyboard = new InlineKeyboard()
          .text('✏️ Ввести кроки вручну', `manual_input:${today}`)
          .text('❌ Закрити', 'cancel_action');

        const failText = `⚠️ Не вдалося розпізнати кроки на цьому зображенні.\n\nВи можете надіслати інший чіткий скріншот або ввести кількість кроків вручну.`;

        if (statusMsg) {
          await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, failText, {
            parse_mode: 'HTML',
            reply_markup: keyboard,
          });
        } else {
          await ctx.reply(failText, {
            parse_mode: 'HTML',
            reply_markup: keyboard,
          });
        }
      }
    }
  });

  // Кнопка заміни кроків лише на останній новий скріншот (якщо користувач не хотів плюсувати)
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
  bot.callbackQuery(/^manual_input:([\d-]+)$/, async (ctx) => {
    const date = ctx.match[1];
    const userId = ctx.from.id;

    userAwaitingManualInput.set(userId, { date });

    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `✏️ Надішліть число кроків за <b>${escapeHtml(formatUkrainianDate(date))}</b> звичайним повідомленням (наприклад: <code>10500</code> або <code>+3000</code>):\n<code>/steps 10500</code>`,
      { parse_mode: 'HTML' }
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
};
