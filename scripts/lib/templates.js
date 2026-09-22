/**
 * Approved templates: the only thing that reaches a customer outside the
 * 24-hour window.
 *
 * A template costs money, so nothing sends one on its own. A person writes a
 * marker in the reply cell — `[TEMPLATE] followup_general`, or `[قالب]` on an
 * Arabic keyboard — and only a name in the allow-list is sent. The allow-list
 * is `WHATSAPP_TEMPLATES` in .env, so a template that Meta has not approved
 * cannot be sent by a typo.
 *
 * Nothing here talks to Meta: it reads the marker, checks the name, and builds
 * the message body. Workflow 7 makes the call.
 */

'use strict';

/** Both spellings of the marker. The Arabic one is what a phone keyboard gives. */
const MARKERS = ['[TEMPLATE]', '[قالب]'];

/**
 * Read a reply cell as a template instruction.
 *
 * @param {string} text
 * @returns {{isTemplate:boolean, name:(string|null), extra:string}}
 */
function parseTemplateMarker(text) {
  const trimmed = String(text === undefined || text === null ? '' : text).trim();
  for (const marker of MARKERS) {
    if (trimmed.slice(0, marker.length).toUpperCase() === marker.toUpperCase()) {
      const rest = trimmed.slice(marker.length).trim();
      const parts = rest.split(/\s+/).filter(Boolean);
      return { isTemplate: true, name: parts.length > 0 ? parts[0] : null, extra: parts.slice(1).join(' ') };
    }
  }
  return { isTemplate: false, name: null, extra: '' };
}

/**
 * The allow-list, from WHATSAPP_TEMPLATES.
 *
 * ```
 * [{ "name": "followup_general", "language": "ar", "category": "utility",
 *    "params": ["customer_name"] }]
 * ```
 *
 * `params` names the columns that fill the template's {{1}}, {{2}} … in order.
 *
 * @returns {{ok:boolean, reason:(string|null), templates:object}}
 */
function parseTemplateCatalog(raw) {
  const text = raw === undefined || raw === null ? '' : String(raw).trim();
  if (text === '') return { ok: false, reason: 'no_templates_configured', templates: {} };

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, reason: 'templates_unreadable', templates: {} };
  }

  const list = Array.isArray(parsed) ? parsed : [parsed];
  const templates = {};
  for (const item of list) {
    if (!item || !item.name) continue;
    const name = String(item.name).trim();
    if (!name) continue;
    templates[name] = {
      name,
      language: String(item.language || 'ar').trim(),
      category: item.category ? String(item.category).trim() : null,
      params: Array.isArray(item.params) ? item.params.map((p) => String(p)) : [],
    };
  }
  const found = Object.keys(templates).length > 0;
  return { ok: found, reason: found ? null : 'no_templates_configured', templates };
}

/**
 * The Cloud API body for one template message.
 *
 * Meta refuses a parameter that is empty, so a template whose columns are not
 * filled in is reported rather than sent: the person sees which cell to fill.
 *
 * @param {string} to        Recipient, E.164 digits.
 * @param {object} template  From the catalogue.
 * @param {object} row       The conversation row, for the parameter columns.
 * @returns {{ok:boolean, body:(object|null), missing:string[]}}
 */
function buildTemplateMessage(to, template, row) {
  const columns = (template && template.params) || [];
  const values = columns.map((column) => {
    const value = row && row[column] !== undefined && row[column] !== null ? String(row[column]).trim() : '';
    return { column, value };
  });
  const missing = values.filter((v) => v.value === '').map((v) => v.column);
  if (missing.length > 0) return { ok: false, body: null, missing };

  const body = {
    messaging_product: 'whatsapp',
    to: String(to),
    type: 'template',
    template: {
      name: template.name,
      language: { code: template.language },
    },
  };
  if (values.length > 0) {
    body.template.components = [{
      type: 'body',
      parameters: values.map((v) => ({ type: 'text', text: v.value })),
    }];
  }
  return { ok: true, body, missing: [] };
}

module.exports = { MARKERS, parseTemplateMarker, parseTemplateCatalog, buildTemplateMessage };
