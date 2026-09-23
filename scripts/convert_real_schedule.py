"""
Достаёт расписание ОДНОЙ группы из общего файла колледжа (РАСПИСАНИЕ.xlsx)
и сохраняет в простом шаблоне для импорта через админ-панель:
group_name | day_of_week | lesson_number | subject_name | teacher | room

Использование:
    python convert_real_schedule.py РАСПИСАНИЕ.xlsx "ПО-33" output.xlsx

Как это работает:
- Ищет строку с названиями групп (заголовок блока), находит нужную колонку.
- Дальше построчно идёт вниз, пока не встретит следующий день недели или
  новый блок групп. Каждая непустая ячейка = одна пара (её порядковый номер
  внутри дня = lesson_number).
- Предмет и преподаватель обычно в одной ячейке через перенос строки —
  разделяются эвристически (последняя "строка" ячейки — препод, если
  выглядит как ФИО).
"""
import sys
import re
import openpyxl

DAY_NAMES = {
    'понедельник': 1, 'вторник': 2, 'среда': 3,
    'четверг': 4, 'пятница': 5, 'суббота': 6,
}

def find_day_of_week(cell_value):
    if not cell_value:
        return None
    low = str(cell_value).strip().lower()
    for name, num in DAY_NAMES.items():
        if low.startswith(name):
            return num
    return None

def split_subject_teacher(raw):
    # Ячейки вида "Название предмета ... Фамилия И.О." — последние 2-4 "слова"
    # часто ФИО. Простая эвристика: ищем паттерн "Фамилия И.И." в конце.
    raw = re.sub(r'\s+', ' ', str(raw)).strip()
    m = re.search(r'([А-ЯЁӘҒҚҢӨҰҮҺІ][а-яёәғқңөұүһі]+(\s[А-ЯЁ]\.\s?[А-ЯЁ]\.))\s*$', raw)
    if m:
        teacher = m.group(1)
        subject = raw[:m.start()].strip(' ,.')
        return subject, teacher
    return raw, None

def main():
    if len(sys.argv) != 4:
        print('Использование: python convert_real_schedule.py входной.xlsx "ИМЯ_ГРУППЫ" выходной.xlsx')
        sys.exit(1)

    src_path, group_name, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
    wb = openpyxl.load_workbook(src_path, data_only=True)

    rows_out = []

    for ws in wb.worksheets:
        # Найти все заголовки блоков групп (строка, где есть точное имя группы)
        header_hits = []
        for r in range(1, ws.max_row + 1):
            for c in range(1, ws.max_column + 1):
                v = ws.cell(row=r, column=c).value
                if v and str(v).strip() == group_name:
                    header_hits.append((r, c))

        # Берём только первое найденное вхождение группы на листе — дальше
        # в файле обычно повторный семестр/блок с тем же названием, который
        # даёт дубли и "хвост" (подписи, ФИО зав. отделением и т.п.).
        for (hdr_row, col) in header_hits[:1]:
            r = hdr_row + 1
            current_day = None
            lesson_num = 0
            while r <= ws.max_row:
                cell_val = ws.cell(row=r, column=col).value
                day = find_day_of_week(cell_val)
                if day:
                    current_day = day
                    lesson_num = 0
                    r += 1
                    continue
                # новый блок групп начинается снова с имени группы в этой колонке
                if cell_val and str(cell_val).strip() in [g for g in DAY_NAMES] :
                    pass
                if cell_val and str(cell_val).strip() == group_name and r != hdr_row:
                    break  # следующий семестр/блок для той же группы — останавливаемся
                if current_day and cell_val:
                    lesson_num += 1
                    subject, teacher = split_subject_teacher(cell_val)
                    room = ws.cell(row=r, column=col + 1).value
                    rows_out.append({
                        'group_name': group_name,
                        'day_of_week': current_day,
                        'lesson_number': lesson_num,
                        'subject_name': subject,
                        'teacher': teacher or '',
                        'room': str(room).strip() if room else ''
                    })
                elif current_day and not cell_val:
                    # пустая ячейка тоже может быть парой без данных — пропускаем без increment
                    pass
                r += 1
                # защитная остановка: если ушли слишком далеко без дня — прекращаем блок
                if r - hdr_row > 60:
                    break

    JUNK_MARKERS = ('меңгеруші', 'орынбасар', 'бекітемін', 'утвержда')
    rows_out = [
        r for r in rows_out
        if r['subject_name'] and not any(j in r['subject_name'].lower() for j in JUNK_MARKERS)
        and r['lesson_number'] <= 6
    ]

    if not rows_out:
        print(f'Группа "{group_name}" не найдена или для неё нет данных.')
        sys.exit(1)

    out_wb = openpyxl.Workbook()
    out_ws = out_wb.active
    out_ws.append(['group_name', 'day_of_week', 'lesson_number', 'subject_name', 'teacher', 'room'])
    for row in rows_out:
        out_ws.append([row['group_name'], row['day_of_week'], row['lesson_number'],
                        row['subject_name'], row['teacher'], row['room']])
    out_wb.save(out_path)
    print(f'Готово: {len(rows_out)} строк сохранено в {out_path}')

if __name__ == '__main__':
    main()
