const queries = require('../db/queries');

const TARGET_STEPS_KEYWORD = 'скріни кроків';

/**
 * Витягує назву гілки (теми форуму) з повідомлення Telegram, якщо вона присутня в об'єкті повідомлення
 */
function extractTopicName(ctx) {
  const msg = ctx.message || ctx.msg || ctx.callbackQuery?.message;
  if (!msg) return '';
  const rawName =
    msg.reply_to_message?.forum_topic_created?.name ||
    msg.reply_to_message?.forum_topic_edited?.name ||
    msg.forum_topic_created?.name ||
    msg.forum_topic_edited?.name ||
    '';
  return rawName.trim();
}

/**
 * Перевіряє, чи назва гілки відповідає цільовій гілці «скріни кроків»
 */
function isStepsTopicName(name) {
  if (!name) return false;
  return name.toLowerCase().includes(TARGET_STEPS_KEYWORD);
}

/**
 * Отримує словник відомих гілок групи з налаштувань: { [threadId]: "Назва гілки" }
 */
async function getKnownTopics() {
  try {
    const raw = await queries.getSetting('known_topics', '{}');
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

/**
 * Зберігає або оновлює інформацію про гілку в списку відомих гілок групи
 */
async function saveKnownTopic(threadId, name) {
  if (!threadId) return;
  const tid = String(threadId);
  const topics = await getKnownTopics();
  const cleanName = name ? name.trim() : '';

  if (cleanName && topics[tid] !== cleanName) {
    topics[tid] = cleanName;
    await queries.setSetting('known_topics', JSON.stringify(topics));
  } else if (!topics[tid]) {
    topics[tid] = `Гілка #${tid}`;
    await queries.setSetting('known_topics', JSON.stringify(topics));
  }
}

/**
 * Фіксує гілку при будь-якому повідомленні в групі та автоматично розпізнає гілки за назвами, якщо вони ще не налаштовані
 */
async function trackGroupTopic(ctx) {
  if (!ctx.chat || ctx.chat.type === 'private') return;

  const msg = ctx.message || ctx.msg || ctx.callbackQuery?.message;
  const threadId = msg?.message_thread_id ? String(msg.message_thread_id) : null;
  const topicName = extractTopicName(ctx);

  if (threadId) {
    await saveKnownTopic(threadId, topicName);
  }

  if (!topicName || !threadId) return;
  const lower = topicName.toLowerCase();

  // Автоприв'язка гілки «скріни кроків», якщо ще не задана
  if (lower.includes('скріни кроків') || lower.includes('скріни')) {
    const savedStepsTopic = await queries.getSetting('steps_topic_id', '');
    if (!savedStepsTopic) {
      await queries.setSetting('steps_topic_id', threadId);
      console.log(`[Topic] Автоматично призначено гілку для скрінів: «${topicName}» (${threadId})`);
    }
    const savedGroupId = await queries.getSetting('group_chat_id', '');
    if (!savedGroupId) {
      await queries.setSetting('group_chat_id', String(ctx.chat.id));
    }
  }

  // Автоприв'язка гілки для звітів, якщо в назві є "звіт" і вона ще не задана
  if (lower.includes('звіт')) {
    const savedReportsTopic = await queries.getSetting('reports_topic_id', '');
    if (!savedReportsTopic) {
      await queries.setSetting('reports_topic_id', threadId);
      console.log(`[Topic] Автоматично призначено гілку для звітів: «${topicName}» (${threadId})`);
    }
  }

  // Автоприв'язка гілки для штрафів, якщо в назві є "штраф" або "банк" і вона ще не задана
  if (lower.includes('штраф') || lower.includes('банк')) {
    const savedPenaltiesTopic = await queries.getSetting('penalties_topic_id', '');
    if (!savedPenaltiesTopic) {
      await queries.setSetting('penalties_topic_id', threadId);
      console.log(`[Topic] Автоматично призначено гілку для штрафів: «${topicName}» (${threadId})`);
    }
  }
}

/**
 * Перевіряє, чи дозволено сканувати фото / приймати кроки у поточному чаті або гілці.
 * Дозволено:
 * 1) В особистих повідомленнях з ботом (private)
 * 2) У гілці для скрінів кроків (steps_topic_id або за назвою «скріни кроків»)
 */
async function isAllowedStepsTopic(ctx) {
  if (!ctx.chat) return false;

  // 1. Особисті повідомлення з ботом завжди дозволені
  if (ctx.chat.type === 'private') {
    return true;
  }

  await trackGroupTopic(ctx);

  const msg = ctx.message || ctx.msg;
  const threadId = msg?.message_thread_id ? String(msg.message_thread_id) : null;
  const topicName = extractTopicName(ctx);

  const savedTopicId = await queries.getSetting('steps_topic_id', '');
  const savedGroupId = await queries.getSetting('group_chat_id', '');

  // 2. Якщо в налаштуваннях явно обрано "general" (основний чат без гілки)
  if (savedTopicId === 'general' && !threadId) {
    if (!savedGroupId || String(ctx.chat.id) === String(savedGroupId)) {
      return true;
    }
  }

  // 3. Якщо вже збережено конкретний ID гілки для скрінів — перевіряємо точний збіг
  if (savedTopicId && savedTopicId !== 'general') {
    if (threadId && threadId === String(savedTopicId)) {
      if (!savedGroupId || String(ctx.chat.id) === String(savedGroupId)) {
        return true;
      }
    }
    // Якщо в повідомленні передано назву «скріни кроків», оновлюємо ID (на випадок перестворення гілки)
    if (topicName && isStepsTopicName(topicName) && threadId) {
      await queries.setSetting('steps_topic_id', threadId);
      await saveKnownTopic(threadId, topicName);
      return true;
    }
    return false;
  }

  // 4. Якщо steps_topic_id ще не налаштований, дозволяємо лише гілку з назвою «скріни кроків»
  if (topicName && isStepsTopicName(topicName)) {
    if (threadId) {
      await queries.setSetting('steps_topic_id', threadId);
      await saveKnownTopic(threadId, topicName);
      if (savedGroupId !== String(ctx.chat.id)) {
        await queries.setSetting('group_chat_id', String(ctx.chat.id));
      }
    }
    return true;
  }

  return false;
}

/**
 * Повертає числовий message_thread_id для потрібного типу повідомлень (або undefined для General)
 * @param {'steps'|'reports'|'penalties'|'reminders'} role
 */
async function resolveTopicThreadId(role) {
  const settings = await queries.getAllSettings();
  let rawId = '';

  if (role === 'steps') {
    rawId = settings.steps_topic_id || '';
  } else if (role === 'reports') {
    rawId = settings.reports_topic_id || settings.steps_topic_id || '';
  } else if (role === 'penalties') {
    rawId = settings.penalties_topic_id || settings.reports_topic_id || settings.steps_topic_id || '';
  } else if (role === 'reminders') {
    rawId = settings.reminders_topic_id || settings.steps_topic_id || settings.reports_topic_id || '';
  }

  if (!rawId || rawId === 'general') {
    return undefined;
  }
  const num = Number(rawId);
  return !isNaN(num) && num > 0 ? num : undefined;
}

/**
 * Форматує зрозумілу назву гілки для відображення в меню налаштувань
 */
function formatTopicLabel(topicId, knownTopics = {}, fallbackLabel = 'Авто / За замовчуванням') {
  if (!topicId) return `🔍 ${fallbackLabel}`;
  if (topicId === 'general') return '💬 Основний чат (General)';
  const name = knownTopics[String(topicId)];
  return name ? `📌 «${name}» (ID: ${topicId})` : `📌 Гілка ID: ${topicId}`;
}

module.exports = {
  extractTopicName,
  isStepsTopicName,
  getKnownTopics,
  saveKnownTopic,
  trackGroupTopic,
  isAllowedStepsTopic,
  resolveTopicThreadId,
  formatTopicLabel,
};
