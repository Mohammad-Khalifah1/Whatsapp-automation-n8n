/**
 * Meta's customer service window, in one place.
 *
 * A free-form message only reaches a customer who wrote to the business in
 * the last 24 hours. Outside that window Meta refuses it (error 131047) and
 * only an approved template can be sent. The window is measured from the
 * CUSTOMER's last message: a reply from the business never extends it.
 *
 * The send guard (V2-20) and the sheet's window column both follow this rule.
 * An unknown or unreadable timestamp counts as CLOSED, so a missing value can
 * cost a template, never a message Meta silently refuses.
 */

'use strict';

const WINDOW_HOURS = 24;
const HOUR_MS = 3600000;

/**
 * @param {object} input
 * @param {string} input.last_customer_message_at  ISO-8601, with offset or Z.
 * @param {Date|number} [input.now]                Defaults to the current time.
 * @returns {{open:boolean, hours_left:number, closes_at:(string|null), reason:string}}
 *   `hours_left` is whole hours, rounded down, 0 when closed. `closes_at` is
 *   ISO-8601 UTC, or null when the window cannot be known.
 */
function windowState(input) {
  const opts = input || {};
  let now = Date.now();
  if (opts.now instanceof Date) now = opts.now.getTime();
  else if (typeof opts.now === 'number') now = opts.now;

  const raw = opts.last_customer_message_at;
  const text = raw === undefined || raw === null ? '' : String(raw).trim();
  const at = text === '' ? NaN : Date.parse(text);
  if (isNaN(at)) {
    return {
      open: false,
      hours_left: 0,
      closes_at: null,
      reason: text === '' ? 'no_customer_message' : 'unreadable_timestamp',
    };
  }

  const closesAt = at + WINDOW_HOURS * HOUR_MS;
  const open = now < closesAt;
  return {
    open,
    // Capped, so a timestamp from a clock running ahead cannot promise more
    // than a whole window.
    hours_left: open ? Math.min(WINDOW_HOURS, Math.floor((closesAt - now) / HOUR_MS)) : 0,
    closes_at: new Date(closesAt).toISOString(),
    reason: open ? 'open' : 'closed',
  };
}

module.exports = { WINDOW_HOURS, windowState };
