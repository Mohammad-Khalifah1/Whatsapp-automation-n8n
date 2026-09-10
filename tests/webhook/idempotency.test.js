/**
 * Test scenarios 3, 17, 18, 19: duplicate webhooks, and delivered/read/failed
 * status handling including out-of-order arrival.
 */

'use strict';

const {
  buildDedupeKey,
  checkDuplicate,
  shouldApplyStatus,
  buildLockClaim,
  canClaimLock,
  buildCorrelationId,
} = require('../../scripts/lib/idempotency');

describe('deduplication keys (scenario 3: duplicate webhook)', () => {
  it('produces a stable key for the same inbound message', () => {
    const event = { kind: 'message', message_id: 'wamid.ABC123' };
    assert.equal(buildDedupeKey(event), buildDedupeKey(event));
    assert.equal(buildDedupeKey(event), 'message:wamid.ABC123');
  });

  it('distinguishes different messages', () => {
    assert.ok(
      buildDedupeKey({ kind: 'message', message_id: 'wamid.A' }) !==
        buildDedupeKey({ kind: 'message', message_id: 'wamid.B' })
    );
  });

  it('CRITICALLY includes the status in status keys, so sent->delivered->read is not swallowed', () => {
    // If the key were the message id alone, 'delivered' would be discarded as a
    // duplicate of 'sent' and delivery tracking would silently never update.
    const sent = buildDedupeKey({ kind: 'status', message_id: 'wamid.X', status: 'SENT' });
    const delivered = buildDedupeKey({ kind: 'status', message_id: 'wamid.X', status: 'DELIVERED' });
    const read = buildDedupeKey({ kind: 'status', message_id: 'wamid.X', status: 'READ' });
    assert.ok(sent !== delivered && delivered !== read && sent !== read,
      'each status stage must have its own key');
  });

  it('treats a repeated identical status as a duplicate', () => {
    const a = buildDedupeKey({ kind: 'status', message_id: 'wamid.X', status: 'DELIVERED' });
    const b = buildDedupeKey({ kind: 'status', message_id: 'wamid.X', status: 'DELIVERED' });
    assert.equal(a, b);
  });

  it('generates a stable hashed key for unknown events without throwing', () => {
    const e = { kind: 'unknown', waba_id: '123', reason: 'NO_RECOGNISED_PAYLOAD' };
    assert.equal(buildDedupeKey(e), buildDedupeKey(e));
    assert.ok(buildDedupeKey(e).indexOf('other:') === 0);
  });

  it('never throws on malformed events', () => {
    for (const e of [null, undefined, {}, { kind: 'message' }, { kind: null }]) {
      assert.doesNotThrow(() => buildDedupeKey(e));
    }
  });
});

describe('duplicate detection against stored rows', () => {
  const stored = [
    { dedupe_key: 'message:wamid.ALREADY_SEEN', message_id: 'wamid.ALREADY_SEEN' },
    { dedupe_key: 'status:wamid.X:SENT', message_id: 'wamid.X' },
  ];

  it('detects a replayed message (Meta retry)', () => {
    const r = checkDuplicate('message:wamid.ALREADY_SEEN', stored);
    assert.ok(r.duplicate, 'must be recognised as already processed');
    assert.ok(r.matched !== null);
  });

  it('lets a genuinely new message through', () => {
    assert.notOk(checkDuplicate('message:wamid.BRAND_NEW', stored).duplicate);
  });

  it('lets DELIVERED through when only SENT was stored', () => {
    assert.notOk(checkDuplicate('status:wamid.X:DELIVERED', stored).duplicate,
      'status progression must not be blocked by dedupe');
  });

  it('falls back to message_id when a legacy row has no dedupe_key', () => {
    const legacy = [{ message_id: 'wamid.LEGACY' }];
    assert.ok(checkDuplicate('message:wamid.LEGACY', legacy).duplicate);
  });

  it('handles an empty or missing store (first ever message)', () => {
    assert.notOk(checkDuplicate('message:wamid.FIRST', []).duplicate);
    assert.notOk(checkDuplicate('message:wamid.FIRST', null).duplicate);
    assert.notOk(checkDuplicate('message:wamid.FIRST', undefined).duplicate);
  });

  it('never throws on rows containing nulls (deleted spreadsheet rows)', () => {
    assert.doesNotThrow(() => checkDuplicate('message:x', [null, undefined, {}, { dedupe_key: null }]));
  });
});

describe('status ladder (scenarios 17, 18, 19 + out-of-order events)', () => {
  it('applies the normal progression sent -> delivered -> read', () => {
    assert.ok(shouldApplyStatus(null, 'SENT').apply, 'first status always applies');
    assert.ok(shouldApplyStatus('SENT', 'DELIVERED').apply);
    assert.ok(shouldApplyStatus('DELIVERED', 'READ').apply);
  });

  it('REFUSES to downgrade READ back to DELIVERED (out-of-order webhook)', () => {
    const r = shouldApplyStatus('READ', 'DELIVERED');
    assert.notOk(r.apply, 'a late DELIVERED must not undo READ');
    assert.equal(r.reason, 'OUT_OF_ORDER_OR_STALE');
  });

  it('refuses to downgrade DELIVERED back to SENT', () => {
    assert.notOk(shouldApplyStatus('DELIVERED', 'SENT').apply);
  });

  it('ignores a repeat of the same status', () => {
    assert.notOk(shouldApplyStatus('DELIVERED', 'DELIVERED').apply);
  });

  it('lets FAILED override an in-flight status', () => {
    const r = shouldApplyStatus('SENT', 'FAILED');
    assert.ok(r.apply);
    assert.equal(r.reason, 'FAILURE_OVERRIDES');
  });

  it('treats FAILED as terminal — a late DELIVERED cannot resurrect it', () => {
    const r = shouldApplyStatus('FAILED', 'DELIVERED');
    assert.notOk(r.apply);
    assert.equal(r.reason, 'ALREADY_FAILED_TERMINAL');
  });

  it('is case-insensitive, since Meta sends lowercase', () => {
    assert.ok(shouldApplyStatus('sent', 'delivered').apply);
    assert.ok(shouldApplyStatus(null, 'read').apply);
  });

  it('rejects unknown incoming statuses instead of corrupting state', () => {
    const r = shouldApplyStatus('SENT', 'SOME_NEW_STATUS');
    assert.notOk(r.apply);
    assert.equal(r.reason, 'UNKNOWN_INCOMING_STATUS');
  });

  it('never throws on garbage', () => {
    for (const pair of [[null, null], [undefined, undefined], [42, 'READ'], ['READ', {}]]) {
      assert.doesNotThrow(() => shouldApplyStatus(pair[0], pair[1]));
    }
  });
});

describe('advisory lock (honest, limited concurrency mitigation)', () => {
  const T0 = Date.parse('2026-09-10T10:00:00.000Z');

  it('builds a claim with a bounded TTL so a crash cannot deadlock the queue', () => {
    const claim = buildLockClaim('assignment', 'exec-1', T0, 30);
    assert.equal(claim.lock_owner, 'exec-1');
    assert.equal(claim.acquired_at, '2026-09-10T10:00:00.000Z');
    assert.equal(claim.expires_at, '2026-09-10T10:00:30.000Z');
  });

  it('allows claiming when no lock is held', () => {
    assert.ok(canClaimLock(null, T0).claimable);
    assert.ok(canClaimLock({}, T0).claimable);
    assert.ok(canClaimLock({ lock_owner: '' }, T0).claimable);
  });

  it('refuses while another execution holds an unexpired lock', () => {
    const held = buildLockClaim('assignment', 'exec-1', T0, 30);
    const r = canClaimLock(held, T0 + 5000);
    assert.notOk(r.claimable);
    assert.equal(r.reason, 'LOCK_HELD');
    assert.equal(r.held_by, 'exec-1');
  });

  it('reclaims an expired lock (crashed owner must not block forever)', () => {
    const held = buildLockClaim('assignment', 'crashed-exec', T0, 30);
    const r = canClaimLock(held, T0 + 31000);
    assert.ok(r.claimable);
    assert.equal(r.reason, 'EXISTING_LOCK_EXPIRED');
  });

  it('reclaims a lock row a human corrupted in the spreadsheet', () => {
    const r = canClaimLock({ lock_owner: 'exec-1', expires_at: 'not a date' }, T0);
    assert.ok(r.claimable);
    assert.equal(r.reason, 'EXISTING_LOCK_HAS_NO_VALID_EXPIRY');
  });
});

describe('correlation ids for tracing', () => {
  it('is deterministic, so retries of the same event share a trace id', () => {
    const key = 'message:wamid.ABC';
    assert.equal(buildCorrelationId(key), buildCorrelationId(key));
  });

  it('differs across different events', () => {
    assert.ok(buildCorrelationId('message:wamid.A') !== buildCorrelationId('message:wamid.B'));
  });

  it('is short enough to be readable in a spreadsheet cell', () => {
    const id = buildCorrelationId('message:wamid.ABC');
    assert.ok(id.length <= 24, 'got length ' + id.length);
    assert.ok(id.indexOf('corr-') === 0);
  });
});
