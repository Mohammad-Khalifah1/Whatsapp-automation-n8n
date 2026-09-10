/**
 * Test scenarios 1, 11, 12: parsing real Meta payloads, malformed webhooks,
 * unsupported message types. Runs against the fixture files in n8n/fixtures/,
 * so the fixtures used by the live curl tests are the same ones asserted here.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { parseWebhook, extractMessageText, metaTimestampToIso } = require('../../scripts/lib/webhook-parser');

const FIXTURES = path.join(__dirname, '..', '..', 'n8n', 'fixtures');

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
}

describe('webhook parser — inbound text message (scenario 1)', () => {
  const parsed = parseWebhook(loadFixture('text-message.json'));

  it('parses successfully', () => {
    assert.ok(parsed.ok);
    assert.equal(parsed.counts.messages, 1);
    assert.equal(parsed.counts.statuses, 0);
  });

  it('identifies it as a customer message, not a status update', () => {
    assert.equal(parsed.events[0].kind, 'message');
    assert.equal(parsed.events[0].direction, 'inbound');
  });

  it('extracts the business phone number id (required for multi-number routing)', () => {
    assert.equal(parsed.events[0].business_phone_number_id, '106540352242922');
    assert.equal(parsed.events[0].business_display_phone_number, '962790000000');
  });

  it('extracts the customer phone and profile name', () => {
    assert.equal(parsed.events[0].customer_phone, '962791234567');
    assert.equal(parsed.events[0].customer_name, 'Omar Khaled');
  });

  it('extracts the message id, type and Arabic text intact', () => {
    assert.ok(parsed.events[0].message_id.indexOf('wamid.') === 0);
    assert.equal(parsed.events[0].message_type, 'text');
    assert.equal(parsed.events[0].text, 'مرحبا، بدي أعرف السعر.');
    assert.ok(parsed.events[0].supported);
  });

  it('converts the Unix timestamp to ISO-8601', () => {
    assert.equal(parsed.events[0].timestamp_iso, '2026-09-09T16:00:00.000Z');
    assert.equal(parsed.events[0].timestamp_unix, '1788969600');
  });
});

describe('webhook parser — status callbacks', () => {
  it('recognises a delivered status as a status event, not a message', () => {
    const p = parseWebhook(loadFixture('status-delivered.json'));
    assert.equal(p.counts.statuses, 1);
    assert.equal(p.counts.messages, 0);
    assert.equal(p.events[0].kind, 'status');
    assert.equal(p.events[0].status, 'DELIVERED');
    assert.equal(p.events[0].recipient_phone, '962791234567');
  });

  it('captures pricing/billability, which is how we know what a message cost', () => {
    const p = parseWebhook(loadFixture('status-delivered.json'));
    assert.equal(p.events[0].pricing_category, 'service');
    assert.equal(p.events[0].billable, false);
  });

  it('captures failure details including the 24-hour-window error', () => {
    const p = parseWebhook(loadFixture('status-failed.json'));
    assert.equal(p.events[0].status, 'FAILED');
    assert.ok(Array.isArray(p.events[0].errors));
    assert.equal(p.events[0].errors[0].code, 131047);
  });
});

describe('webhook parser — media, location and unsupported types (scenario 12)', () => {
  it('parses an image and keeps the caption plus media id', () => {
    const p = parseWebhook(loadFixture('image-message.json'));
    const e = p.events[0];
    assert.equal(e.message_type, 'image');
    assert.ok(e.supported);
    assert.equal(e.text, 'هذا هو المنتج', 'caption becomes the text');
    assert.equal(e.media_id, '1428394857263849');
    assert.equal(e.mime_type, 'image/jpeg');
  });

  it('parses a location into a readable preview without inventing text', () => {
    const p = parseWebhook(loadFixture('location-message.json'));
    const e = p.events[0];
    assert.equal(e.message_type, 'location');
    assert.equal(e.text, null, 'a location has no text');
    assert.includes(e.preview, 'Amman City Center');
  });

  it('does not crash on an unknown message type, and flags it for debugging', () => {
    const p = parseWebhook(loadFixture('unsupported-type.json'));
    const e = p.events[0];
    assert.ok(p.ok, 'the webhook still parses');
    assert.equal(e.kind, 'message');
    assert.equal(e.message_type, 'some_future_type_meta_invented');
    assert.notOk(e.supported, 'must be marked unsupported');
    assert.equal(e.processing_status, 'unsupported');
    assert.equal(e.customer_phone, '962770000001', 'metadata still preserved for debugging');
    assert.includes(e.preview, 'some_future_type_meta_invented');
  });
});

describe('webhook parser — batching and multiple business numbers', () => {
  const p = parseWebhook(loadFixture('batched-multiple-messages.json'));

  it('does NOT drop messages beyond the first (the classic parsing bug)', () => {
    assert.equal(p.counts.messages, 4, 'all four messages across both entries must appear');
  });

  it('keeps each message attributed to the business number that received it', () => {
    const byBiz = {};
    for (const e of p.events) {
      byBiz[e.business_phone_number_id] = (byBiz[e.business_phone_number_id] || 0) + 1;
    }
    assert.equal(byBiz['106540352242922'], 3);
    assert.equal(byBiz['999888777666555'], 1);
  });

  it('preserves message order within a burst (scenario: rapid-fire customer)', () => {
    const texts = p.events.filter((e) => e.business_phone_number_id === '106540352242922').map((e) => e.text);
    assert.deepEqual(texts, ['السلام عليكم', 'بدي أستفسر عن الطلب', 'رقم الطلب 12345']);
  });
});

describe('webhook parser — malformed input (scenario 11)', () => {
  it('flags a change containing neither messages nor statuses', () => {
    const p = parseWebhook(loadFixture('malformed-payload.json'));
    assert.ok(p.ok, 'structurally valid, just nothing recognised');
    assert.equal(p.counts.unknown, 1);
    assert.equal(p.events[0].kind, 'unknown');
    assert.equal(p.events[0].reason, 'NO_RECOGNISED_PAYLOAD');
  });

  it('rejects a non-object body with a reason instead of throwing', () => {
    for (const bad of [null, undefined, 'string', 42, []]) {
      const p = parseWebhook(bad);
      assert.notOk(p.ok, 'should not be ok for: ' + JSON.stringify(bad));
      assert.ok(p.reason !== null, 'must give a reason');
    }
  });

  it('reports a missing entry array rather than crashing', () => {
    const p = parseWebhook({ object: 'whatsapp_business_account' });
    assert.equal(p.reason, 'MISSING_ENTRY_ARRAY');
    assert.deepEqual(p.events, []);
  });

  it('flags an unexpected object type (misconfigured subscription)', () => {
    const p = parseWebhook({ object: 'page', entry: [] });
    assert.equal(p.reason, 'UNEXPECTED_OBJECT_TYPE');
  });

  it('never throws on hostile or nonsense input', () => {
    const nasty = [
      {}, { entry: null }, { entry: [null] }, { entry: [{ changes: null }] },
      { entry: [{ changes: [null] }] }, { entry: [{ changes: [{ value: null }] }] },
      { entry: [{ changes: [{ value: { messages: 'not-an-array' } }] }] },
      { entry: [{ changes: [{ value: { messages: [null] } }] }] },
      { entry: [{ changes: [{ value: { statuses: [42] } }] }] },
    ];
    for (const n of nasty) {
      assert.doesNotThrow(() => parseWebhook(n), 'input: ' + JSON.stringify(n));
    }
  });
});

describe('webhook parser — timestamp handling (scenario 21)', () => {
  it('converts Unix seconds to ISO UTC', () => {
    assert.equal(metaTimestampToIso('1788969600'), '2026-09-09T16:00:00.000Z');
  });

  it('returns null for garbage instead of "Invalid Date"', () => {
    for (const bad of [null, undefined, '', '   ', 'abc', '0', '-5']) {
      assert.equal(metaTimestampToIso(bad), null, 'input: ' + String(bad));
    }
  });

  it('always emits UTC so Asia/Amman DST cannot shift stored timestamps', () => {
    const iso = metaTimestampToIso('1788969600');
    assert.ok(iso.endsWith('Z'), 'must be UTC-suffixed: ' + iso);
  });
});

describe('webhook parser — text extraction per type', () => {
  it('handles interactive button replies', () => {
    const r = extractMessageText({
      type: 'interactive',
      interactive: { type: 'button_reply', button_reply: { id: 'yes_1', title: 'نعم' } },
    });
    assert.equal(r.text, 'نعم');
    assert.ok(r.has_text);
  });

  it('handles list replies', () => {
    const r = extractMessageText({
      type: 'interactive',
      interactive: { type: 'list_reply', list_reply: { id: 'opt_2', title: 'الخيار الثاني' } },
    });
    assert.equal(r.text, 'الخيار الثاني');
  });

  it('handles reactions', () => {
    const r = extractMessageText({ type: 'reaction', reaction: { message_id: 'wamid.X', emoji: '👍' } });
    assert.includes(r.preview, '👍');
  });

  it('produces a readable placeholder for media with no caption', () => {
    const r = extractMessageText({ type: 'audio', audio: { id: '123', mime_type: 'audio/ogg' } });
    assert.equal(r.text, null);
    assert.equal(r.preview, '[audio]', 'never writes "undefined" into the sheet');
    assert.notOk(r.has_text);
  });

  it('includes the filename for documents', () => {
    const r = extractMessageText({ type: 'document', document: { id: '1', filename: 'invoice.pdf' } });
    assert.includes(r.preview, 'invoice.pdf');
  });

  it('never returns undefined for the preview, whatever the input', () => {
    for (const bad of [null, undefined, {}, { type: null }, { type: 'weird' }]) {
      const r = extractMessageText(bad);
      assert.ok(typeof r.preview === 'string' && r.preview.length > 0, 'input: ' + JSON.stringify(bad));
    }
  });
});
