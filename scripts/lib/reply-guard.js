/**
 * Why a typed reply cannot be sent, and how that is remembered.
 *
 * A reply that cannot go out (an unusable phone number, text over the limit,
 * or a customer service window that has closed) keeps its text, so the person
 * who typed it can see and fix it. That creates a loop: the next poll, a
 * minute later, finds the same text and writes the same failure again, for as
 * long as the text sits there.
 *
 * So the row remembers a short hash of the text and the reason. While both are
 * unchanged, the poll skips the row entirely: no write, no wasted quota. Edit
 * the text, or let the customer write again (which reopens the window and
 * changes the reason), and it is picked up immediately.
 */

'use strict';

const crypto = require('crypto');

/**
 * A short, stable fingerprint of "this text, blocked for this reason".
 *
 * @param {string} text    What the person typed.
 * @param {string} reason  Why it cannot be sent, e.g. `window_closed:closed`.
 * @returns {string}       16 hex characters — short enough to sit in a cell.
 */
function blockedHash(text, reason) {
  return crypto
    .createHash('sha1')
    .update(String(reason === undefined || reason === null ? '' : reason))
    .update('\n')
    .update(String(text === undefined || text === null ? '' : text))
    .digest('hex')
    .slice(0, 16);
}

module.exports = { blockedHash };
