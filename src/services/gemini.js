const { GoogleGenAI } = require('@google/genai');
const { config } = require('../config');

let aiInstance = null;

function getAiClient() {
  if (!config.geminiApiKey) {
    throw new Error('GEMINI_API_KEY не налаштовано в .env');
  }
  if (!aiInstance) {
    aiInstance = new GoogleGenAI({ apiKey: config.geminiApiKey });
  }
  return aiInstance;
}

const PROMPT_INSTRUCTIONS = `
Ти — високоточний асистент для аналізу зображень фітнес-трекерів, смарт-годинників та крокомірів.
Користувачі надсилають скріншоти або фото екранів своїх додатків (Apple Health, Garmin, Mi Fitness, Zepp, Samsung Health, Huawei Health, Strava, Google Fit, крокоміри, фото годинників Apple Watch, Garmin, Mi Band тощо).

Твоє завдання:
1. Знайти поточну кількість ПРОЙДЕНИХ КРОКІВ (steps) на зображенні.
2. Будь максимально уважним і НЕ переплутай кількість кроків із:
   - дистанцією в кілометрах (наприклад, 8.42 km);
   - спаленими калоріями (наприклад, 450 kcal);
   - пульсом (bpm);
   - часом активності (хвилини, години);
   - ціллю (goal), наприклад, якщо вказано "Ціль: 10 000", а поруч реальне число "8 350", повертай саме реальні кроки: 8350.
3. Фітнес-додатки зазвичай не показують рік на екрані. Якщо повний рік не вказано чітко цифрою на екрані (наприклад, написано просто "11 жов.", "Сьогодні", "середа"), став "date": null. Не вигадуй минулі роки.
4. Визнач назву додатку чи пристрою, якщо це видно (наприклад, "Apple Health", "Mi Fitness", "Samsung Health", "Garmin", "Смарт-годинник").

Відповідь ОБОВ'ЯЗКОВО надай у форматі JSON за такою схемою:
{
  "success": true, // true, якщо знайдено число кроків; false, якщо на фото зовсім немає кроків/фітнесу
  "steps": 12450, // ціле число кроків (integer), без слів, без ком чи пробілів
  "date": "2026-10-11", // дата у форматі YYYY-MM-DD або null
  "appName": "Apple Health", // назва додатку або null
  "notes": "Короткий опис українською (наприклад: 'Знайдено 12 450 кроків у Apple Health')"
}

Якщо зображення не стосується фітнесу або число кроків неможливо прочитати:
{
  "success": false,
  "steps": 0,
  "date": null,
  "appName": null,
  "notes": "Не вдалося розпізнати кількість кроків на цьому зображенні. Спробуйте надіслати чіткіший скріншот."
}
`;

/**
 * Аналізує зображення за допомогою Google Gemini Vision
 * @param {Buffer} imageBuffer - бінарні дані зображення
 * @param {string} mimeType - MIME тип зображення (наприклад, 'image/jpeg' або 'image/png')
 * @returns {Promise<{success: boolean, steps: number, date: string|null, appName: string|null, notes: string}>}
 */
async function analyzeStepPhoto(imageBuffer, mimeType = 'image/jpeg') {
  const ai = getAiClient();
  const base64Data = imageBuffer.toString('base64');

  const modelsToTry = ['gemini-2.5-flash', 'gemini-1.5-flash', 'gemini-2.0-flash'];
  let lastError = null;

  for (const model of modelsToTry) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: [
          {
            inlineData: {
              mimeType: mimeType || 'image/jpeg',
              data: base64Data,
            },
          },
          {
            text: PROMPT_INSTRUCTIONS,
          },
        ],
        config: {
          responseMimeType: 'application/json',
          temperature: 0.1, // низька температура для максимальної точності
        },
      });

      const text = response.text?.trim();
      if (!text) {
        throw new Error('Порожня відповідь від Gemini API');
      }

      const parsed = JSON.parse(text);
      if (parsed.success && typeof parsed.steps === 'number' && parsed.steps > 0) {
        return {
          success: true,
          steps: Math.round(parsed.steps),
          date: parsed.date || null,
          appName: parsed.appName || null,
          notes: parsed.notes || `Розпізнано ${parsed.steps} кроків`,
        };
      }

      return {
        success: false,
        steps: 0,
        date: null,
        appName: null,
        notes: parsed.notes || 'Не вдалося розпізнати кроки на зображенні',
      };
    } catch (err) {
      lastError = err;
      // Якщо помилка пов'язана з конкретною назвою моделі, спробуємо наступну в списку
      console.warn(`Помилка запиту до моделі ${model}:`, err.message);
    }
  }

  throw new Error(`Не вдалося проаналізувати зображення через Gemini API: ${lastError?.message || 'невідома помилка'}`);
}

module.exports = {
  analyzeStepPhoto,
};
