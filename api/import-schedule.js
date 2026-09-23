const xlsx = require('xlsx');
const { createClient } = require('@supabase/supabase-js');
const formidable = require('formidable');
const fs = require('fs');
const path = require('path');

// Сервисный ключ — только на сервере, никогда не в public/*.html
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Расписание звонков: lesson_number -> {start, end}. Держим в отдельном
// JSON рядом, чтобы фронтенд (public/bells.json) и бэкенд не расходились.
const BELLS = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'public', 'bells.json'), 'utf-8')
);

export const config = {
  api: { bodyParser: false } // отключаем встроенный парсер, файл идёт через formidable
};

function parseForm(req) {
  return new Promise((resolve, reject) => {
    const form = formidable({ maxFileSize: 10 * 1024 * 1024 });
    form.parse(req, (err, fields, files) => {
      if (err) reject(err);
      else resolve({ fields, files });
    });
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { files } = await parseForm(req);
    const file = files.file?.[0] || files.file;
    if (!file) return res.status(400).json({ error: 'Файл не найден в запросе' });

    const buffer = fs.readFileSync(file.filepath);
    const workbook = xlsx.read(buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    // Ожидаемые колонки: group_name, day_of_week, lesson_number, subject_name, teacher, room
    const rows = xlsx.utils.sheet_to_json(sheet, { defval: '' });

    if (rows.length === 0) {
      return res.status(400).json({ error: 'В файле нет данных' });
    }

    // 1. Собираем уникальные группы и гарантируем их наличие в таблице groups
    const groupNames = [...new Set(rows.map(r => String(r.group_name).trim()).filter(Boolean))];
    const { data: existingGroups, error: gErr } = await supabase
      .from('groups')
      .select('id,name')
      .in('name', groupNames);
    if (gErr) throw gErr;

    const groupMap = new Map(existingGroups.map(g => [g.name, g.id]));
    const missing = groupNames.filter(n => !groupMap.has(n));
    if (missing.length > 0) {
      const { data: inserted, error: insErr } = await supabase
        .from('groups')
        .insert(missing.map(name => ({ name })))
        .select('id,name');
      if (insErr) throw insErr;
      inserted.forEach(g => groupMap.set(g.name, g.id));
    }

    // 2. Готовим строки расписания, время берём из bells.json по lesson_number
    const scheduleRows = rows.map(r => {
      const lessonNumber = Number(r.lesson_number);
      const bell = BELLS[String(lessonNumber)];
      return {
        group_id: groupMap.get(String(r.group_name).trim()),
        day_of_week: Number(r.day_of_week),
        lesson_number: lessonNumber,
        subject_name: String(r.subject_name).trim(),
        teacher: r.teacher ? String(r.teacher).trim() : null,
        room: r.room ? String(r.room).trim() : null,
        time_start: bell ? bell.start : '00:00',
        time_end: bell ? bell.end : '00:00'
      };
    }).filter(r => r.group_id && r.subject_name);

    if (scheduleRows.length === 0) {
      return res.status(400).json({ error: 'Не удалось распознать ни одной строки — проверьте названия колонок' });
    }

    // 3. Полностью заменяем расписание затронутых групп (чтобы не плодить дубли)
    const groupIds = [...new Set(scheduleRows.map(r => r.group_id))];
    const { error: delErr } = await supabase.from('schedule').delete().in('group_id', groupIds);
    if (delErr) throw delErr;

    const { error: insErr2 } = await supabase.from('schedule').insert(scheduleRows);
    if (insErr2) throw insErr2;

    return res.status(200).json({
      success: true,
      message: 'Расписание успешно обновлено!',
      rows: scheduleRows.length
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
