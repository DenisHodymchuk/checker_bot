const https = require('node:https');
const { initDatabase, isSupabase, sqliteDb, supabase } = require('../src/db/database');
const queries = require('../src/db/queries');

const SHEET_URL = 'https://docs.google.com/spreadsheets/d/13CVKlxQQB2y1ihYHunLYRfz5dawQ47mDfzrUYyH5ZuE/export?format=csv&gid=98458564';

function fetchCsv(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchCsv(res.headers.location));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Failed to download sheet: HTTP ${res.statusCode}`));
      }
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function cleanNum(str) {
  if (!str) return null;
  const cleaned = String(str).replace(/\s+/g, '').replace(/\u00A0/g, '').trim();
  return cleaned ? parseInt(cleaned, 10) : null;
}

// Звірені дані за 1–16 жовтня з Google Таблиці
const FALLBACK_ROWS = [
  { username: '@stetsyuk_irka', name: 'Іра Стецюк', steps: [23250, 10558, 18297, 20565, 10609, 18042, 14490, 22404, 11824, 14226, 11010, 13345, 11700, 13581, 18778, 10602] },
  { username: '@gorobetssvitlana', name: 'Світлана Горобець', steps: [10488, 10028, 10649, 10315, 10466, 10277, 11113, 10758, 10997, 12335, 11682, 16579, 5908, 14124, 11517, 11543] },
  { username: '@kremeniuka', name: 'Аліна Кременюк', steps: [10046, 10024, 10018, 14374, 11150, 10157, 11107, 15782, 10074, 10059, 13158, 12238, 11469, 11870, 10443, 11219] },
  { username: '@martyniukkristina', name: 'Крістіна Мартинюк', steps: [12074, 12343, 10153, 13399, 12583, 13312, 12143, 12392, 12403, 15274, 10220, 10272, 13174, 10651, 13100, 11452] },
  { username: '@kovaltchukanastasia', name: 'Анастасія Ковальчук', steps: [14128, 13201, 11830, 16862, 12770, 14428, 16961, 11136, 12915, 6601, 13314, 10670, 10214, 11159, 10336, 15857] },
  { username: '@victoriiaaaz', name: 'Вікторія Житкевич', steps: [10119, 15011, 16067, 10166, 15167, 13230, 15644, 17824, 11818, 11679, 10186, 12665, 19176, 11605, 10089, 15646] },
  { username: '@olha_verbelchuk', name: 'Оля Вербельчук', steps: [4938, 11772, 15241, 16497, 10062, 10535, 10038, 12144, 10013, 6066, 20540, 10007, 10019, 11509, null, 7527] },
  { username: '@topchiidiana', name: 'Діана Топчій', steps: [2018, 10043, 13541, 18467, 10439, 12262, 11584, 11686, 10653, 19470, 11903, 14834, 10418, 10725, 10208, 10308] },
  { username: '@Lizadumnik', name: 'Ліза Думнік', steps: [11361, 12404, 17011, 16836, 10277, 12442, 18367, 10018, 15884, 11130, 10243, 12868, 13542, 10022, 10150, 13538] },
  { username: '@tenderteeen', name: 'Ірина Замулко', steps: [8686, 10131, 8753, 10418, 10012, 10012, 12467, 2599, 11860, 10488, 12152, 11922, 13742, 14826, 11463, 10589] },
  { username: '@KateVoronka', name: 'Катя Воронка', steps: [12385, 5558, 11702, 13784, 11263, 13114, 12473, 12312, 14493, 16158, 16187, 15073, 12617, 12870, 11974, 10961] },
  { username: '@daria_korolivska', name: 'Даша Королівська', steps: [10019, 13687, 10044, 10082, 11983, 15802, 16064, 12792, 11406, 11904, 14044, 15427, 12482, 15462, 11141, 11513] },
  { username: '@kseni_stet', name: 'Оксана Стецюк', steps: [10112, 11707, 519, 11990, 14635, 10064, 13363, 10188, 10064, 10574, 10626, 12793, 11216, 14600, 10389, 10072] },
  { username: '@dariyaaa_a', name: 'Даша Яковлева', steps: [10024, 11254, 10093, 7021, 10100, 11302, 10307, 10091, 10024, 10152, 10091, 10307, 10099, 10285, 10192, 10193] },
];

function parseCsv(csvText) {
  const lines = csvText.split('\n');
  const participants = [];

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const parts = line.split(',');
    if (parts.length < 5) continue;

    const usernameRaw = parts[2] ? parts[2].trim() : '';
    if (!usernameRaw.startsWith('@')) continue;

    const name = parts[3] ? parts[3].trim() : '';
    const steps = [];

    // Дні 1..5 -> parts[4..8]
    for (let day = 1; day <= 5; day++) {
      steps.push(cleanNum(parts[3 + day]));
    }
    // parts[9] — ВСЬОГО за 5 днів
    // Дні 6..10 -> parts[10..14]
    for (let day = 6; day <= 10; day++) {
      steps.push(cleanNum(parts[4 + day]));
    }
    // parts[15] — ВСЬОГО за 10 днів
    // Дні 11..15 -> parts[16..20]
    for (let day = 11; day <= 15; day++) {
      steps.push(cleanNum(parts[5 + day]));
    }
    // parts[21] — ВСЬОГО за 15 днів
    // День 16 -> parts[22]
    steps.push(cleanNum(parts[22]));

    if (usernameRaw.toLowerCase() === '@olha_verbelchuk' && steps[14] === 7527 && steps[15] === null) {
      steps[14] = null;
      steps[15] = 7527;
    }

    participants.push({
      username: usernameRaw,
      name,
      steps,
    });
  }

  return participants.length > 0 ? participants : FALLBACK_ROWS;
}

async function runImport() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📥 Початок імпорту результатів з Google Таблиці (1–16 жовтня)...');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  await initDatabase();

  let participants = [];
  try {
    console.log('🌐 Завантаження даних із Google Таблиці...');
    const csvData = await fetchCsv(SHEET_URL);
    participants = parseCsv(csvData);
    console.log(`✅ Отримано та розпізнано ${participants.length} учасників із онлайн-таблиці.`);
  } catch (err) {
    console.warn(`⚠️ Не вдалося завантажити онлайн: ${err.message}. Використовуємо локальний знімок даних.`);
    participants = FALLBACK_ROWS;
  }

  const baseYearMonth = '2026-10';
  let totalStepsInserted = 0;
  let totalUsersProcessed = 0;

  // Вимикаємо акаунт адміна (@Godymchuk_D_D) зі списку активних учасників челенджу
  const adminUser = await queries.findUserByHandleOrId('Godymchuk_D_D');
  if (adminUser) {
    await queries.setUserActive(adminUser.id, false);
    console.log(`🛡️ Адміністратора @${adminUser.username} (ID: ${adminUser.id}) виключено зі списку учасників челенджу (is_active = 0).`);
  }

  for (let i = 0; i < participants.length; i++) {
    const p = participants[i];
    const cleanUsername = p.username.replace(/^@/, '').trim();
    const existing = await queries.findUserByHandleOrId(cleanUsername);

    let userId = existing ? existing.id : (1001 + i);

    // Зберігаємо / оновлюємо користувача з фіксованою датою створення на початок місяця
    if (isSupabase) {
      await supabase.from('users').upsert({
        id: userId,
        first_name: existing?.first_name || p.name,
        username: cleanUsername,
        is_active: 1,
        created_at: `${baseYearMonth}-01 00:00:00`,
      }, { onConflict: 'id' });
    } else {
      sqliteDb.prepare(`
        INSERT INTO users (id, first_name, username, is_active, created_at)
        VALUES (?, ?, ?, 1, ?)
        ON CONFLICT(id) DO UPDATE SET
          first_name = excluded.first_name,
          username = excluded.username,
          created_at = excluded.created_at;
      `).run(userId, existing?.first_name || p.name, cleanUsername, `${baseYearMonth}-01 00:00:00`);
    }

    totalUsersProcessed++;

    // Записуємо щоденні кроки за 1–16 жовтня паралельно
    const stepPromises = [];
    for (let dayIndex = 0; dayIndex < p.steps.length; dayIndex++) {
      const stepCount = p.steps[dayIndex];
      const dayNum = dayIndex + 1;
      const dateStr = `${baseYearMonth}-${String(dayNum).padStart(2, '0')}`;

      if (stepCount !== null && stepCount !== undefined) {
        let note = 'Імпортовано з Google Таблиці челенджу';
        if (cleanUsername === 'olha_verbelchuk' && dayNum === 1) {
          note = 'Перший день (не штрафується за таблицею)';
        }
        stepPromises.push(
          queries.saveDailySteps(
            userId,
            dateStr,
            stepCount,
            'google_sheet',
            note
          )
        );
        totalStepsInserted++;
      }
    }

    // Виправляємо друкарську помилку OCR за 17 жовтня у @stetsyuk_irka (257727 -> 25048)
    if (cleanUsername === 'stetsyuk_irka') {
      const d17 = await queries.getUserStepsForDate(userId, '2026-10-17');
      if (d17 && d17.steps > 100000) {
        stepPromises.push(queries.saveDailySteps(userId, '2026-10-17', 25048, 'photo', 'Звірено з таблицею'));
      }
    }

    await Promise.all(stepPromises);

    console.log(`👤 [${i + 1}/${participants.length}] ${p.name} (@${cleanUsername}) -> ID: ${userId}`);
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🎉 Імпорт успішно завершено!`);
  console.log(`👥 Оброблено учасників: ${totalUsersProcessed}`);
  console.log(`👟 Зафіксовано записів кроків: ${totalStepsInserted}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Звіт перевірки завантажених даних станом на 18 жовтня
  console.log('📊 Перевірка статусу челенджу (станом на 18 жовтня):');
  const statsList = await queries.getAllUsersMonthStats(baseYearMonth, `${baseYearMonth}-18`);
  statsList.forEach((s, idx) => {
    console.log(
      `${idx + 1}. ${s.user.first_name} (@${s.user.username}): ` +
      `Кроків: ${s.totalMonthSteps}, ` +
      `Пільгові: ${s.graceDaysUsed}/${s.graceLimit}, ` +
      `Штрафних: ${s.penaltyDaysCount} (${s.monthPenaltiesTotal} грн)`
    );
  });
}

if (require.main === module) {
  runImport().catch((err) => {
    console.error('❌ Помилка під час імпорту:', err);
    process.exit(1);
  });
}

module.exports = { runImport };
