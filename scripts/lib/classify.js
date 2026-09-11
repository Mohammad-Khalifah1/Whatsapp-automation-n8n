/**
 * Request/product classification.
 *
 * CANONICAL SOURCE. Unit-tested (tests/classify/classify.test.js) and injected
 * verbatim into n8n Code nodes by scripts/setup/build-workflows.js.
 *
 * The category list is NOT hard-coded here. It is read at runtime from the
 * `Categories` tab of the same spreadsheet, so the business can add a product
 * line or reword a keyword without a rebuild, a re-import, or a developer.
 * This file only knows HOW to match, never WHAT to match.
 *
 * Matching is deliberately keyword-based rather than AI:
 *   - deterministic, so the same message always files under the same category,
 *   - free and instant, so it cannot add latency or cost per message,
 *   - fully testable without a network call or an API key.
 * An AI classifier can replace this later behind the same function signature.
 *
 * Arabic is normalized before matching (see normalizeForMatch) because the same
 * word arrives spelled many ways: diacritics, the alef variants, teh marbuta
 * for heh, and the definite article glued to the front of the noun. Without
 * normalization a keyword meaning "air conditioning" would miss every message
 * that wrote it with "al-" attached.
 *
 * Nothing here throws. A malformed Categories row is skipped, and a message
 * that matches nothing gets the fallback category rather than an empty cell.
 */

'use strict';

/** Returned when no category matched, so the column is never blank. */
const UNCLASSIFIED = {
  category_id: 'UNCLASSIFIED',
  category: 'غير مصنّف', // "ghayr musannaf"
};

/** Why a classification came out the way it did (recorded in the audit log). */
const REASON = {
  MATCHED: 'matched',
  NO_TEXT: 'no_text_to_classify',
  NO_CATEGORIES: 'no_active_categories_configured',
  NO_MATCH: 'no_keyword_matched',
};

/* -------------------------------------------------------------------------
   Normalization
   ------------------------------------------------------------------------- */

/** Arabic-Indic and extended Arabic-Indic digits to ASCII. */
function asciiDigits(text) {
  return text.replace(/[٠-٩۰-۹]/g, function (d) {
    const code = d.charCodeAt(0);
    const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String(code - base);
  });
}

/**
 * Fold a string into the form keywords are matched against.
 *
 * Lowercases Latin, strips Arabic diacritics and tatweel, unifies the letter
 * shapes that vary by typist, and turns punctuation into spaces. The result is
 * only ever used for comparison — the original text is what gets stored.
 */
function normalizeForMatch(value) {
  if (value === null || value === undefined) return '';
  let text = String(value).toLowerCase();

  text = asciiDigits(text);

  // Harakat (diacritics) and the decorative tatweel carry no meaning here.
  text = text.replace(/[ً-ٰٟ]/g, '');
  text = text.replace(/ـ/g, '');

  // Unify the letter shapes people spell inconsistently.
  text = text.replace(/[أإآٱ]/g, 'ا'); // alef variants -> alef
  text = text.replace(/ة/g, 'ه');                     // teh marbuta  -> heh
  text = text.replace(/ى/g, 'ي');                     // alef maksura -> yeh
  text = text.replace(/ؤ/g, 'و');                     // waw hamza    -> waw
  text = text.replace(/ئ/g, 'ي');                     // yeh hamza    -> yeh
  text = text.replace(/ء/g, '');                           // bare hamza dropped

  // Everything that is not a letter or digit becomes a separator, so a word
  // followed by a question mark matches the same keyword as the bare word.
  text = text.replace(/[^\p{L}\p{N}]+/gu, ' ');

  return text.trim().replace(/\s+/g, ' ');
}

/** True when a keyword contains Arabic script. */
function hasArabic(value) {
  return /[؀-ۿݐ-ݿ]/.test(value);
}

/* -------------------------------------------------------------------------
   Category rows
   ------------------------------------------------------------------------- */

/** Sheets cells arrive as strings, and humans type TRUE / true / 1 / yes. */
function isActive(value) {
  if (value === undefined || value === null || value === '') return true; // blank = active
  const v = String(value).trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'y' || v === 'نعم';
}

/** Blank or non-numeric priority sorts last rather than producing NaN. */
function parsePriority(value) {
  const raw = value === undefined || value === null ? '' : String(value).trim();
  const n = Number(raw);
  return raw !== '' && Number.isFinite(n) ? n : 9999;
}

/**
 * Split a keywords cell into individual keywords.
 * Accepts the separators people actually type, including the Arabic comma.
 */
function parseKeywords(raw) {
  if (raw === null || raw === undefined) return [];
  return String(raw)
    .split(/[,،|;\n\r]+/)
    .map(function (k) { return normalizeForMatch(k); })
    .filter(function (k) { return k.length > 0; });
}

/**
 * Turn raw `Categories` rows into matchable records, in match order.
 *
 * Order is priority ascending, then category_id ascending. It decides ties, so
 * a complaint row with priority 5 beats a pricing row with priority 20 when a
 * message hits one keyword from each. Determinism matters: the same message
 * must never land in a different category on a re-run.
 */
function parseCategories(rows) {
  const parsed = [];

  for (const row of rows || []) {
    if (!row || typeof row !== 'object') continue;

    const categoryId = String(row.category_id || '').trim();
    const name = String(row.name || '').trim();
    if (!categoryId && !name) continue;      // blank spreadsheet row
    if (!isActive(row.active)) continue;

    const keywords = parseKeywords(row.keywords);
    if (keywords.length === 0) continue;     // nothing to match on

    parsed.push({
      category_id: categoryId || name,
      category: name || categoryId,
      keywords: keywords,
      priority: parsePriority(row.priority),
    });
  }

  parsed.sort(function (a, b) {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.category_id < b.category_id ? -1 : a.category_id > b.category_id ? 1 : 0;
  });

  return parsed;
}

/* -------------------------------------------------------------------------
   Matching
   ------------------------------------------------------------------------- */

/**
 * Does `keyword` occur in the already-normalized `text`?
 *
 * Arabic keywords match as substrings on purpose: the definite article and the
 * conjunctions are written joined to the noun, so the bare noun must match
 * inside the prefixed form. Latin keywords match whole tokens instead, because
 * substring matching there produces nonsense — "ac" would match "back".
 * A multi-word keyword always matches as a substring.
 */
function keywordMatches(text, keyword, tokens) {
  if (!keyword) return false;
  if (keyword.indexOf(' ') !== -1) return text.indexOf(keyword) !== -1;
  if (hasArabic(keyword)) return text.indexOf(keyword) !== -1;
  return tokens.indexOf(keyword) !== -1;
}

/**
 * Classify one message.
 *
 * @param {string|null} text      The message text as received (not normalized).
 * @param {Array<object>} rows    Raw rows from the `Categories` sheet.
 * @param {object} [options]
 * @param {object} [options.fallback]  {category_id, category} when nothing matches.
 * @returns {{
 *   category_id: string,
 *   category: string,
 *   matched: boolean,
 *   matched_keywords: string[],
 *   match_count: number,
 *   reason: string
 * }}
 *
 * Never throws. A non-text message (image, location, audio) classifies as the
 * fallback with reason NO_TEXT, which is information, not an error.
 */
function classify(text, rows, options) {
  const opts = options || {};
  const fallback = opts.fallback || UNCLASSIFIED;

  function result(category, reason, matchedKeywords) {
    return {
      category_id: category.category_id,
      category: category.category,
      matched: reason === REASON.MATCHED,
      matched_keywords: matchedKeywords || [],
      match_count: matchedKeywords ? matchedKeywords.length : 0,
      reason: reason,
    };
  }

  const categories = parseCategories(rows);
  if (categories.length === 0) return result(fallback, REASON.NO_CATEGORIES);

  const normalized = normalizeForMatch(text);
  if (!normalized) return result(fallback, REASON.NO_TEXT);

  const tokens = normalized.split(' ');

  // Best match = most keywords hit. `categories` is already in tie-break order
  // and the comparison is strictly greater-than, so the first category to reach
  // a given count keeps it.
  let best = null;
  let bestHits = [];

  for (const category of categories) {
    const hits = category.keywords.filter(function (k) {
      return keywordMatches(normalized, k, tokens);
    });
    if (hits.length > bestHits.length) {
      best = category;
      bestHits = hits;
    }
  }

  if (!best) return result(fallback, REASON.NO_MATCH);
  return result(best, REASON.MATCHED, bestHits);
}

module.exports = {
  classify,
  parseCategories,
  parseKeywords,
  normalizeForMatch,
  keywordMatches,
  UNCLASSIFIED,
  REASON,
};
