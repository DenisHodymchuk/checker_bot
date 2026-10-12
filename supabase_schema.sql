-- ==========================================================
-- СХЕМА БАЗИ ДАНИХ ДЛЯ TELEGRAM STEP TRACKER BOT (SUPABASE)
-- Скопіюйте цей код у розділ "SQL Editor" вашого проєкту в Supabase та натисніть "Run"
-- ==========================================================

-- 1. Таблиця користувачів
CREATE TABLE IF NOT EXISTS public.users (
  id BIGINT PRIMARY KEY,
  first_name TEXT NOT NULL,
  username TEXT,
  is_active SMALLINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Таблиця щоденних кроків
CREATE TABLE IF NOT EXISTS public.daily_steps (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  date TEXT NOT NULL, -- формат YYYY-MM-DD
  steps INTEGER NOT NULL DEFAULT 0,
  source TEXT DEFAULT 'photo',
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT unique_user_date UNIQUE (user_id, date)
);

CREATE INDEX IF NOT EXISTS idx_daily_steps_date ON public.daily_steps(date);
CREATE INDEX IF NOT EXISTS idx_daily_steps_user_date ON public.daily_steps(user_id, date);

-- 3. Таблиця оплат у штрафну банку
CREATE TABLE IF NOT EXISTS public.penalty_payments (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL, -- сума в грн
  admin_id BIGINT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_penalty_payments_user ON public.penalty_payments(user_id);

-- 4. Таблиця системних налаштувань бота
CREATE TABLE IF NOT EXISTS public.settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 5. Початкові налаштування за замовчуванням
INSERT INTO public.settings (key, value) VALUES
  ('daily_goal', '10000'),
  ('grace_days_limit', '2'),
  ('penalty_amount', '100'),
  ('reminder_time', '20:30'),
  ('report_time', '22:00'),
  ('timezone', 'Europe/Kyiv'),
  ('reminders_enabled', '1'),
  ('reports_enabled', '1'),
  ('group_chat_id', '')
ON CONFLICT (key) DO NOTHING;

-- 6. Доступ до таблиць для бекенду бота
-- Вимикаємо блокування RLS, щоб бот міг вільно зберігати та оновлювати записи
ALTER TABLE public.users DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_steps DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.penalty_payments DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings DISABLE ROW LEVEL SECURITY;

GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
