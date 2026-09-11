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
    assert.equal(Date.parse(parsed.events[0].timestamp_iso),
      Date.parse('2026-09-09T16:00:00.000Z'));
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
  // Timestamps are stored in the business timezone with an EXPLICIT offset.
  // The instant is what matters and is asserted directly; the rendering
  // follows whatever TZ the process runs under, which in the container is the
  // business timezone, so the sheet shows the time the team actually saw.
  it('converts Unix seconds to the same instant, in local time', () => {
    assert.equal(Date.parse(metaTimestampToIso('1788969600')),
      Date.parse('2026-09-09T16:00:00.000Z'));
  });

  it('returns null for garbage instead of "Invalid Date"', () => {
    for (const bad of [null, undefined, '', '   ', 'abc', '0', '-5']) {
      assert.equal(metaTimestampToIso(bad), null, 'input: ' + String(bad));
    }
  });

  // An offset-bearing ISO-8601 value names exactly one instant, so a DST
  // change cannot move a stored timestamp - the offset travels with the value.
  // A naive local string would have been ambiguous; this is not.
  it('always carries an explicit UTC offset, so no timestamp is ambiguous', () => {
    const iso = metaTimestampToIso('1788969600');
    assert.ok(/(Z|[+-]\d{2}:\d{2})$/.test(iso), 'must carry an offset: ' + iso);
    assert.equal(new Date(iso).getTime(), Date.parse('2026-09-09T16:00:00.000Z'));
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

describe('webhook parser — WhatsApp Business App echoes (Coexistence)', () => {
  it('recognises an app-sent reply as an OUTBOUND echo, not an inbound message', () => {
    const p = parseWebhook(loadFixture('echo-agent-reply.json'));
    assert.ok(p.ok);
    assert.equal(p.counts.echoes, 1);
    assert.equal(p.counts.messages, 0, 'must NOT be counted as a customer message');
    assert.equal(p.events[0].kind, 'echo');
    assert.equal(p.events[0].direction, 'outbound');
  });

  it('CRITICALLY attributes the customer correctly despite reversed from/to', () => {
    // In an echo, `from` is the BUSINESS and `to` is the CUSTOMER — the
    // opposite of a normal message. Getting this backwards would file the
    // agent's own reply under the business's phone number.
    const p = parseWebhook(loadFixture('echo-agent-reply.json'));
    const e = p.events[0];
    assert.equal(e.customer_phone, '962791234567', 'customer is `to`, not `from`');
    assert.equal(e.business_display_phone_number, '962790000000');
  });

  it('records how the reply was sent, so reporting can tell app from API', () => {
    const p = parseWebhook(loadFixture('echo-agent-reply.json'));
    assert.equal(p.events[0].sent_via, 'whatsapp_business_app');
  });

  it('extracts the reply text', () => {
    const p = parseWebhook(loadFixture('echo-agent-reply.json'));
    assert.equal(p.events[0].text, 'أهلا وسهلا، السعر 25 دينار.');
    assert.equal(Date.parse(p.events[0].timestamp_iso), Date.parse('2026-09-09T16:05:00.000Z'));
  });

  it('handles a revoke (message deleted from the app) as a control event', () => {
    const p = parseWebhook(loadFixture('echo-revoke.json'));
    const e = p.events[0];
    assert.equal(e.kind, 'echo');
    assert.equal(e.message_type, 'revoke');
    assert.ok(e.is_control_event, 'revoke modifies an existing message');
    assert.equal(e.revoked_message_id, 'wamid.ECHO00000000000000000000000000000000000001');
    assert.ok(e.supported, 'revoke is a known type, not an unsupported one');
  });

  it('does not report an echo-only payload as unrecognised', () => {
    const p = parseWebhook(loadFixture('echo-agent-reply.json'));
    assert.equal(p.counts.unknown, 0, 'message_echoes must count as recognised payload');
  });

  it('never throws on malformed echo arrays', () => {
    const nasty = [
      { object: 'whatsapp_business_account', entry: [{ changes: [{ value: { message_echoes: [null] } }] }] },
      { object: 'whatsapp_business_account', entry: [{ changes: [{ value: { message_echoes: 'nope' } }] }] },
      { object: 'whatsapp_business_account', entry: [{ changes: [{ value: { message_echoes: [42] } }] }] },
    ];
    for (const n of nasty) assert.doesNotThrow(() => parseWebhook(n));
  });
});
