/**
 * Codes inside, labels at the boundary.
 *
 * The workflows compare codes: `CLOSED`, `UNANSWERED`. The sheet shows labels
 * in the language the business works in. This module converts between the
 * two, so no workflow ever compares an Arabic string, and a sheet can change
 * language without a line of workflow logic changing.
 *
 * The `en` pack is the codes themselves. An English sheet therefore looks
 * exactly as it always has, and every value already stored in one still
 * reads back as the same code.
 *
 * Reading is forgiving: a value is recognised as a code, or as its label in
 * ANY pack, so a sheet that switches language, or holds a mix while it is
 * migrated, still reads correctly. Writing is exact: one label per code per
 * language.
 */

'use strict';

const LANGUAGES = ['en', 'ar'];

/** field -> code -> Arabic label. The English label is the code. */
const ARABIC = {
  status: {
    WAITING_FOR_AGENT: 'بانتظار موظف',
    UNANSWERED: 'بانتظار الرد',
    REPLIED: 'تم الرد',
    // Parked: waiting on the customer or on something outside the
    // conversation. The next customer message moves it back to UNANSWERED.
    WAITING_FOR_CUSTOMER: 'معلّقة',
    CLOSED: 'مغلقة',
    // A V1 instruction: "move this row to the Archive now". V2-15 folds it
    // into CLOSED; until then it keeps its own code.
    ARCHIVED: 'أرشفة الآن',
  },
  stage: {
    NEW: 'جديد',
    INTERESTED: 'مهتم',
    QUOTED: 'عرض مرسل',
    WON: 'اشترى',
    LOST: 'ضايع',
  },
  outcome: {
    BOUGHT: 'اشترى',
    LOST: 'ضايع',
    NO_REPLY: 'بدون رد',
    DUPLICATE: 'مكرر',
    NOT_RECORDED: 'غير مسجّل',
  },
  reply_status: {
    SENT: 'تم الإرسال',
    FAILED: 'فشل',
    WINDOW_CLOSED: 'النافذة مسكّرة — استعمل قالب',
  },
  direction: {
    inbound: 'الزبون',
    outbound: 'نحن',
  },
  via: {
    APP: 'تطبيق (مجاني)',
    SHEET: 'شيت (API)',
    TEMPLATE: 'قالب (مدفوع)',
    API: 'API',
  },
  window: {
    OPEN: 'مفتوحة',
    CLOSED: 'مسكّرة — بدك قالب',
  },
};

/** tab key -> title per language. Messages and Log are hidden, so they keep one name. */
const TABS = {
  Start: { en: 'Start', ar: 'ابدأ من هنا' },
  Dashboard: { en: 'Dashboard', ar: 'لوحة التحكم' },
  Conversations: { en: 'Conversations', ar: 'المحادثات' },
  FollowUps: { en: 'FollowUps', ar: 'متابعات اليوم' },
  Archive: { en: 'Archive', ar: 'الأرشيف' },
  Agents: { en: 'Agents', ar: 'الموظفين' },
  Lists: { en: 'Lists', ar: 'القوائم' },
  System: { en: 'System', ar: 'النظام — لا تلمسه' },
  Customers: { en: 'Customers', ar: 'Customers' },
  Messages: { en: 'Messages', ar: 'Messages' },
  Log: { en: 'Log', ar: 'Log' },
};

function fieldOf(field) {
  const pack = ARABIC[field];
  if (!pack) throw new Error('labels: unknown field "' + field + '"');
  return pack;
}

/** Every code of a field. */
function codes(field) {
  return Object.keys(fieldOf(field));
}

/**
 * The label to write for a code.
 *
 * An unknown code is returned unchanged rather than blanked: writing must
 * never lose a value just because it has no translation.
 */
function toLabel(field, code, lang) {
  const pack = fieldOf(field);
  if (code === null || code === undefined || code === '') return code;
  const key = String(code);
  if (!Object.prototype.hasOwnProperty.call(pack, key)) return key;
  return (lang || 'en') === 'ar' ? pack[key] : key;
}

/**
 * The code a stored value stands for, or null.
 *
 * Accepts the code itself (case-insensitively, since people type), or its
 * label in any language. Whitespace around the value is ignored.
 */
function toCode(field, value) {
  const pack = fieldOf(field);
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (text === '') return null;
  for (const code of Object.keys(pack)) {
    if (code === text || code.toLowerCase() === text.toLowerCase()) return code;
    if (pack[code] === text) return code;
  }
  return null;
}

/** The columns of a conversation row that hold a labelled value. */
const LABELLED_COLUMNS = {
  status: 'status',
  stage: 'stage',
  outcome: 'outcome',
  reply_status: 'reply_status',
  last_reply_via: 'via',
  last_message_direction: 'direction',
};

/**
 * A row as the logic wants it: labels turned back into codes.
 *
 * Called the moment a row is read, so nothing downstream ever compares an
 * Arabic string. `countOpenConversationsByAgent`, for one, asks whether a
 * status is open: against a labelled sheet every agent would read as having
 * no open conversations at all, and capacity would stop meaning anything.
 *
 * A value it does not recognise is left exactly as it was rather than blanked:
 * an unexpected status is something to look at, not something to lose.
 */
function normalizeConversationRow(row) {
  if (!row || typeof row !== 'object') return row;
  const out = Object.assign({}, row);
  for (const column of Object.keys(LABELLED_COLUMNS)) {
    if (out[column] === undefined || out[column] === null || out[column] === '') continue;
    const code = toCode(LABELLED_COLUMNS[column], out[column]);
    if (code !== null) out[column] = code;
  }
  return out;
}

/** The same row as the sheet wants it: codes turned into labels. */
function conversationRowToSheet(row, lang) {
  if (!row || typeof row !== 'object') return row;
  const out = Object.assign({}, row);
  for (const column of Object.keys(LABELLED_COLUMNS)) {
    if (out[column] === undefined || out[column] === null || out[column] === '') continue;
    out[column] = toLabel(LABELLED_COLUMNS[column], out[column], lang);
  }
  return out;
}

/** The title of a tab in a language. An unknown key is a bug, so it throws. */
function tabName(key, lang) {
  const tab = TABS[key];
  if (!tab) throw new Error('labels: unknown tab "' + key + '"');
  return tab[lang || 'en'] || tab.en;
}

module.exports = {
  LANGUAGES, ARABIC, TABS, LABELLED_COLUMNS,
  codes, toLabel, toCode, tabName,
  normalizeConversationRow, conversationRowToSheet,
};
