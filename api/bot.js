const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const TELEGRAM_TOKEN = process.env.BOT_TOKEN;
const TG_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

const bells = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'public', 'bells.json'), 'utf-8')
);
const DAYS = ['', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];

function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

async function sendMessage(chatId, text, replyMarkup) {
  await fetch(`${TG_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_markup: replyMarkup
    })
  });
}

async function answerCallback(callbackId) {
  await fetch(`${TG_API}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackId })
  });
}

async function sendGroupPicker(chatId) {
  const { data, error } = await supabase.from('groups').select('id,name').order('name');
  if (error || !data.length) {
    return sendMessage(chatId, 'Не удалось загрузить список групп.');
  }
  const keyboard = data.map(g => [{ text: g.name, callback_data: `group:${g.id}` }]);
  return sendMessage(chatId, 'Выберите свою группу:', { inline_keyboard: keyboard });
}

// Группа выбранная пользователем хранится в Supabase (таблица telegram_sessions),
// т.к. serverless-функция не хранит состояние между вызовами.
async function getSavedGroup(chatId) {
  const { data } = await supabase
    .from('telegram_sessions')
    .select('group_id')
    .eq('chat_id', chatId)
    .maybeSingle();
  return data?.group_id || null;
}

async function saveGroup(chatId, groupId) {
  await supabase.from('telegram_sessions').upsert({ chat_id: chatId, group_id: groupId });
}

async function getTodaySchedule(groupId) {
  const jsDay = new Date().getDay();
  const dayOfWeek = jsDay === 0 ? 7 : jsDay;
  if (dayOfWeek === 7) return { dayOfWeek, lessons: [], sunday: true };

  const { data, error } = await supabase
    .from('schedule')
    .select('lesson_number, subject_name, teacher, room, time_start, time_end')
    .eq('group_id', groupId)
    .eq('day_of_week', dayOfWeek)
    .order('lesson_number');

  return { dayOfWeek, lessons: error ? [] : data, sunday: false };
}

function formatToday(dayOfWeek, lessons) {
  return `${DAYS[dayOfWeek]}:\n` + lessons.map(l =>
    `${l.lesson_number} пара (${l.time_start.slice(0,5)}–${l.time_end.slice(0,5)}): ${l.subject_name}${l.teacher ? ' — ' + l.teacher : ''}${l.room ? ' [' + l.room + ']' : ''}`
  ).join('\n');
}

function formatNow(lessons) {
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  for (const l of lessons) {
    const start = timeToMinutes(l.time_start.slice(0, 5));
    const end = timeToMinutes(l.time_end.slice(0, 5));
    if (nowMinutes >= start && nowMinutes <= end) {
      return `Сейчас идёт ${l.lesson_number} пара: ${l.subject_name} (${l.time_start.slice(0,5)}–${l.time_end.slice(0,5)})`;
    }
  }
  const next = lessons.find(l => timeToMinutes(l.time_start.slice(0, 5)) > nowMinutes);
  return next
    ? `Сейчас перемена. Следующая пара в ${next.time_start.slice(0,5)}: ${next.subject_name}`
    : 'На сегодня все пары закончились.';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('Bot Webhook Active');
  }

  try {
    const update = req.body;

    // --- Нажатие на кнопку выбора группы ---
    if (update.callback_query) {
      const cq = update.callback_query;
      const chatId = cq.message.chat.id;
      if (cq.data?.startsWith('group:')) {
        const groupId = cq.data.split(':')[1];
        await saveGroup(chatId, groupId);
        await answerCallback(cq.id);
        await sendMessage(chatId, 'Группа сохранена ✅. Команды: /today, /now, /group — сменить группу.');
      }
      return res.status(200).json({ status: 'ok' });
    }

    // --- Обычное текстовое сообщение / команда ---
    if (update.message) {
      const chatId = update.message.chat.id;
      const text = (update.message.text || '').trim();

      if (text === '/start') {
        await sendMessage(chatId, 'Привет! Я бот расписания. Сначала выбери группу:');
        await sendGroupPicker(chatId);
      } else if (text === '/group') {
        await sendGroupPicker(chatId);
      } else if (text === '/today') {
        const groupId = await getSavedGroup(chatId);
        if (!groupId) { await sendMessage(chatId, 'Сначала выберите группу: /group'); }
        else {
          const { dayOfWeek, lessons, sunday } = await getTodaySchedule(groupId);
          if (sunday) await sendMessage(chatId, 'Сегодня воскресенье — пар нет 🎉');
          else if (!lessons.length) await sendMessage(chatId, 'На сегодня пар не найдено.');
          else await sendMessage(chatId, formatToday(dayOfWeek, lessons));
        }
      } else if (text === '/now') {
        const groupId = await getSavedGroup(chatId);
        if (!groupId) { await sendMessage(chatId, 'Сначала выберите группу: /group'); }
        else {
          const { lessons, sunday } = await getTodaySchedule(groupId);
          if (sunday) await sendMessage(chatId, 'Сегодня воскресенье — пар нет 🎉');
          else if (!lessons.length) await sendMessage(chatId, 'На сегодня пар не найдено.');
          else await sendMessage(chatId, formatNow(lessons));
        }
      }
    }

    return res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error(err);
    return res.status(200).json({ status: 'error', message: err.message });
  }
}
