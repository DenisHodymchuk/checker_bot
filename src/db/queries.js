const { isSupabase, supabase, sqliteDb } = require('./database');
const { getTodayDateString } = require('../utils/date');

// ==========================================
// КОРИСТУВАЧІ
// ==========================================

async function upsertUser(id, firstName, username) {
  if (isSupabase) {
    const { error } = await supabase.from('users').upsert({
      id: Number(id),
      first_name: firstName,
      username: username ? username.replace(/^@/, '') : null,
      is_active: 1,
    }, { onConflict: 'id' });
    if (error) console.error('[Supabase] Помилка upsertUser:', error.message);
    return;
  }

  const stmt = sqliteDb.prepare(`
    INSERT INTO users (id, first_name, username, is_active)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(id) DO UPDATE SET
      first_name = excluded.first_name,
      username = excluded.username;
  `);
  stmt.run(id, firstName, username ? username.replace(/^@/, '') : null);
}

async function getUser(id) {
  if (isSupabase) {
    const { data, error } = await supabase.from('users').select('*').eq('id', Number(id)).single();
    if (error && error.code !== 'PGRST116') console.error('[Supabase] Помилка getUser:', error.message);
    return data || null;
  }

  const stmt = sqliteDb.prepare(`SELECT * FROM users WHERE id = ?`);
  return stmt.get(id) || null;
}

async function findUserByHandleOrId(identifier) {
  if (!identifier) return null;
  const raw = String(identifier).trim();
  const clean = raw.replace(/^@/, '');

  if (isSupabase) {
    if (/^\d+$/.test(clean)) {
      const { data } = await supabase.from('users').select('*').eq('id', Number(clean)).single();
      if (data) return data;
    }
    const { data } = await supabase.from('users').select('*').ilike('username', clean).single();
    return data || null;
  }

  if (/^\d+$/.test(clean)) {
    const byId = sqliteDb.prepare(`SELECT * FROM users WHERE id = ?`).get(Number(clean));
    if (byId) return byId;
  }
  const stmt = sqliteDb.prepare(`SELECT * FROM users WHERE LOWER(username) = LOWER(?)`);
  return stmt.get(clean) || null;
}

async function getAllActiveUsers() {
  if (isSupabase) {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('is_active', 1)
      .order('first_name', { ascending: true });
    if (error) console.error('[Supabase] Помилка getAllActiveUsers:', error.message);
    return data || [];
  }

  const stmt = sqliteDb.prepare(`SELECT * FROM users WHERE is_active = 1 ORDER BY first_name ASC`);
  return stmt.all();
}

async function getAllUsers() {
  if (isSupabase) {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .order('is_active', { ascending: false })
      .order('first_name', { ascending: true });
    if (error) console.error('[Supabase] Помилка getAllUsers:', error.message);
    return data || [];
  }

  const stmt = sqliteDb.prepare(`SELECT * FROM users ORDER BY is_active DESC, first_name ASC`);
  return stmt.all();
}

async function setUserActive(id, isActive) {
  if (isSupabase) {
    await supabase.from('users').update({ is_active: isActive ? 1 : 0 }).eq('id', Number(id));
    return;
  }

  const stmt = sqliteDb.prepare(`UPDATE users SET is_active = ? WHERE id = ?`);
  stmt.run(isActive ? 1 : 0, id);
}

// ==========================================
// КРОКИ
// ==========================================

async function saveDailySteps(userId, date, steps, source = 'photo', notes = '') {
  if (isSupabase) {
    const { error } = await supabase.from('daily_steps').upsert({
      user_id: Number(userId),
      date: String(date),
      steps: Number(steps),
      source: source || 'photo',
      notes: notes || null,
    }, { onConflict: 'user_id,date' });
    if (error) console.error('[Supabase] Помилка saveDailySteps:', error.message);
    return;
  }

  const stmt = sqliteDb.prepare(`
    INSERT INTO daily_steps (user_id, date, steps, source, notes, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now', 'localtime'))
    ON CONFLICT(user_id, date) DO UPDATE SET
      steps = excluded.steps,
      source = excluded.source,
      notes = excluded.notes,
      created_at = excluded.created_at;
  `);
  stmt.run(userId, date, steps, source, notes || null);
}

async function getUserStepsForDate(userId, date) {
  if (isSupabase) {
    const { data } = await supabase
      .from('daily_steps')
      .select('*')
      .eq('user_id', Number(userId))
      .eq('date', String(date))
      .single();
    return data || null;
  }

  const stmt = sqliteDb.prepare(`SELECT * FROM daily_steps WHERE user_id = ? AND date = ?`);
  return stmt.get(userId, date) || null;
}

async function getUserWeeklyHistory(userId, days = 7) {
  if (isSupabase) {
    const { data } = await supabase
      .from('daily_steps')
      .select('date, steps, source')
      .eq('user_id', Number(userId))
      .order('date', { ascending: false })
      .limit(days);
    return data || [];
  }

  const stmt = sqliteDb.prepare(`
    SELECT date, steps, source
    FROM daily_steps
    WHERE user_id = ?
    ORDER BY date DESC
    LIMIT ?
  `);
  return stmt.all(userId, days);
}

async function getUserSummaryStats(userId) {
  if (isSupabase) {
    const { data } = await supabase
      .from('daily_steps')
      .select('steps')
      .eq('user_id', Number(userId));

    const rows = data || [];
    const total_days = rows.length;
    const total_steps = rows.reduce((s, r) => s + (r.steps || 0), 0);
    const avg_steps = total_days > 0 ? Math.round(total_steps / total_days) : 0;
    const max_steps = total_days > 0 ? Math.max(...rows.map(r => r.steps || 0)) : 0;
    return { total_days, total_steps, avg_steps, max_steps };
  }

  const stmt = sqliteDb.prepare(`
    SELECT
      COUNT(*) AS total_days,
      COALESCE(SUM(steps), 0) AS total_steps,
      COALESCE(ROUND(AVG(steps)), 0) AS avg_steps,
      COALESCE(MAX(steps), 0) AS max_steps
    FROM daily_steps
    WHERE user_id = ?
  `);
  return stmt.get(userId) || { total_days: 0, total_steps: 0, avg_steps: 0, max_steps: 0 };
}

// ==========================================
// РЕЙТИНГИ ТА ЗВІТИ
// ==========================================

async function getLeaderboard(date) {
  if (isSupabase) {
    const activeUsers = await getAllActiveUsers();
    const { data: stepRows } = await supabase
      .from('daily_steps')
      .select('user_id, steps, source, created_at')
      .eq('date', String(date));

    const stepMap = new Map();
    (stepRows || []).forEach(r => stepMap.set(r.user_id, r));

    const result = activeUsers.map(u => {
      const s = stepMap.get(u.id);
      return {
        user_id: u.id,
        first_name: u.first_name,
        username: u.username,
        steps: s ? s.steps : null,
        source: s ? s.source : null,
        created_at: s ? s.created_at : null,
      };
    });

    result.sort((a, b) => {
      const aHas = a.steps !== null ? 0 : 1;
      const bHas = b.steps !== null ? 0 : 1;
      if (aHas !== bHas) return aHas - bHas;
      if ((b.steps || 0) !== (a.steps || 0)) return (b.steps || 0) - (a.steps || 0);
      return a.first_name.localeCompare(b.first_name);
    });

    return result;
  }

  const stmt = sqliteDb.prepare(`
    SELECT 
      u.id AS user_id,
      u.first_name,
      u.username,
      s.steps,
      s.source,
      s.created_at
    FROM users u
    LEFT JOIN daily_steps s ON u.id = s.user_id AND s.date = ?
    WHERE u.is_active = 1
    ORDER BY 
      CASE WHEN s.steps IS NOT NULL THEN 0 ELSE 1 END ASC,
      s.steps DESC,
      u.first_name ASC
  `);
  return stmt.all(date);
}

async function getMissingUsersForDate(date) {
  if (isSupabase) {
    const rows = await getLeaderboard(date);
    return rows.filter(r => !r.steps || r.steps === 0);
  }

  const stmt = sqliteDb.prepare(`
    SELECT 
      u.id AS user_id,
      u.first_name,
      u.username
    FROM users u
    LEFT JOIN daily_steps s ON u.id = s.user_id AND s.date = ?
    WHERE u.is_active = 1 AND (s.steps IS NULL OR s.steps = 0)
    ORDER BY u.first_name ASC
  `);
  return stmt.all(date);
}

// ==========================================
// ШТРАФНА БАНКА ТА ПЛАТЕЖІ
// ==========================================

async function addPenaltyPayment(userId, amount, adminId = null, notes = '') {
  if (isSupabase) {
    const { data, error } = await supabase.from('penalty_payments').insert({
      user_id: Number(userId),
      amount: Number(amount),
      admin_id: adminId ? Number(adminId) : null,
      notes: notes || null,
    }).select().single();
    if (error) console.error('[Supabase] Помилка addPenaltyPayment:', error.message);
    return data;
  }

  const stmt = sqliteDb.prepare(`
    INSERT INTO penalty_payments (user_id, amount, admin_id, notes, created_at)
    VALUES (?, ?, ?, ?, datetime('now', 'localtime'))
  `);
  const result = stmt.run(userId, amount, adminId, notes || null);
  return { id: result.lastInsertRowid, user_id: userId, amount, admin_id: adminId, notes };
}

async function getUserPaymentsTotal(userId) {
  if (isSupabase) {
    const { data } = await supabase
      .from('penalty_payments')
      .select('amount')
      .eq('user_id', Number(userId));
    return (data || []).reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
  }

  const stmt = sqliteDb.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM penalty_payments
    WHERE user_id = ?
  `);
  const row = stmt.get(userId);
  return row ? Number(row.total) : 0;
}

async function getAllPaymentsTotal() {
  if (isSupabase) {
    const { data } = await supabase.from('penalty_payments').select('amount');
    return (data || []).reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
  }

  const stmt = sqliteDb.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM penalty_payments`);
  const row = stmt.get();
  return row ? Number(row.total) : 0;
}

async function getRecentPayments(limit = 5) {
  if (isSupabase) {
    const { data } = await supabase
      .from('penalty_payments')
      .select('*, users(first_name, username)')
      .order('created_at', { ascending: false })
      .limit(limit);
    return (data || []).map(r => ({
      ...r,
      first_name: r.users?.first_name,
      username: r.users?.username,
    }));
  }

  const stmt = sqliteDb.prepare(`
    SELECT p.*, u.first_name, u.username
    FROM penalty_payments p
    LEFT JOIN users u ON p.user_id = u.id
    ORDER BY p.id DESC
    LIMIT ?
  `);
  return stmt.all(limit);
}

// ==========================================
// РОЗРАХУНОК ПІЛЬГОВИХ ДНІВ ТА ШТРАФІВ (МІСЯЦЬ)
// ==========================================

/**
 * Генерує список дат у форматі YYYY-MM-DD від startDate до endDate
 */
function getDateRange(startDateStr, endDateStr) {
  const dates = [];
  const current = new Date(startDateStr + 'T00:00:00Z');
  const end = new Date(endDateStr + 'T00:00:00Z');

  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

/**
 * Розраховує детальну статистику учасника за конкретний календарний місяць (YYYY-MM).
 * @param {number} userId 
 * @param {string} yearMonth - формат "2026-10"
 * @param {string} upToDate - дата, до якої ведеться підрахунок (включно). За замовчуванням сьогодні.
 */
async function getUserMonthStats(userId, yearMonth, upToDate = null) {
  const tz = await getSetting('timezone', 'Europe/Kyiv');
  const today = getTodayDateString(tz);
  const targetUpToDate = upToDate || today;

  const dailyGoal = Number(await getSetting('daily_goal', '10000'));
  const graceLimit = Number(await getSetting('grace_days_limit', '2'));
  const penaltyPerDay = Number(await getSetting('penalty_amount', '100'));

  const user = await getUser(userId);
  if (!user) return null;

  const monthStart = `${yearMonth}-01`;
  const [y, m] = yearMonth.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const monthEnd = `${yearMonth}-${String(daysInMonth).padStart(2, '0')}`;
  const effectiveEnd = targetUpToDate < monthEnd ? targetUpToDate : monthEnd;

  // Отримуємо всі кроки користувача за цей місяць
  let monthStepMap = new Map();
  if (isSupabase) {
    const { data } = await supabase
      .from('daily_steps')
      .select('date, steps')
      .eq('user_id', Number(userId))
      .gte('date', monthStart)
      .lte('date', effectiveEnd);
    (data || []).forEach(r => monthStepMap.set(r.date, r.steps));
  } else {
    const stmt = sqliteDb.prepare(`
      SELECT date, steps FROM daily_steps
      WHERE user_id = ? AND date >= ? AND date <= ?
    `);
    const rows = stmt.all(userId, monthStart, effectiveEnd);
    rows.forEach(r => monthStepMap.set(r.date, r.steps));
  }

  // Визначаємо початковий день у місяці: враховуємо дату реєстрації та наявність кроків
  let userStart = monthStart;
  const datesWithSteps = Array.from(monthStepMap.keys()).sort();
  const earliestStepDate = datesWithSteps.length > 0 ? datesWithSteps[0] : null;

  if (user.created_at) {
    const regDate = String(user.created_at).slice(0, 10);
    if (regDate.startsWith(yearMonth)) {
      if (earliestStepDate && earliestStepDate < regDate) {
        userStart = earliestStepDate;
      } else if (regDate > monthStart) {
        userStart = regDate;
      }
    }
  }

  let datesToCheck = [];
  if (userStart <= effectiveEnd) {
    datesToCheck = getDateRange(userStart, effectiveEnd);
  }

  let successDays = 0;
  let missedDays = 0;
  const daysBreakdown = [];

  for (const d of datesToCheck) {
    const steps = monthStepMap.has(d) ? monthStepMap.get(d) : 0;
    const isSuccess = steps >= dailyGoal;

    if (isSuccess) {
      successDays++;
      daysBreakdown.push({
        date: d,
        steps,
        status: 'success',
        missedOrder: null,
        penalty: 0,
      });
    } else {
      missedDays++;
      let status = 'penalty';
      let penalty = penaltyPerDay;

      if (missedDays <= graceLimit) {
        status = `grace_${missedDays}`;
        penalty = 0;
      }

      daysBreakdown.push({
        date: d,
        steps,
        status,
        missedOrder: missedDays,
        penalty,
      });
    }
  }

  const graceDaysUsed = Math.min(missedDays, graceLimit);
  const penaltyDaysCount = Math.max(0, missedDays - graceLimit);
  const monthPenaltiesTotal = penaltyDaysCount * penaltyPerDay;

  // Отримуємо всі сплачені кошти користувачем
  const totalPaid = await getUserPaymentsTotal(userId);

  // Також рахуємо штрафи за всі попередні місяці користувача
  const allTimePenalties = await getUserAllTimePenalties(userId, targetUpToDate);
  const currentDebt = Math.max(0, allTimePenalties - totalPaid);

  return {
    user,
    yearMonth,
    totalEvaluatedDays: datesToCheck.length,
    successDays,
    missedDays,
    graceDaysUsed,
    graceLimit,
    graceDaysRemaining: Math.max(0, graceLimit - graceDaysUsed),
    penaltyDaysCount,
    monthPenaltiesTotal,
    allTimePenalties,
    totalPaid,
    currentDebt,
    daysBreakdown,
  };
}

/**
 * Рахує всі штрафи користувача за весь час до вказаної дати
 */
async function getUserAllTimePenalties(userId, upToDate) {
  const user = await getUser(userId);
  if (!user) return 0;

  const tz = await getSetting('timezone', 'Europe/Kyiv');
  const today = getTodayDateString(tz);
  const effectiveEnd = upToDate || today;

  // Завантажуємо всі кроки користувача
  let stepMap = new Map();
  if (isSupabase) {
    const { data } = await supabase
      .from('daily_steps')
      .select('date, steps')
      .eq('user_id', Number(userId))
      .lte('date', effectiveEnd);
    (data || []).forEach(r => stepMap.set(r.date, r.steps));
  } else {
    const stmt = sqliteDb.prepare(`
      SELECT date, steps FROM daily_steps WHERE user_id = ? AND date <= ?
    `);
    const rows = stmt.all(userId, effectiveEnd);
    rows.forEach(r => stepMap.set(r.date, r.steps));
  }

  // Знаходимо найбільш ранню дату кроків користувача
  const allDates = Array.from(stepMap.keys()).sort();
  const earliestDate = allDates.length > 0 ? allDates[0] : null;

  let startYear = user.created_at ? Number(String(user.created_at).slice(0, 4)) : 2026;
  let startMonth = user.created_at ? Number(String(user.created_at).slice(5, 7)) : 1;

  if (earliestDate) {
    const eYear = Number(earliestDate.slice(0, 4));
    const eMonth = Number(earliestDate.slice(5, 7));
    if (eYear < startYear || (eYear === startYear && eMonth < startMonth)) {
      startYear = eYear;
      startMonth = eMonth;
    }
  }

  const endYear = Number(effectiveEnd.slice(0, 4));
  const endMonth = Number(effectiveEnd.slice(5, 7));

  let totalPenalties = 0;
  const graceLimit = Number(await getSetting('grace_days_limit', '2'));
  const penaltyPerDay = Number(await getSetting('penalty_amount', '100'));
  const dailyGoal = Number(await getSetting('daily_goal', '10000'));

  for (let y = startYear; y <= endYear; y++) {
    const mStart = (y === startYear) ? startMonth : 1;
    const mEnd = (y === endYear) ? endMonth : 12;

    for (let m = mStart; m <= mEnd; m++) {
      const ym = `${y}-${String(m).padStart(2, '0')}`;
      const mStartDate = `${ym}-01`;
      let effectiveStart = mStartDate;

      const monthDates = allDates.filter(d => d.startsWith(ym));
      const earliestInMonth = monthDates.length > 0 ? monthDates[0] : null;

      if (user.created_at) {
        const regDate = String(user.created_at).slice(0, 10);
        if (regDate.startsWith(ym)) {
          if (earliestInMonth && earliestInMonth < regDate) {
            effectiveStart = earliestInMonth;
          } else if (regDate > mStartDate) {
            effectiveStart = regDate;
          }
        }
      }

      const daysInMonth = new Date(y, m, 0).getDate();
      const mEndDate = `${ym}-${String(daysInMonth).padStart(2, '0')}`;
      const curEnd = effectiveEnd < mEndDate ? effectiveEnd : mEndDate;

      if (effectiveStart <= curEnd) {
        const dates = getDateRange(effectiveStart, curEnd);
        let monthMissed = 0;
        for (const d of dates) {
          const steps = stepMap.has(d) ? stepMap.get(d) : 0;
          if (steps < dailyGoal) {
            monthMissed++;
          }
        }
        const penaltyDays = Math.max(0, monthMissed - graceLimit);
        totalPenalties += penaltyDays * penaltyPerDay;
      }
    }
  }

  return totalPenalties;
}

/**
 * Отримує статистику за місяць для всіх активних учасників
 */
async function getAllUsersMonthStats(yearMonth, upToDate = null) {
  const users = await getAllActiveUsers();
  const results = [];
  for (const u of users) {
    const stats = await getUserMonthStats(u.id, yearMonth, upToDate);
    if (stats) results.push(stats);
  }
  return results;
}

// ==========================================
// НАЛАШТУВАННЯ
// ==========================================

async function getSetting(key, defaultValue = '') {
  if (isSupabase) {
    const { data } = await supabase.from('settings').select('value').eq('key', key).single();
    return data ? data.value : defaultValue;
  }

  const stmt = sqliteDb.prepare(`SELECT value FROM settings WHERE key = ?`);
  const row = stmt.get(key);
  return row ? row.value : defaultValue;
}

async function setSetting(key, value) {
  if (isSupabase) {
    await supabase.from('settings').upsert({ key, value: String(value) }, { onConflict: 'key' });
    return;
  }

  const stmt = sqliteDb.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value;
  `);
  stmt.run(key, String(value));
}

async function getAllSettings() {
  if (isSupabase) {
    const { data } = await supabase.from('settings').select('key, value');
    const res = {};
    (data || []).forEach(r => { res[r.key] = r.value; });
    return res;
  }

  const stmt = sqliteDb.prepare(`SELECT key, value FROM settings`);
  const rows = stmt.all();
  const result = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

module.exports = {
  upsertUser,
  getUser,
  findUserByHandleOrId,
  getAllActiveUsers,
  getAllUsers,
  setUserActive,
  saveDailySteps,
  getUserStepsForDate,
  getUserWeeklyHistory,
  getUserSummaryStats,
  getLeaderboard,
  getMissingUsersForDate,
  addPenaltyPayment,
  getUserPaymentsTotal,
  getAllPaymentsTotal,
  getRecentPayments,
  getUserMonthStats,
  getAllUsersMonthStats,
  getSetting,
  setSetting,
  getAllSettings,
};
