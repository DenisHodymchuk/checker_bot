const { InlineKeyboard } = require('grammy');
const { config } = require('../config');
const { analyzeStepPhoto } = require('../services/gemini');
const queries = require('../db/queries');
const { escapeHtml } = require('../services/leaderboard');
const { getTodayDateString, formatUkrainianDate, formatNumber } = require('../utils/date');

// Зберігаємо тимчасовий стан користувачів для очікування ручного вводу
const userAwaitingManualInput = new Map();

/**
 * Реєстрація обробників фото та підтвердження
 */
function registerPhotoHandlers(bot) {
  // Обробка отриманого фото (як у групі, так і в приватних повідомленнях)
  bot.on('message:photo', async (ctx) => {
    const isGroup = ctx.chat.type !== 'private';
    const userId = ctx.from.id;
    const firstName = ctx.from.first_name || 'Колега';
    const username = ctx.from.username || null;
    const name = firstName ? escapeHtml(firstName) : (username ? '@' + escapeHtml(username) : 'Колега');

    // Реєструємо/оновлюємо користувача
    await queries.upsertUser(userId, firstName, username);

    const caption = ctx.message.caption?.trim();
    let detectedSteps = null;
    let source = 'photo';
    let notes = '';

    // 1. Перевіряємо, чи користувач вказав число в описі до фото (наприклад: "12272" або "12 272")
    if (caption) {
      const cleanedDigits = caption.replace(/\s+/g, '');
      if (/^\d{3,6}$/.test(cleanedDigits)) {
        const val = Number(cleanedDigits);
        if (val >= 100 && val <= 150000) {
          detectedSteps = val;
          source = 'caption';
          notes = 'Вказано в описі фото';
        }
      }
    }

    // 2. Якщо в описі числа немає — аналізуємо саме зображення через Gemini Vision
    let statusMsg = null;
    if (!detectedSteps) {
      if (!isGroup) {
        statusMsg = await ctx.reply('⏳ Аналізую фото через Vision AI... Зачекайте декілька секунд.');
      }

      try {
        const photos = ctx.message.photo;
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
          detectedSteps = result.steps;
          notes = result.notes || 'Розпізнано з фото';
        }
      } catch (err) {
        console.error('Помилка при аналізі фото:', err);
      }
    }

    const tz = await queries.getSetting('timezone', 'Europe/Kyiv');
    const today = getTodayDateString(tz);
    const dailyGoal = Number(await queries.getSetting('daily_goal', '10000'));

    // 3. Якщо число кроків отримано:
    if (detectedSteps && detectedSteps > 0) {
      await queries.saveDailySteps(userId, today, detectedSteps, source, notes);
      const percent = Math.round((detectedSteps / dailyGoal) * 100);
      const targetReached = detectedSteps >= dailyGoal ? ' 🎯' : '';

      if (isGroup) {
        // У групі — миттєва компактна відповідь
        const keyboard = new InlineKeyboard()
          .text('✏️ Змінити', `group_edit:${userId}:${today}`);

        return ctx.reply(
          `👟 <b>${name}</b> — <b>${formatNumber(detectedSteps)}</b> (${percent}%)${targetReached} зараховано!`,
          {
            parse_mode: 'HTML',
            reply_parameters: { message_id: ctx.message.message_id },
            reply_markup: keyboard,
          }
        );
      } else {
        // В особистих повідомленнях
        const replyText = 
          `🔍 <b>Результат розпізнавання:</b>\n\n` +
          `👟 Кількість кроків: <b>${formatNumber(detectedSteps)}</b>\n` +
          `📅 Дата: <b>${escapeHtml(formatUkrainianDate(today))}</b>\n\n` +
          `Зберегти цей результат?`;

        const keyboard = new InlineKeyboard()
          .text(`✅ Зберегти (${formatNumber(detectedSteps)} кр.)`, `save_steps:${detectedSteps}:${today}`)
          .row()
          .text('✏️ Ввести інше число', `manual_input:${today}`)
          .text('❌ Скасувати', 'cancel_action');

        if (statusMsg) {
          await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, replyText, {
            parse_mode: 'HTML',
            reply_markup: keyboard,
          });
        } else {
          await ctx.reply(replyText, {
            parse_mode: 'HTML',
            reply_markup: keyboard,
          });
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

  // Кнопка редагування в групі
  bot.callbackQuery(/^group_edit:(\d+):([\d-]+)$/, async (ctx) => {
    const targetUserId = Number(ctx.match[1]);
    const date = ctx.match[2];

    if (ctx.from.id !== targetUserId && config.adminId !== ctx.from.id) {
      return ctx.answerCallbackQuery({ text: 'Ви можете змінювати лише свій результат!', show_alert: true });
    }

    await ctx.answerCallbackQuery();
    await ctx.reply(
      `✏️ Щоб змінити свій результат, напишіть у відповідь команду: <code>/steps [число]</code>`,
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
    const goalReached = steps >= dailyGoal;

    let successMsg = `🎉 <b>Успішно збережено!</b>\n\n` +
      `📅 Дата: ${escapeHtml(formatUkrainianDate(date))}\n` +
      `👟 Кількість: <b>${formatNumber(steps)}</b> кроків\n`;

    if (goalReached) {
      successMsg += `🔥 <b>Вітаємо! Щоденну норму (${formatNumber(dailyGoal)}) виконано!</b> 🎯\n`;
    } else {
      const remaining = dailyGoal - steps;
      successMsg += `До норми залишилось: <b>${formatNumber(remaining)}</b> кроків. Продовжуйте рух! 💪\n`;
    }

    successMsg += `\nВаш результат буде враховано у загальному звіті команди.`;

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
      `✏️ Надішліть число кроків за <b>${escapeHtml(formatUkrainianDate(date))}</b> звичайним повідомленням (наприклад: <code>10500</code>) або напишіть команду:\n<code>/steps 10500</code>`,
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
