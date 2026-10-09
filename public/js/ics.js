// Exporta las tareas pendientes como calendario .ics (RFC 5545) para
// importarlas en Google Calendar, Outlook o el calendario del móvil.

const pad = (n) => String(n).padStart(2, '0');

function stamp(ts) {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

export function escapeText(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

// Las líneas de más de 75 octetos se pliegan con CRLF + espacio.
function fold(line) {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out = [];
  let cur = '';
  let len = 0;
  for (const ch of line) {
    const l = new TextEncoder().encode(ch).length;
    if (len + l > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = '';
      len = 0;
    }
    cur += ch;
    len += l;
  }
  out.push(cur);
  return out.join('\r\n ');
}

export function buildIcs(tasks, now = Date.now()) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//MoodleTasques//ES', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Tasques de Moodle'];
  tasks.forEach((t) => {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${escapeText(t.id)}@moodletasques`,
      `DTSTAMP:${stamp(now)}`,
      `DTSTART:${stamp(t.due - 30 * 60_000)}`,
      `DTEND:${stamp(t.due)}`,
      `SUMMARY:${escapeText(`${t.title} (${t.courseShort || t.courseName})`)}`,
      `DESCRIPTION:${escapeText(`Asignatura: ${t.courseName}`)}`,
      ...(t.url ? [`URL:${t.url}`] : []),
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${escapeText('Entrega: ' + t.title)}`,
      'TRIGGER:-PT24H',
      'END:VALARM',
      'END:VEVENT'
    );
  });
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
