/**
 * Timestamps, in the timezone the business actually works in.
 *
 * CANONICAL SOURCE. Unit-tested (tests/conversations/time.test.js) and injected
 * into n8n Code nodes by scripts/setup/build-workflows.js.
 *
 * `new Date().toISOString()` always renders UTC. For a team in Amman that put
 * 15:57 in the sheet for a message that arrived at 18:57, while n8n's own
 * expression timestamps (`$now.toISO()`, which honours GENERIC_TIMEZONE) wrote
 * 18:57+03:00 in the next column. Two clocks in one spreadsheet.
 *
 * This renders the SAME instant with the running process's UTC offset, so the
 * value reads as local time and is still a valid ISO-8601 instant that
 * Date.parse and Google Sheets both understand. The container sets TZ, so the
 * offset is the business timezone.
 *
 * Lexicographic comparison stays meaningful because every timestamp the system
 * writes now carries the same offset - which is what the Dashboard's date
 * formulas compare against.
 */

'use strict';

function pad(value, width) {
  const s = String(Math.abs(value));
  return s.length >= (width || 2) ? s : '0'.repeat((width || 2) - s.length) + s;
}

/**
 * ISO-8601 with the local UTC offset, e.g. '2026-09-11T18:57:24.000+03:00'.
 * Falls back to 'Z' when the process is genuinely running on UTC.
 *
 * @param {Date|string|number} [when]  Defaults to now. Invalid input -> now.
 * @returns {string}
 */
function localIso(when) {
  let d;
  if (when === undefined || when === null || when === '') {
    d = new Date();
  } else {
    d = when instanceof Date ? when : new Date(when);
    if (isNaN(d.getTime())) d = new Date();
  }

  const offsetMinutes = -d.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const zone = offsetMinutes === 0
    ? 'Z'
    : sign + pad(Math.floor(Math.abs(offsetMinutes) / 60)) + ':' + pad(Math.abs(offsetMinutes) % 60);

  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) +
    '.' + pad(d.getMilliseconds(), 3) + zone;
}

module.exports = { localIso };
