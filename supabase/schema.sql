-- Схема БД для сервиса расписания (ЛР3 + ЛР4)
-- Выполнить в Supabase: SQL Editor -> New query -> вставить и запустить

create table if not exists groups (
  id bigint generated always as identity primary key,
  name text not null unique
);

create table if not exists schedule (
  id bigint generated always as identity primary key,
  group_id bigint not null references groups(id) on delete cascade,
  day_of_week smallint not null check (day_of_week between 1 and 6), -- 1=Пн ... 6=Сб
  lesson_number smallint not null,
  subject_name text not null,
  teacher text,
  room text,
  time_start time not null,
  time_end time not null
);

create index if not exists idx_schedule_group_day on schedule(group_id, day_of_week);

-- Хранит выбранную группу для каждого чата в Telegram
-- (нужно, т.к. serverless-функция api/bot.js не хранит состояние между вызовами)
create table if not exists telegram_sessions (
  chat_id bigint primary key,
  group_id bigint references groups(id) on delete set null
);
alter table telegram_sessions enable row level security;
-- запись идёт только через SUPABASE_SERVICE_ROLE_KEY (обходит RLS), отдельная
-- policy на insert/update здесь не нужна


-- RLS: сайт и бот читают анонимно, писать может только сервисный ключ (админка)
alter table groups enable row level security;
alter table schedule enable row level security;

create policy "public read groups" on groups
  for select using (true);

create policy "public read schedule" on schedule
  for select using (true);

-- Заметка: записи (insert/update/delete) идут только через api/import-schedule.js,
-- который использует SUPABASE_SERVICE_ROLE_KEY и обходит RLS. Отдельная policy
-- на запись для анонимного ключа не нужна и не должна создаваться.

-- Тестовые данные (можно удалить после первого импорта через админку)
insert into groups (name) values ('ПО-33'), ('ЭМ-11')
  on conflict (name) do nothing;
