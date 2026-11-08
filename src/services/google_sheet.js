const https = require('node:https');
const crypto = require('node:crypto');
const { config } = require('../config');
const { isSupabase, sqliteDb, supabase } = require('../db/database');
const queries = require('../db/queries');
const { getTodayDateString } = require('../utils/date');

const DEFAULT_SHEET_ID = '1qWVTXOfVQzn9VLEUWdZvIOvZt_omcd8j0Yr5QilzNt4';
const DEFAULT_SHEET_GID = '1261303835';

// Актуальні дані з таблиці «Листопад кроки» (19 учасників) як резервна копія
const FALLBACK_NOVEMBER_ROWS = [
  { rowNumber: 3, penaltiesText: '0/2', username: '@stetsyuk_irka', name: 'Іра Стецюк', days: { 1: 10774, 2: 15024, 3: 11621, 4: 12632, 5: 15092 } },
  { rowNumber: 4, penaltiesText: '0/2', username: '@gorobetssvitlana', name: 'Світлана Горобець', days: { 1: 11150, 2: 10515, 3: 10169, 4: 10636, 5: 10018 } },
  { rowNumber: 5, penaltiesText: '0/2', username: '@kremeniuka', name: 'Аліна Кременюк', days: { 1: 10434, 2: 11741, 3: 11571, 4: 10200, 5: 10490 } },
  { rowNumber: 6, penaltiesText: '0/2', username: '@martyniukkristina', name: 'Крістіна Мартинюк', days: { 1: 12422, 2: 13412, 3: 11532, 4: 10837, 5: 13823 } },
  { rowNumber: 7, penaltiesText: '0/2', username: '@kovaltchukanastasia', name: 'Анастасія Ковальчук', days: { 1: 11831, 2: 10199, 3: 17006, 4: 12906, 5: 20214 } },
  { rowNumber: 8, penaltiesText: '0/2', username: '@victoriiaaaz', name: 'Вікторія Житкевич', days: { 1: 11283, 2: 14658, 3: 10589, 4: 14541, 5: 10962 } },
  { rowNumber: 9, penaltiesText: '0/2', username: '@olha_verbelchuk', name: 'Оля Вербельчук', days: { 1: 15834, 3: 5478, 4: 10643 } },
  { rowNumber: 10, penaltiesText: '0/2', username: '@topchiidiana', name: 'Діана Топчій', days: { 1: 15962, 2: 11080, 3: 13014, 4: 16922, 5: 10948 } },
  { rowNumber: 11, penaltiesText: '0/2', username: '@Lizadumnik', name: 'Ліза Думнік', days: { 1: 16386, 2: 16015, 3: 10049, 4: 10990, 5: 10095 } },
  { rowNumber: 12, penaltiesText: '0/2', username: '@rubachok_anna', name: 'Анна Рибачок', days: { 1: 14074, 2: 16088, 3: 12010, 4: 13103, 5: 11046 } },
  { rowNumber: 13, penaltiesText: '0/2', username: '@shevchenko_ivanna', name: 'Іванка Мельник', days: { 1: 10048, 2: 10038, 3: 10656, 4: 9510, 5: 10434 } },
  { rowNumber: 14, penaltiesText: '0/2', username: '@Shaadrin', name: 'Женя Шадрін', days: { 5: 19249 } },
  { rowNumber: 15, penaltiesText: '0/2', username: '', name: 'Аня Андрон', days: { 1: 13250, 2: 11241, 3: 12918, 4: 11405, 5: 11883 } },
  { rowNumber: 16, penaltiesText: '0/2', username: '@kseeenkaaa', name: 'Оксана Слободянюк', days: { 1: 6401, 2: 11940, 3: 10130, 4: 10793, 5: 10162 } },
  { rowNumber: 17, penaltiesText: '0/2', username: '@vinskevych', name: 'Зоряна Опенько', days: {} },
  { rowNumber: 18, penaltiesText: '0/2', username: '@daria_korolivska', name: 'Даша Королівська', days: { 1: 14511, 2: 12463, 3: 14053, 4: 13453, 5: 12988 } },
  { rowNumber: 19, penaltiesText: '0/2', username: '@hey_aleksandraa', name: 'Саша Онистюк', days: { 1: 11561, 2: 5843, 3: 4614 } },
  { rowNumber: 20, penaltiesText: '0/2', username: '@kseni_stet', name: 'Оксана Стецюк', days: { 4: 12161, 5: 10824 } },
  { rowNumber: 21, penaltiesText: '0/2', username: '@dariyaaa_a', name: 'Даша Яковлева', days: { 1: 10200, 2: 3309, 3: 10796, 4: 10110, 5: 10249 } },
];

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchText(res.headers.location));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function cleanStepNum(str) {
  if (str === null || str === undefined) return null;
  const cleaned = String(str).replace(/\s+/g, '').replace(/\u00A0/g, '').trim();
  if (!cleaned) return null;
  const num = parseInt(cleaned, 10);
  return !isNaN(num) && num >= 0 ? num : null;
}

/**
 * Обчислює 1-базований номер колонки у таблиці для дня d (1..31)
 * Дні йдуть блоками по 5 днів, після кожного 5-денного блоку — 1 колонка суми.
 * День 1 -> col 5 (E), День 5 -> col 9 (I), col 10 (J) = сума, День 6 -> col 11 (K)...
 */
function getDayColumnNumber1Based(dayNum) {
  const d = Number(dayNum);
  return 4 + d + Math.floor((d - 1) / 5);
}

/**
 * Перетворює 1-базований номер колонки у літеру Google Sheets (1 -> A, 2 -> B, 27 -> AA)
 */
function colNumberToLetter(colNum) {
  let temp;
  let letter = '';
  let n = colNum;
  while (n > 0) {
    temp = (n - 1) % 26;
    letter = String.fromCharCode(temp + 65) + letter;
    n = (n - temp - 1) / 26;
  }
  return letter;
}

/**
 * Розбирає CSV текст Google Таблиці у список учасників та їхніх кроків по днях
 */
function parseSheetCsv(csvText) {
  const lines = csvText.split(/\r?\n/);
  if (lines.length < 3) return FALLBACK_NOVEMBER_ROWS;

  // Знаходимо рядок заголовків із числами місяця (1..30/31)
  let headerRowIdx = 1;
  for (let r = 0; r < Math.min(5, lines.length); r++) {
    const parts = lines[r].split(',');
    if ((parts[1] && parts[1].toLowerCase().includes('штраф')) || (parts[4] && parts[4].trim() === '1')) {
      headerRowIdx = r;
      break;
    }
  }

  const headerParts = lines[headerRowIdx].split(',');
  const colToDay = {}; // { colIndex0Based: dayNumber }
  for (let c = 4; c < headerParts.length; c++) {
    const cell = (headerParts[c] || '').trim();
    if (/^\d{1,2}$/.test(cell)) {
      const d = Number(cell);
      if (d >= 1 && d <= 31) {
        colToDay[c] = d;
      }
    }
  }

  // Якщо раптом у заголовку не розпізнано жодного дня, використовуємо стандартну формулу блоків по 5 днів
  if (Object.keys(colToDay).length === 0) {
    for (let d = 1; d <= 30; d++) {
      const col0 = getDayColumnNumber1Based(d) - 1;
      colToDay[col0] = d;
    }
  }

  const participants = [];
  for (let r = headerRowIdx + 1; r < lines.length; r++) {
    const parts = lines[r].split(',');
    if (parts.length < 4) continue;

    const penaltiesText = (parts[1] || '').trim();
    const usernameRaw = (parts[2] || '').trim();
    const nameRaw = (parts[3] || '').trim();

    // Зупиняємось на нижньому підсумковому рядку "штрафні дні"
    if (penaltiesText.toLowerCase().includes('штраф')) {
      break;
    }

    // Пропускаємо порожні рядки, де немає ані @username, ані імені учасника
    if (!usernameRaw.startsWith('@') && !nameRaw) {
      continue;
    }

    const days = {};
    for (const [colStr, dayNum] of Object.entries(colToDay)) {
      const colIdx = Number(colStr);
      const val = cleanStepNum(parts[colIdx]);
      if (val !== null && val > 0) {
        days[dayNum] = val;
      }
    }

    participants.push({
      rowNumber: r + 1, // 1-based row number in Google Sheet
      penaltiesText: penaltiesText || '0/2',
      username: usernameRaw,
      name: nameRaw || usernameRaw.replace(/^@/, ''),
      days,
    });
  }

  return participants.length > 0 ? participants : FALLBACK_NOVEMBER_ROWS;
}

/**
 * Завантажує та парсить поточні дані з Google Таблиці
 */
async function fetchSheetParticipants() {
  const sheetId = (await queries.getSetting('google_sheet_id', DEFAULT_SHEET_ID)) || DEFAULT_SHEET_ID;
  const gid = (await queries.getSetting('google_sheet_gid', DEFAULT_SHEET_GID)) || DEFAULT_SHEET_GID;
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;

  const csvData = await fetchText(url);
  return parseSheetCsv(csvData);
}

/**
 * Надсилає оновлення у Google Apps Script Web App (з підтримкою редіректів script.google.com)
 */
async function postToAppsScript(scriptUrl, payloadObj) {
  const body = JSON.stringify(payloadObj);
  const response = await fetch(scriptUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    redirect: 'follow',
  });
  if (!response.ok) {
    throw new Error(`Apps Script HTTP ${response.status}`);
  }
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { ok: true, raw: text };
  }
}

/**
 * Отримує OAuth2 токен із Service Account JSON (якщо налаштовано)
 */
async function getServiceAccountToken(saJsonStr) {
  const sa = typeof saJsonStr === 'string' ? JSON.parse(saJsonStr) : saJsonStr;
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claim = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  })).toString('base64url');

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${header}.${claim}`);
  const signature = sign.sign(sa.private_key, 'base64url');
  const jwt = `${header}.${claim}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error(data.error_description || 'Не вдалося отримати токен Service Account');
  }
  return data.access_token;
}

/**
 * Записує оновлення (кроки та штрафні дні) у Google Таблицю
 * Підтримує:
 * 1) Google Apps Script Web App URL (google_script_url / GOOGLE_SCRIPT_URL)
 * 2) Google Service Account JSON (GOOGLE_SERVICE_ACCOUNT_JSON)
 */
async function pushUpdatesToGoogleSheet(updates) {
  if (!Array.isArray(updates) || updates.length === 0) {
    return { pushed: false, reason: 'no_updates' };
  }

  let scriptUrl = (await queries.getSetting('google_script_url', config.googleScriptUrl || '')).trim();
  if (!scriptUrl) {
    scriptUrl = (config.googleScriptUrl || '').trim();
  }
  const gid = (await queries.getSetting('google_sheet_gid', DEFAULT_SHEET_GID)) || DEFAULT_SHEET_GID;

  if (scriptUrl) {
    try {
      const res = await postToAppsScript(scriptUrl, {
        action: 'sync_records',
        gid,
        updates,
      });
      return { pushed: true, method: 'apps_script', result: res };
    } catch (err) {
      console.warn('[GoogleSheet] Помилка запису через Apps Script:', err.message);
    }
  }

  const saRaw = (await queries.getSetting('google_service_account', config.googleServiceAccountJson || '')).trim();
  if (saRaw) {
    try {
      const sheetId = (await queries.getSetting('google_sheet_id', DEFAULT_SHEET_ID)) || DEFAULT_SHEET_ID;
      const token = await getServiceAccountToken(saRaw);
      const participants = await fetchSheetParticipants();

      const valueRanges = [];
      for (const u of updates) {
        const cleanHandle = u.username ? ('@' + String(u.username).replace(/^@/, '').trim()).toLowerCase() : '';
        const cleanName = (u.name || '').trim().toLowerCase();

        const rowObj = participants.find(p => {
          if (cleanHandle && p.username && p.username.toLowerCase() === cleanHandle) return true;
          if (cleanName && p.name && (p.name.toLowerCase() === cleanName || p.name.toLowerCase().startsWith(cleanName) || cleanName.startsWith(p.name.toLowerCase()))) return true;
          return false;
        });
        if (!rowObj) continue;

        const rNum = rowObj.rowNumber;
        if (u.penaltiesText) {
          valueRanges.push({
            range: `B${rNum}`,
            values: [[`'${u.penaltiesText}`]],
          });
        }
        if (u.username && !rowObj.username) {
          valueRanges.push({
            range: `C${rNum}`,
            values: [[`@${String(u.username).replace(/^@/, '').trim()}`]],
          });
        }
        if (u.days) {
          for (const [dayKey, stepVal] of Object.entries(u.days)) {
            if (stepVal !== null && stepVal !== undefined) {
              const colNum = getDayColumnNumber1Based(Number(dayKey));
              const colLet = colNumberToLetter(colNum);
              valueRanges.push({
                range: `${colLet}${rNum}`,
                values: [[Number(stepVal)]],
              });
            }
          }
        }
      }

      if (valueRanges.length > 0) {
        const apiRes = await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchUpdate`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              valueInputOption: 'USER_ENTERED',
              data: valueRanges,
            }),
          }
        );
        const apiData = await apiRes.json();
        return { pushed: true, method: 'service_account', result: apiData };
      }
    } catch (err) {
      console.warn('[GoogleSheet] Помилка запису через Service Account:', err.message);
    }
  }

  return { pushed: false, reason: 'not_configured' };
}

/**
 * Автоматично синхронізує кроки конкретного учасника за вказану дату та його актуальні штрафні дні (X/2) у Google Таблицю
 */
async function syncUserStepsToSheet(userId, date, steps) {
  const user = await queries.getUser(userId);
  if (!user) return;

  const yearMonth = String(date).slice(0, 7);
  const dayNum = Number(String(date).slice(8, 10));
  if (!dayNum || dayNum < 1 || dayNum > 31) return;

  const stats = await queries.getUserMonthStats(userId, yearMonth);
  const penaltiesText = stats ? `${stats.missedDays}/${stats.graceLimit}` : '0/2';

  await pushUpdatesToGoogleSheet([
    {
      username: user.username ? `@${user.username}` : '',
      name: user.first_name,
      penaltiesText,
      days: { [dayNum]: Number(steps) },
    },
  ]);
}

/**
 * Оновлює всі кроки та колонку "штрафні дні" (X/2) для всіх активних учасників у Google Таблиці
 */
async function syncAllUsersToSheet(yearMonth = null, options = {}) {
  const tz = await queries.getSetting('timezone', 'Europe/Kyiv');
  const today = getTodayDateString(tz);
  const targetMonth = yearMonth || today.slice(0, 7);
  const monthStart = `${targetMonth}-01`;
  const monthEnd = `${targetMonth}-31`;

  const statsList = await queries.getAllUsersMonthStats(targetMonth, today, options);
  const updates = [];

  for (const s of statsList) {
    const u = s.user;
    const daysObj = {};

    // Збираємо всі збережені в БД кроки за цей місяць
    for (const d of s.daysBreakdown) {
      if (d.date >= monthStart && d.date <= monthEnd && d.steps > 0) {
        const dayNum = Number(d.date.slice(8, 10));
        daysObj[dayNum] = d.steps;
      }
    }

    updates.push({
      username: u.username ? `@${u.username}` : '',
      name: u.first_name,
      penaltiesText: `${s.missedDays}/${s.graceLimit}`,
      days: daysObj,
    });
  }

  return pushUpdatesToGoogleSheet(updates);
}

/**
 * Повна двостороння синхронізація між Google Таблицею та базою даних бота:
 * 1. Завантажує учасників і кроки з Google Таблиці (за поточний місяць, напр. 2026-11).
 * 2. Активує всіх учасників з таблиці (включно з тими, у кого ще не вписано @username, як-от Аня Андрон),
 *    деактивуючи старих учасників з минулих місяців, яких немає в новій таблиці.
 * 3. Звіряє кроки за всі попередні дні:
 *    - де в таблиці є кроки — записує в БД бота;
 *    - де в БД бота вже є розпізнані кроки, а в таблиці порожньо — дописує в таблицю.
 * 4. Перераховує штрафні/пільгові дні (X/2) за правилом 12:00 наступного дня і оновлює таблицю.
 */
async function runImport(options = {}) {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📥 Синхронізація та звірка з Google Таблицею...');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  let participants = [];
  try {
    participants = await fetchSheetParticipants();
    console.log(`✅ Завантажено ${participants.length} учасників із онлайн Google Таблиці.`);
  } catch (err) {
    console.warn(`⚠️ Не вдалося завантажити онлайн: ${err.message}. Використовуємо резервний знімок таблиці.`);
    participants = FALLBACK_NOVEMBER_ROWS;
  }

  const tz = await queries.getSetting('timezone', 'Europe/Kyiv');
  const today = getTodayDateString(tz);
  const baseYearMonth = options.yearMonth || today.slice(0, 7) || '2026-11';
  const monthStart = `${baseYearMonth}-01`;

  // Очищаємо кроки за старі місяці (наприклад, жовтень), якщо почався новий місяць челенджу
  if (isSupabase) {
    await supabase.from('daily_steps').delete().lt('date', monthStart);
  } else if (sqliteDb) {
    sqliteDb.prepare(`DELETE FROM daily_steps WHERE date < ?`).run(monthStart);
  }

  // Спочатку робимо всіх поточних користувачів неактивними, щоб активними залишилися лише учасники поточної таблиці
  const existingUsers = await queries.getAllUsers();
  for (const eu of existingUsers) {
    await queries.setUserActive(eu.id, false);
  }

  let totalStepsImported = 0;
  let totalUsersProcessed = 0;

  for (let i = 0; i < participants.length; i++) {
    const p = participants[i];
    const cleanUsername = p.username ? p.username.replace(/^@/, '').trim() : null;
    const cleanName = (p.name || '').trim();

    let existing = null;
    if (cleanUsername) {
      existing = await queries.findUserByHandleOrId(cleanUsername);
    }
    if (!existing && cleanName) {
      existing = await queries.findUserByHandleOrId(cleanName);
    }

    const userId = existing ? existing.id : (2001 + i);
    const resolvedUsername = cleanUsername || existing?.username || null;
    const resolvedName = cleanName || existing?.first_name || `Учасник ${i + 1}`;

    if (isSupabase) {
      await supabase.from('users').upsert({
        id: userId,
        first_name: resolvedName,
        username: resolvedUsername,
        is_active: 1,
        created_at: `${baseYearMonth}-01 00:00:00`,
      }, { onConflict: 'id' });
    } else if (sqliteDb) {
      sqliteDb.prepare(`
        INSERT INTO users (id, first_name, username, is_active, created_at)
        VALUES (?, ?, ?, 1, ?)
        ON CONFLICT(id) DO UPDATE SET
          first_name = excluded.first_name,
          username = COALESCE(excluded.username, users.username),
          is_active = 1,
          created_at = excluded.created_at;
      `).run(userId, resolvedName, resolvedUsername, `${baseYearMonth}-01 00:00:00`);
    }

    totalUsersProcessed++;

    // Звіряємо кроки по кожному дню місяця
    for (const [dayKey, sheetSteps] of Object.entries(p.days)) {
      const dayNum = Number(dayKey);
      if (!dayNum || dayNum < 1 || dayNum > 31 || !sheetSteps) continue;
      const dateStr = `${baseYearMonth}-${String(dayNum).padStart(2, '0')}`;

      const currentInDb = await queries.getUserStepsForDate(userId, dateStr);
      // Якщо в таблиці є значення і воно відрізняється від БД — беремо значення з Google Таблиці як еталон
      if (!currentInDb || Number(currentInDb.steps) !== Number(sheetSteps)) {
        await queries.saveDailySteps(
          userId,
          dateStr,
          sheetSteps,
          'google_sheet',
          'Звірено з Google Таблицею'
        );
        totalStepsImported++;
      }
    }
  }

  // Переконуємось, що адмін (@Godymchuk_D_D) не в списку учасників челенджу
  const adminUser = await queries.findUserByHandleOrId('Godymchuk_D_D');
  if (adminUser && adminUser.username?.toLowerCase() === 'godymchuk_d_d') {
    await queries.setUserActive(adminUser.id, false);
  }

  // Відправляємо зворотну синхронізацію в таблицю (щоб оновити штрафні дні X/2 та кроки з БД, яких ще не було в таблиці)
  const pushRes = await syncAllUsersToSheet(baseYearMonth);

  console.log(`🎉 Синхронізацію завершено: ${totalUsersProcessed} учасників, ${totalStepsImported} записів кроків звірено.`);
  return {
    totalUsersProcessed,
    totalStepsImported,
    pushResult: pushRes,
  };
}

module.exports = {
  DEFAULT_SHEET_ID,
  DEFAULT_SHEET_GID,
  FALLBACK_NOVEMBER_ROWS,
  getDayColumnNumber1Based,
  colNumberToLetter,
  parseSheetCsv,
  fetchSheetParticipants,
  pushUpdatesToGoogleSheet,
  syncUserStepsToSheet,
  syncAllUsersToSheet,
  runImport,
};
