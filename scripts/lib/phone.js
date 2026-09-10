/**
 * Phone number normalization to E.164.
 *
 * CANONICAL SOURCE. This file is unit-tested (tests/conversations/phone.test.js)
 * and injected verbatim into n8n Code nodes by scripts/setup/build-workflows.js.
 * Do not fork this logic inside a workflow — edit here and re-run the build.
 *
 * Storage rule: phone numbers are stored as E.164 WITHOUT the leading '+'
 * (digits only), matching the format Meta uses for `wa_id` / `from`.
 * The '+' form and the wa.me link are derived, never stored separately.
 *
 * Normalization rules (docs/ARCHITECTURE.md "Phone Number Normalization"):
 *   1. Strip all formatting: spaces, '-', '(', ')', '.', non-breaking spaces,
 *      and Arabic-Indic digits are transliterated to ASCII.
 *   2. '00' international prefix  -> dropped (00962... -> 962...)
 *   3. Leading '+'                -> dropped (+962... -> 962...)
 *   4. Leading '0' national form  -> '0' replaced with defaultCountryCode
 *                                    (0791234567 -> 962791234567)
 *   5. Already-E.164 digits       -> passed through unchanged
 *   6. Anything else is flagged AMBIGUOUS rather than silently rewritten.
 *
 * The function NEVER throws. Callers branch on `ok`.
 */

'use strict';

/** E.164 permits at most 15 digits; ITU minimum in practice is ~7 (+ country code). */
const E164_MAX_DIGITS = 15;
const E164_MIN_DIGITS = 8;

/** Arabic-Indic (٠-٩) and Eastern Arabic-Indic (۰-۹) digit transliteration. */
const ARABIC_DIGIT_MAP = {
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
  '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4',
  '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
};

/**
 * Country-specific national-number length checks. Used ONLY to detect
 * ambiguity, never to rewrite a number. Extend as more markets are added.
 * `nsnLengths` = valid lengths of the national significant number
 * (i.e. what follows the country code).
 */
const COUNTRY_RULES = {
  // Jordan: mobile NSN is 9 digits beginning with 7 (77/78/79 today).
  '962': { nsnLengths: [9], mobilePrefixes: ['7'], name: 'Jordan' },
};

function transliterateDigits(str) {
  let out = '';
  for (const ch of str) {
    out += Object.prototype.hasOwnProperty.call(ARABIC_DIGIT_MAP, ch)
      ? ARABIC_DIGIT_MAP[ch]
      : ch;
  }
  return out;
}

/**
 * @param {string} raw                 Phone number in any common format.
 * @param {object} [opts]
 * @param {string} [opts.defaultCountryCode='962']  Country code (no '+') used to
 *                                    expand national '0...' forms.
 * @returns {{
 *   ok: boolean,
 *   e164: string|null,          // digits only, no '+', e.g. '962791234567'
 *   e164Plus: string|null,      // '+962791234567'
 *   waLink: string|null,        // 'https://wa.me/962791234567'
 *   input: string,
 *   applied: string[],          // transformations applied, for audit
 *   ambiguous: boolean,
 *   reason: string|null         // machine-readable code when !ok or ambiguous
 * }}
 */
function normalizePhone(raw, opts) {
  const options = opts || {};
  const defaultCountryCode = String(
    options.defaultCountryCode || '962'
  ).replace(/\D/g, '');

  const result = {
    ok: false,
    e164: null,
    e164Plus: null,
    waLink: null,
    input: raw === undefined || raw === null ? '' : String(raw),
    applied: [],
    ambiguous: false,
    reason: null,
  };

  if (raw === undefined || raw === null || String(raw).trim() === '') {
    result.reason = 'EMPTY_INPUT';
    return result;
  }

  let s = transliterateDigits(String(raw).trim());
  if (s !== String(raw).trim()) result.applied.push('transliterated_arabic_digits');

  // Reject clearly non-numeric input (letters imply this isn't a phone number).
  if (/[A-Za-z]/.test(s)) {
    result.reason = 'CONTAINS_LETTERS';
    return result;
  }

  const hadPlus = s.startsWith('+');
  // Strip every character that isn't a digit (spaces, -, (), ., etc.).
  const digitsOnly = s.replace(/\D/g, '');
  if (digitsOnly.length !== s.length) result.applied.push('stripped_formatting');

  if (digitsOnly === '') {
    result.reason = 'NO_DIGITS';
    return result;
  }

  let e164 = digitsOnly;

  if (hadPlus) {
    // '+CC...' is already E.164; nothing to infer.
    result.applied.push('stripped_plus');
  } else if (e164.startsWith('00')) {
    // '00' is the international access prefix in most of the world.
    e164 = e164.slice(2);
    result.applied.push('stripped_00_idd_prefix');
  } else if (e164.startsWith('0')) {
    // National (trunk) format: replace the trunk '0' with the country code.
    e164 = defaultCountryCode + e164.slice(1);
    result.applied.push('national_to_e164:' + defaultCountryCode);
  }

  // Length sanity checks against E.164 bounds.
  if (e164.length > E164_MAX_DIGITS) {
    result.reason = 'TOO_LONG';
    result.e164 = null;
    return result;
  }
  if (e164.length < E164_MIN_DIGITS) {
    result.reason = 'TOO_SHORT';
    return result;
  }

  // Ambiguity detection — flag, don't rewrite.
  const rule = COUNTRY_RULES[defaultCountryCode];
  if (rule && !hadPlus && !digitsOnly.startsWith('00') && !digitsOnly.startsWith('0')) {
    const startsWithCountryCode = e164.startsWith(defaultCountryCode);
    if (!startsWithCountryCode) {
      const looksLikeBareNsn =
        rule.nsnLengths.indexOf(e164.length) !== -1 &&
        rule.mobilePrefixes.some((p) => e164.startsWith(p));
      if (looksLikeBareNsn) {
        // e.g. '791234567' — probably Jordanian without the trunk 0, but we
        // will not guess. Surface it and let the caller decide.
        result.ambiguous = true;
        result.reason = 'AMBIGUOUS_MISSING_COUNTRY_CODE';
      } else {
        // Some other country's E.164 number — legitimate, pass through.
        result.applied.push('assumed_foreign_e164');
      }
    }
  }

  result.ok = true;
  result.e164 = e164;
  result.e164Plus = '+' + e164;
  result.waLink = 'https://wa.me/' + e164;
  return result;
}

/**
 * Build a wa.me deep link. Returns null rather than a malformed URL when the
 * input cannot be normalized — callers must handle null (never interpolate
 * an unvalidated number straight into a URL).
 */
function buildWaLink(raw, opts) {
  const n = normalizePhone(raw, opts);
  return n.ok ? n.waLink : null;
}

/**
 * Convenience: strict variant that treats ambiguity as failure. Used on paths
 * where guessing wrong would message the wrong person (e.g. outbound sends).
 */
function normalizePhoneStrict(raw, opts) {
  const n = normalizePhone(raw, opts);
  if (n.ambiguous) {
    return Object.assign({}, n, { ok: false, e164: null, e164Plus: null, waLink: null });
  }
  return n;
}

module.exports = {
  normalizePhone,
  normalizePhoneStrict,
  buildWaLink,
  E164_MAX_DIGITS,
  E164_MIN_DIGITS,
  COUNTRY_RULES,
};
