const xlsx = require('xlsx');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BELLS = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'public', 'bells.json'), 'utf-8')
);

export const config = {
  api: { bodyParser: false }
};

// Читаем сырое тело запроса в Buffer
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Минимальный парсер multipart/form-data: достаём первый файл из поля "file"
function extractFile(buffer, boundary) {
  const boundaryBuf = Buffer.from(`--${boundary}`);
  const parts = [];
  let start = buffer.indexOf(boundaryBuf);
  while (start !== -1) {
    const next = buffer.indexOf(boundaryBuf, start + boundaryBuf.length);
    if (next === -1) break;
    parts.push(buffer.slice(start + boundaryBuf.length, next));
    start = next;
  }

  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const headerText = part.slice(0, headerEnd).toString('utf-8');
    if (!/name="file"/.test(headerText)) continue;

    let body = part.slice(headerEnd + 4);
    // убираем завершающие \r\n перед следующим boundary
    if (body.slice(-2).toString() === '\r\n') body = body.slice(0, -2);
    return body;
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(.+)$/);
    if (!boundaryMatch) {
      return res.status(400).json({ error: 'Ожидался multipart/form-data с файлом' });
    }
    const boundary = boundaryMatch[1];

    const raw = await readRawBody(req);
    const fileBuffer = extractFile(raw, boundary);
    if (!fileBuffer || !fileBuffer.length) {
      return res.status(400).json({ error: 'Файл не найден в запросе' });
    }

    const workbook = xlsx.read(fileBuffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(sheet, { defval: '' });

    if (rows.length === 0) {
      return res.status(400).json({ error: 'В файле нет данных' });
    }

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
