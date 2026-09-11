/**
 * Meta WhatsApp Cloud API webhook payload parser.
 *
 * CANONICAL SOURCE. Unit-tested (tests/webhook/parser.test.js) and injected
 * into n8n Code nodes by scripts/setup/build-workflows.js.
 *
 * Payload shape verified against official documentation on 2026-09-09:
 *   https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/components
 *
 * A single webhook POST can legitimately contain MULTIPLE entries, each with
 * multiple changes, each with multiple messages and/or statuses. Flattening
 * that correctly matters: a naive `body.entry[0].changes[0].value.messages[0]`
 * silently drops messages under load, which looks exactly like "we lost a
 * customer's message".
 *
 * This parser NEVER throws. Malformed input produces `ok:false` plus a reason,
 * because a parser exception inside a webhook handler turns into a non-200
 * response, which makes Meta retry, which amplifies the failure.
 */

'use strict';

const { localIso } = require('./time');

/** Message types this system explicitly understands. */
const SUPPORTED_MESSAGE_TYPES = [
  'text',
  'image',
  'audio',
  'video',
  'document',
  'sticker',
  'location',
  'contacts',
  'interactive',
  'button',
  'reaction',
  'order',
  'system',
];

/** Types for which we can extract human-readable text for the Sheets preview. */
const TEXT_BEARING_TYPES = ['text', 'button', 'interactive', 'reaction'];

const EVENT_KIND = {
  MESSAGE: 'message',
  STATUS: 'status',
  /**
   * An "echo" of a message the business sent from the WhatsApp Business App
   * (or a linked companion device) rather than through the Cloud API.
   *
   * This arrives via the `smb_message_echoes` webhook field, which only exists
   * when WhatsApp Coexistence is enabled. It is the difference between
   * "an agent replied from their phone and we have no idea" and full reply
   * tracking. See docs/COEXISTENCE.md.
   */
  ECHO: 'echo',
  ERROR: 'error',
  UNKNOWN: 'unknown',
};

/** Echo sub-types that are not new messages but modifications of old ones. */
const ECHO_CONTROL_TYPES = ['revoke', 'edit'];

/**
 * Extract a short human-readable preview for the `last_message` column.
 * Media messages have no text, so we synthesize a stable placeholder rather
 * than writing "undefined" into a spreadsheet a manager will read.
 *
 * @returns {{text: string|null, preview: string, has_text: boolean}}
 */
function extractMessageText(message) {
  if (!message || typeof message !== 'object') {
    return { text: null, preview: '[unparseable message]', has_text: false };
  }

  const type = message.type;

  if (type === 'text' && message.text && typeof message.text.body === 'string') {
    return { text: message.text.body, preview: message.text.body, has_text: true };
  }

  // Quick-reply / CTA button taps.
  if (type === 'button' && message.button) {
    const t = message.button.text || message.button.payload || '';
    return { text: t || null, preview: t ? '[button] ' + t : '[button]', has_text: !!t };
  }

  // Interactive replies: list_reply / button_reply.
  if (type === 'interactive' && message.interactive) {
    const i = message.interactive;
    const reply = i.button_reply || i.list_reply || null;
    if (reply) {
      const t = reply.title || reply.id || '';
      return { text: t || null, preview: t ? '[interactive] ' + t : '[interactive]', has_text: !!t };
    }
    return { text: null, preview: '[interactive]', has_text: false };
  }

  if (type === 'reaction' && message.reaction) {
    const emoji = message.reaction.emoji || '';
    return { text: emoji || null, preview: '[reaction] ' + emoji, has_text: !!emoji };
  }

  // Media types may carry an optional caption.
  const mediaTypes = ['image', 'video', 'document', 'audio', 'sticker'];
  if (mediaTypes.indexOf(type) !== -1) {
    const media = message[type] || {};
    const caption = typeof media.caption === 'string' ? media.caption : null;
    const filename = typeof media.filename === 'string' ? media.filename : null;
    let preview = '[' + type + ']';
    if (filename) preview += ' ' + filename;
    if (caption) preview += ' ' + caption;
    return { text: caption, preview, has_text: !!caption };
  }

  if (type === 'location' && message.location) {
    const loc = message.location;
    const label = loc.name || loc.address || '';
    const coords =
      loc.latitude !== undefined && loc.longitude !== undefined
        ? loc.latitude + ',' + loc.longitude
        : '';
    return {
      text: null,
      preview: '[location] ' + (label || coords),
      has_text: false,
    };
  }

  if (type === 'contacts') {
    const n = Array.isArray(message.contacts) ? message.contacts.length : 0;
    return { text: null, preview: '[contacts x' + n + ']', has_text: false };
  }

  if (type === 'order') {
    return { text: null, preview: '[order]', has_text: false };
  }

  if (type === 'system' && message.system) {
    const body = message.system.body || '';
    return { text: body || null, preview: '[system] ' + body, has_text: !!body };
  }

  // Unknown/unsupported type — preserve the type name for debugging.
  return {
    text: null,
    preview: '[' + (type || 'unknown') + ']',
    has_text: false,
  };
}

/**
 * Convert Meta's Unix-seconds timestamp string to an ISO-8601 UTC string.
 * Returns null on garbage rather than "Invalid Date", which would poison
 * every downstream date comparison.
 */
function metaTimestampToIso(ts) {
  if (ts === undefined || ts === null || String(ts).trim() === '') return null;
  const seconds = Number(String(ts).trim());
  if (!isFinite(seconds) || seconds <= 0) return null;
  const d = new Date(seconds * 1000);
  if (isNaN(d.getTime())) return null;
  return localIso(d);
}

/**
 * Parse a full webhook POST body into a flat list of normalized events.
 *
 * @param {object} body  Parsed JSON body of the webhook request.
 * @returns {{
 *   ok: boolean,
 *   reason: string|null,
 *   object: string|null,
 *   events: Array<object>,
 *   counts: {messages: number, statuses: number, errors: number, unknown: number}
 * }}
 */
function parseWebhook(body) {
  const out = {
    ok: false,
    reason: null,
    object: null,
    events: [],
    counts: { messages: 0, statuses: 0, echoes: 0, errors: 0, unknown: 0 },
  };

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    out.reason = 'BODY_NOT_OBJECT';
    return out;
  }

  out.object = typeof body.object === 'string' ? body.object : null;

  // Meta always sets object='whatsapp_business_account' for WABA webhooks.
  // We accept but flag anything else instead of hard-failing, so a
  // misconfigured subscription is visible in the audit log.
  if (out.object !== 'whatsapp_business_account') {
    out.reason = 'UNEXPECTED_OBJECT_TYPE';
  }

  if (!Array.isArray(body.entry)) {
    out.reason = out.reason || 'MISSING_ENTRY_ARRAY';
    return out;
  }

  for (const entry of body.entry) {
    if (!entry || typeof entry !== 'object') continue;
    const wabaId = entry.id !== undefined ? String(entry.id) : null;
    const changes = Array.isArray(entry.changes) ? entry.changes : [];

    for (const change of changes) {
      if (!change || typeof change !== 'object') continue;
      const field = change.field !== undefined ? String(change.field) : null;
      const value = change.value && typeof change.value === 'object' ? change.value : {};
      const metadata = value.metadata && typeof value.metadata === 'object' ? value.metadata : {};

      // The business phone number that received the event. Critical for
      // multi-number WABAs: routing must be scoped per business number.
      const businessPhoneNumberId =
        metadata.phone_number_id !== undefined ? String(metadata.phone_number_id) : null;
      const businessDisplayPhone =
        metadata.display_phone_number !== undefined
          ? String(metadata.display_phone_number)
          : null;

      // contacts[] carries the customer's WhatsApp profile name, keyed by wa_id.
      const contactsByWaId = {};
      if (Array.isArray(value.contacts)) {
        for (const c of value.contacts) {
          if (c && c.wa_id !== undefined) {
            contactsByWaId[String(c.wa_id)] =
              c.profile && typeof c.profile.name === 'string' ? c.profile.name : null;
          }
        }
      }

      const base = {
        waba_id: wabaId,
        field,
        business_phone_number_id: businessPhoneNumberId,
        business_display_phone_number: businessDisplayPhone,
      };

      // ---- Inbound customer messages ----
      if (Array.isArray(value.messages)) {
        for (const m of value.messages) {
          if (!m || typeof m !== 'object') {
            out.counts.unknown += 1;
            out.events.push(Object.assign({}, base, {
              kind: EVENT_KIND.UNKNOWN,
              reason: 'MESSAGE_NOT_OBJECT',
            }));
            continue;
          }
          const type = m.type !== undefined ? String(m.type) : null;
          const supported = SUPPORTED_MESSAGE_TYPES.indexOf(type) !== -1;
          const textInfo = extractMessageText(m);
          const customerPhone = m.from !== undefined ? String(m.from) : null;

          out.counts.messages += 1;
          out.events.push(Object.assign({}, base, {
            kind: EVENT_KIND.MESSAGE,
            direction: 'inbound',
            message_id: m.id !== undefined ? String(m.id) : null,
            customer_phone: customerPhone,
            customer_name: customerPhone ? contactsByWaId[customerPhone] || null : null,
            message_type: type,
            supported,
            processing_status: supported ? 'parsed' : 'unsupported',
            text: textInfo.text,
            preview: textInfo.preview,
            has_text: textInfo.has_text,
            timestamp_unix: m.timestamp !== undefined ? String(m.timestamp) : null,
            timestamp_iso: metaTimestampToIso(m.timestamp),
            // Reply-to context, when the customer replies to a specific message.
            context_message_id: m.context && m.context.id ? String(m.context.id) : null,
            // Referral data present when the user arrived via a Click-to-WhatsApp ad.
            has_referral: !!m.referral,
            // Media id retained so the file can be fetched later if needed.
            media_id:
              m[type] && typeof m[type] === 'object' && m[type].id ? String(m[type].id) : null,
            mime_type:
              m[type] && typeof m[type] === 'object' && m[type].mime_type
                ? String(m[type].mime_type)
                : null,
            errors: Array.isArray(m.errors) ? m.errors : null,
          }));
        }
      }

      // ---- Outbound message status callbacks ----
      if (Array.isArray(value.statuses)) {
        for (const s of value.statuses) {
          if (!s || typeof s !== 'object') {
            out.counts.unknown += 1;
            out.events.push(Object.assign({}, base, {
              kind: EVENT_KIND.UNKNOWN,
              reason: 'STATUS_NOT_OBJECT',
            }));
            continue;
          }
          out.counts.statuses += 1;
          out.events.push(Object.assign({}, base, {
            kind: EVENT_KIND.STATUS,
            direction: 'outbound',
            // NOTE: this id refers to a message WE sent, so it matches a
            // previously stored outbound message_id.
            message_id: s.id !== undefined ? String(s.id) : null,
            status: s.status !== undefined ? String(s.status).toUpperCase() : null,
            recipient_phone: s.recipient_id !== undefined ? String(s.recipient_id) : null,
            timestamp_unix: s.timestamp !== undefined ? String(s.timestamp) : null,
            timestamp_iso: metaTimestampToIso(s.timestamp),
            conversation_id_meta:
              s.conversation && s.conversation.id ? String(s.conversation.id) : null,
            pricing_category:
              s.pricing && s.pricing.category ? String(s.pricing.category) : null,
            billable: s.pricing && s.pricing.billable !== undefined ? !!s.pricing.billable : null,
            errors: Array.isArray(s.errors) ? s.errors : null,
          }));
        }
      }

      // ---- Echoes of messages sent from the WhatsApp Business App ----
      //
      // CRITICAL DIFFERENCE from `messages`: the direction is reversed.
      // Here `from` is the BUSINESS and `to` is the CUSTOMER, because the
      // business is the sender. Treating an echo like an inbound message
      // would attribute the agent's own reply to the customer and flip the
      // conversation into UNANSWERED — the exact opposite of the truth.
      if (Array.isArray(value.message_echoes)) {
        for (const e of value.message_echoes) {
          if (!e || typeof e !== 'object') {
            out.counts.unknown += 1;
            out.events.push(Object.assign({}, base, {
              kind: EVENT_KIND.UNKNOWN,
              reason: 'ECHO_NOT_OBJECT',
            }));
            continue;
          }

          const type = e.type !== undefined ? String(e.type) : null;
          const isControl = ECHO_CONTROL_TYPES.indexOf(type) !== -1;
          const supported = isControl || SUPPORTED_MESSAGE_TYPES.indexOf(type) !== -1;
          const textInfo = extractMessageText(e);

          out.counts.echoes += 1;
          out.events.push(Object.assign({}, base, {
            kind: EVENT_KIND.ECHO,
            direction: 'outbound',
            // How this reply was sent — distinguishes it from a reply made
            // through workflow 4. Reporting needs to tell these apart.
            sent_via: 'whatsapp_business_app',
            message_id: e.id !== undefined ? String(e.id) : null,
            // `to` is the customer; `from` is our own business number.
            customer_phone: e.to !== undefined ? String(e.to) : null,
            business_display_phone_number:
              e.from !== undefined ? String(e.from) : businessDisplayPhone,
            message_type: type,
            supported,
            // revoke/edit modify an existing message rather than adding one.
            is_control_event: isControl,
            revoked_message_id:
              type === 'revoke' && e.revoke && e.revoke.message_id
                ? String(e.revoke.message_id)
                : null,
            edited_message_id:
              type === 'edit' && e.edit && e.edit.message_id
                ? String(e.edit.message_id)
                : null,
            processing_status: supported ? 'parsed' : 'unsupported',
            text: textInfo.text,
            preview: textInfo.preview,
            has_text: textInfo.has_text,
            timestamp_unix: e.timestamp !== undefined ? String(e.timestamp) : null,
            timestamp_iso: metaTimestampToIso(e.timestamp),
            media_id:
              e[type] && typeof e[type] === 'object' && e[type].id ? String(e[type].id) : null,
            mime_type:
              e[type] && typeof e[type] === 'object' && e[type].mime_type
                ? String(e[type].mime_type)
                : null,
          }));
        }
      }

      // ---- Account-level errors delivered on the webhook ----
      if (Array.isArray(value.errors) && value.errors.length > 0) {
        for (const e of value.errors) {
          out.counts.errors += 1;
          out.events.push(Object.assign({}, base, {
            kind: EVENT_KIND.ERROR,
            error_code: e && e.code !== undefined ? String(e.code) : null,
            error_title: e && e.title ? String(e.title) : null,
            error_message: e && e.message ? String(e.message) : null,
          }));
        }
      }

      // A change with none of the above is a subscription field we don't
      // handle yet (e.g. account_update, template status). Record it.
      const producedSomething =
        (Array.isArray(value.messages) && value.messages.length > 0) ||
        (Array.isArray(value.statuses) && value.statuses.length > 0) ||
        (Array.isArray(value.message_echoes) && value.message_echoes.length > 0) ||
        (Array.isArray(value.errors) && value.errors.length > 0);

      if (!producedSomething) {
        out.counts.unknown += 1;
        out.events.push(Object.assign({}, base, {
          kind: EVENT_KIND.UNKNOWN,
          reason: 'NO_RECOGNISED_PAYLOAD',
          raw_value_keys: Object.keys(value),
        }));
      }
    }
  }

  // ok=true means "structurally parseable", independent of whether the
  // contents were all recognised.
  out.ok = out.reason === null || out.reason === 'UNEXPECTED_OBJECT_TYPE';
  return out;
}

module.exports = {
  parseWebhook,
  extractMessageText,
  metaTimestampToIso,
  SUPPORTED_MESSAGE_TYPES,
  TEXT_BEARING_TYPES,
  EVENT_KIND,
  ECHO_CONTROL_TYPES,
};
