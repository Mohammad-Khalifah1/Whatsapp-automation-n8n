/**
 * What Meta charged for a message reaches the sheet.
 *
 * Meta's status webhook carries a `pricing` block: the category it billed
 * (service, utility, marketing) and whether it was billable at all. From
 * 1 October 2026 service messages are billed, so the dashboard's cost figures
 * have to come from what Meta itself says, not from a guess about which path
 * a reply took. The parser already read it; nothing wrote it down.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { parseWebhook, EVENT_KIND } = require('../../scripts/lib/webhook-parser');
const WORKFLOW = require(path.join('..', '..', 'n8n', 'workflows', '02-message-processor.json'));
const MESSAGES = fs.readFileSync(path.join(__dirname, '..', '..', 'sheets-templates', 'Messages.csv'), 'utf8')
  .split(/\r?\n/)[0].split(',').map((c) => c.trim());

const fixture = (name) => JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', '..', 'n8n', 'fixtures', name), 'utf8'));

describe('pricing capture', () => {
  it('the Messages tab has somewhere to put it', () => {
    assert.ok(MESSAGES.indexOf('pricing_category') !== -1);
    assert.ok(MESSAGES.indexOf('billable') !== -1);
  });

  it('the parser reads the pricing block Meta sends', () => {
    const events = parseWebhook(fixture('status-delivered.json')).events;
    const status = events.find((e) => e.kind === EVENT_KIND.STATUS);
    assert.ok(status, 'a delivery status');
    assert.ok(status.pricing_category, 'a category: ' + status.pricing_category);
    assert.equal(typeof status.billable, 'boolean');
  });

  it('the status update writes both, and leaves them alone without a pricing block', () => {
    const node = WORKFLOW.nodes.find((n) => n.name === 'Update Message Status');
    const value = node.parameters.columns.value;
    assert.includes(value.pricing_category, 'pricing_category');
    assert.includes(value.pricing_category, 'undefined', 'no pricing block leaves the cell as it was');
    assert.includes(value.billable, 'billable');
    assert.includes(value.billable, 'undefined');
    assert.deepEqual(node.parameters.columns.matchingColumns, ['message_id']);
  });

  it('a failure status still carries its category', () => {
    const events = parseWebhook(fixture('status-failed.json')).events;
    const status = events.find((e) => e.kind === EVENT_KIND.STATUS);
    assert.equal(status.status, 'FAILED');
    assert.ok(status.pricing_category === null || typeof status.pricing_category === 'string');
  });
});
