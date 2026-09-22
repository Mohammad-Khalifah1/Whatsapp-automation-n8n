/**
 * Approved templates (scripts/lib/templates.js): the marker a person types,
 * the allow-list, and the message body.
 */

'use strict';

const { parseTemplateMarker, parseTemplateCatalog, buildTemplateMessage } = require('../../scripts/lib/templates');

const CATALOG = JSON.stringify([
  { name: 'followup_general', language: 'ar', category: 'utility', params: ['customer_name'] },
  { name: 'order_ready', language: 'ar' },
]);

describe('parseTemplateMarker', () => {
  it('reads the marker and the template name', () => {
    assert.deepEqual(parseTemplateMarker('[TEMPLATE] followup_general'),
      { isTemplate: true, name: 'followup_general', extra: '' });
  });

  it('reads the Arabic marker a phone keyboard gives', () => {
    const parsed = parseTemplateMarker('[قالب] followup_general');
    assert.equal(parsed.isTemplate, true);
    assert.equal(parsed.name, 'followup_general');
  });

  it('forgives case and spacing', () => {
    assert.equal(parseTemplateMarker('  [template]   order_ready  ').name, 'order_ready');
  });

  it('keeps anything typed after the name, without sending it', () => {
    assert.equal(parseTemplateMarker('[TEMPLATE] order_ready please').extra, 'please');
  });

  it('treats ordinary text as ordinary text', () => {
    assert.equal(parseTemplateMarker('are you still interested?').isTemplate, false);
    assert.equal(parseTemplateMarker('').isTemplate, false);
    assert.equal(parseTemplateMarker(null).isTemplate, false);
  });

  it('notices a marker with no name, instead of sending something unnamed', () => {
    const parsed = parseTemplateMarker('[TEMPLATE]');
    assert.equal(parsed.isTemplate, true);
    assert.equal(parsed.name, null);
  });
});

describe('parseTemplateCatalog', () => {
  it('reads the allow-list', () => {
    const catalog = parseTemplateCatalog(CATALOG);
    assert.equal(catalog.ok, true);
    assert.deepEqual(catalog.templates.followup_general.params, ['customer_name']);
    assert.equal(catalog.templates.followup_general.language, 'ar');
  });

  it('defaults a template with no parameters to none, not to a guess', () => {
    assert.deepEqual(parseTemplateCatalog(CATALOG).templates.order_ready.params, []);
  });

  it('says so when nothing is configured', () => {
    assert.equal(parseTemplateCatalog('').reason, 'no_templates_configured');
    assert.equal(parseTemplateCatalog('[]').reason, 'no_templates_configured');
  });

  it('says so when the setting cannot be read, instead of sending nothing silently', () => {
    assert.equal(parseTemplateCatalog('{not json').reason, 'templates_unreadable');
  });

  it('accepts a single template written without the array', () => {
    assert.equal(parseTemplateCatalog('{"name":"one","language":"en"}').templates.one.language, 'en');
  });
});

describe('buildTemplateMessage', () => {
  const catalog = parseTemplateCatalog(CATALOG).templates;

  it('builds the Cloud API body, filling parameters from the row', () => {
    const built = buildTemplateMessage('962790000001', catalog.followup_general, { customer_name: 'أحمد' });
    assert.equal(built.ok, true);
    assert.deepEqual(built.body, {
      messaging_product: 'whatsapp',
      to: '962790000001',
      type: 'template',
      template: {
        name: 'followup_general',
        language: { code: 'ar' },
        components: [{ type: 'body', parameters: [{ type: 'text', text: 'أحمد' }] }],
      },
    });
  });

  it('sends a template with no parameters without a components block', () => {
    const built = buildTemplateMessage('962790000001', catalog.order_ready, {});
    assert.equal(built.ok, true);
    assert.notOk('components' in built.body.template);
  });

  it('refuses when a parameter column is empty, and names it', () => {
    const built = buildTemplateMessage('962790000001', catalog.followup_general, { customer_name: '   ' });
    assert.equal(built.ok, false);
    assert.deepEqual(built.missing, ['customer_name']);
    assert.equal(built.body, null);
  });
});
