// Сервер без зависимостей (Node.js 18+).
// Забирает расписание с rasp.dmami.ru, приводит к плоскому виду и отдаёт фронтенду.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = process.env.PORT || 3000;
const BASE = process.env.RASP_BASE || 'https://rasp.dmami.ru';
const GROUPS_PATH = process.env.RASP_GROUPS_PATH || '/semester.json';
const GROUP_PATH = process.env.RASP_GROUP_PATH || '/site/group';
const TEACHER_PATH = process.env.RASP_TEACHER_PATH || '/site/group'; // если у сайта другой эндпоинт для преподавателей — поправьте здесь
const TTL = 15 * 60 * 1000;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (rasp-polytech student app)',
  Accept: 'application/json, text/plain, */*',
  Referer: `${BASE}/`,
  'X-Requested-With': 'XMLHttpRequest',
};

const cache = new Map();
async function cached(key, loader) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  const value = await loader();
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function getJSON(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`rasp.dmami.ru ответил ${res.status}`);
  return res.json();
}

// ---------- нормализация ----------
const stripTags = (s) =>
  String(s ?? '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();

function toISO(d) {
  if (!d) return null;
  const m = String(d).match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : String(d).slice(0, 10);
}

const slots = (x) =>
  !x ? [] : Array.isArray(x)
    ? x.map((v, i) => [i + 1, v])
    : Object.entries(x).map(([k, v]) => [Number(k), v]);

function kindOf(type) {
  const t = String(type || '').toLowerCase();
  if (t.includes('лек')) return 'lecture';
  if (t.includes('практ') || t.includes('семин')) return 'practice';
  if (t.includes('лаб')) return 'lab';
  if (/экз|зач|конс|тест/.test(t)) return 'exam';
  return 'other';
}

function extractLinks(l) {
  const direct = [l.e_link, l.link, l.url].filter(Boolean).map(String);
  const texts = [...direct, l.location, l.sbj, l.teacher,
    ...(l.auditories ?? l.rooms ?? []).map((a) => (typeof a === 'string' ? a : `${a.title} ${a.link ?? a.url ?? ''}`))]
    .filter(Boolean).map((s) => String(s).replace(/&amp;/g, '&'));
  const found = [];
  for (const t of texts) {
    for (const m of t.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) found.push(m[1]);
    for (const m of t.matchAll(/https?:\/\/[^\s"'<>]+/gi)) found.push(m[0]);
  }
  for (const d of direct) {
    const t = d.trim().replace(/&amp;/g, '&');
    if (!/[\s<]/.test(t) && /^(\/\/)?[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(t)) found.push(t);
  }
  const out = [];
  for (let u of found) {
    u = u.trim().replace(/^\/\//, '');
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    try {
      const url = new URL(u);
      if (/^https?:$/.test(url.protocol) && !out.includes(url.href)) out.push(url.href);
    } catch { /* не ссылка */ }
  }
  return out;
}

function normalize(raw) {
  const lessons = [];
  for (const [day, pairs] of slots(raw.grid)) {
    for (const [pair, cell] of slots(pairs)) {
      const list = Array.isArray(cell) ? cell : cell ? [cell] : [];
      for (const l of list) {
        const teachers = Array.isArray(l.teachers ?? l.teacher)
          ? (l.teachers ?? l.teacher).map(stripTags)
          : stripTags(l.teachers ?? l.teacher).split(/\s*[;,]\s*/).filter(Boolean);
        const rooms = (l.auditories ?? l.rooms ?? [])
          .map((a) => stripTags(typeof a === 'string' ? a : a.title))
          .filter(Boolean);
        const type = stripTags(l.type);
        const links = extractLinks(l);
        lessons.push({
          day, pair,
          title: stripTags(l.sbj ?? l.title),
          type, kind: kindOf(type),
          teachers, rooms,
          location: stripTags(l.location),
          links, link: links[0] || null,
          from: toISO(l.df ?? l.dates?.[0]),
          to: toISO(l.dt ?? l.dates?.[1]),
        });
      }
    }
  }
  const all = lessons.flatMap((l) => [l.from, l.to]).filter(Boolean).sort();
  return { lessons, range: all.length ? [all[0], all[all.length - 1]] : null };
}

// ---------- API ----------
async function getGroups() {
  return cached('groups', async () => {
    const raw = await getJSON(BASE + GROUPS_PATH);
    const src = raw.contents ?? raw;
    return Object.keys(src).sort((a, b) => a.localeCompare(b, 'ru'));
  });
}

async function getTeachers() {
  return cached('teachers', async () => {
    // rasp.dmami.ru не имеет публичного списка преподавателей,
    // возвращаем пустой массив — фронт вводит ФИО вручную.
    return [];
  });
}

async function getSchedule({ group, teacher, session }) {
  const key = teacher ? `teach:${teacher}:${session}` : `sched:${group}:${session}`;
  return cached(key, async () => {
    const q = teacher
      ? `teacher=${encodeURIComponent(teacher)}&session=${session ? 1 : 0}`
      : `group=${encodeURIComponent(group)}&session=${session ? 1 : 0}`;
    const url = `${BASE}${teacher ? TEACHER_PATH : GROUP_PATH}?${q}`;
    const raw = await getJSON(url);
    if (raw.status && raw.status !== 'ok') throw new Error('Не найдено');
    const { lessons, range } = normalize(raw);
    return {
      group: group || '',
      teacher: teacher || '',
      session: !!session,
      range,
      lessons,
    };
  });
}

// ---------- календарь (.ics) ----------
const SLOTS = [[9, 0, 10, 30], [10, 40, 12, 10], [12, 20, 13, 50], [14, 30, 16, 0], [16, 10, 17, 40], [17, 50, 19, 20], [19, 30, 21, 0]];
const MSK = 3;
const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

function fold(line) {
  const out = [];
  let cur = '', bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}

function buildICS(data, alarm) {
  const title = data.teacher ? 'Преподаватель ' + data.teacher : 'Политех ' + data.group;
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//rasp-polytech//RU', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(title)}`, 'X-WR-TIMEZONE:Europe/Moscow',
    'REFRESH-INTERVAL;VALUE=DURATION:PT6H', 'X-PUBLISHED-TTL:PT6H',
  ];
  const now = stamp(new Date());
  for (const l of data.lessons) {
    const slot = SLOTS[l.pair - 1];
    const from = l.from || data.range?.[0], to = l.to || data.range?.[1];
    if (!slot || !from || !to) continue;
    const id = crypto.createHash('md5')
      .update([data.group, data.teacher, l.title, l.type, l.pair, l.day, from, to, l.rooms.join()].join('|')).digest('hex').slice(0, 12);
    const last = new Date(to + 'T00:00:00Z');
    let n = 0;
    for (const d = new Date(from + 'T00:00:00Z'); d <= last && n < 400; d.setUTCDate(d.getUTCDate() + 1), n++) {
      if ((d.getUTCDay() + 6) % 7 + 1 !== l.day) continue;
      const [y, m, day] = [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()];
      const start = new Date(Date.UTC(y, m, day, slot[0] - MSK, slot[1]));
      const end = new Date(Date.UTC(y, m, day, slot[2] - MSK, slot[3]));
      const desc = [l.type, ...l.teachers, ...(l.links || [])].filter(Boolean).join('\n');
      const loc = [...l.rooms, l.location].filter(Boolean).join(', ');
      lines.push('BEGIN:VEVENT', `UID:${id}-${stamp(start)}@rasp-polytech`, `DTSTAMP:${now}`,
        `DTSTART:${stamp(start)}`, `DTEND:${stamp(end)}`, `SUMMARY:${esc(l.title)}`);
      if (loc) lines.push(`LOCATION:${esc(loc)}`);
      if (desc) lines.push(`DESCRIPTION:${esc(desc)}`);
      if (l.links?.[0]) lines.push(`URL:${l.links[0]}`);
      if (alarm) lines.push('BEGIN:VALARM', `TRIGGER:-PT${alarm}M`, 'ACTION:DISPLAY', `DESCRIPTION:${esc(l.title)}`, 'END:VALARM');
      lines.push('END:VEVENT');
    }
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, { 'Content-Type': type });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/groups') {
      return send(res, 200, { groups: await getGroups() });
    }
    if (url.pathname === '/api/teachers') {
      return send(res, 200, { teachers: await getTeachers() });
    }
    if (url.pathname === '/api/schedule') {
      const group = (url.searchParams.get('group') || '').trim();
      const teacher = (url.searchParams.get('teacher') || '').trim();
      if (!group && !teacher) return send(res, 400, { error: 'Укажите группу или преподавателя' });
      return send(res, 200, await getSchedule({
        group, teacher, session: url.searchParams.get('session') === '1',
      }));
    }
    if (url.pathname === '/api/calendar.ics') {
      const group = (url.searchParams.get('group') || '').trim();
      const teacher = (url.searchParams.get('teacher') || '').trim();
      if (!group && !teacher) return send(res, 400, { error: 'Укажите группу или преподавателя' });
      const data = await getSchedule({ group, teacher, session: url.searchParams.get('session') === '1' });
      const alarm = Math.min(120, Math.max(0, parseInt(url.searchParams.get('alarm') || '0', 10) || 0));
      const headers = { 'Content-Type': 'text/calendar; charset=utf-8' };
      if (url.searchParams.get('download') === '1') headers['Content-Disposition'] = 'attachment; filename="schedule.ics"';
      res.writeHead(200, headers);
      return res.end(buildICS(data, alarm));
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = await fs.readFile(path.join(__dirname, 'public', 'index.html'), 'utf8');
      return send(res, 200, html, 'text/html; charset=utf-8');
    }
    send(res, 404, { error: 'Не найдено' });
  } catch (e) {
    send(res, 502, { error: e.message || 'Не удалось получить данные' });
  }
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));