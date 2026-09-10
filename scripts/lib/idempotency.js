/**
 * Idempotency and concurrency control.
 *
 * CANONICAL SOURCE. Unit-tested (tests/webhook/idempotency.test.js) and
 * injected into n8n Code nodes by scripts/setup/build-workflows.js.
 *
 * WHY THIS EXISTS
 * ---------------
 * Meta retries a webhook when it does not receive a timely 200. The same
 * message therefore arrives more than once, and a naive pipeline would create
 * duplicate Messages rows, duplicate Conversations, and — worst — assign the
 * same customer to two different agents and double-count both agents' load.
 *
 * The defence is layered:
 *   1. Deduplicate on the Meta message id (`wamid...`), which is globally
 *      unique and stable across retries. This is the primary guard and it is
 *      reliable.
 *   2. Serialize the assignment critical section. This is the WEAK guard,
 *      because Google Sheets offers no atomic compare-and-set. See
 *      docs/ASSIGNMENT_ALGORITHM.md for the honest limitations.
 */

'use strict';

const crypto = require('crypto');

/**
 * Build the deduplication key for an inbound event.
 *
 * For messages, the Meta message id alone is sufficient and correct.
 * For statuses, the same message id arrives repeatedly with DIFFERENT statuses
 * (sent -> delivered -> read), so the key must include the status, otherwise
 * legitimate status progression would be discarded as a duplicate.
 */
function buildDedupeKey(event) {
  const e = event || {};
  if (e.kind === 'status') {
    return 'status:' + String(e.message_id || 'unknown') + ':' + String(e.status || 'unknown');
  }
  if (e.kind === 'message') {
    return 'message:' + String(e.message_id || 'unknown');
  }
  // Unknown/error events: hash the stable identifying fields so repeated
  // deliveries of the same anomaly do not spam the audit log.
  const basis = JSON.stringify({
    kind: e.kind || null,
    waba: e.waba_id || null,
    biz: e.business_phone_number_id || null,
    code: e.error_code || null,
    reason: e.reason || null,
  });
  return 'other:' + crypto.createHash('sha256').update(basis).digest('hex').slice(0, 32);
}

/**
 * Decide whether an event has already been processed.
 *
 * @param {string} dedupeKey
 * @param {Array<object>} existingRows  Rows already in the Messages/Events
 *        sheet, each expected to expose `dedupe_key` (or `message_id`).
 * @returns {{ duplicate: boolean, matched: object|null }}
 */
function checkDuplicate(dedupeKey, existingRows) {
  const rows = Array.isArray(existingRows) ? existingRows : [];
  for (const row of rows) {
    if (!row) continue;
    const rowKey =
      row.dedupe_key !== undefined && row.dedupe_key !== null && String(row.dedupe_key) !== ''
        ? String(row.dedupe_key)
        : row.message_id !== undefined
          ? 'message:' + String(row.message_id)
          : null;
    if (rowKey !== null && rowKey === dedupeKey) {
      return { duplicate: true, matched: row };
    }
  }
  return { duplicate: false, matched: null };
}

/**
 * Detect an out-of-order status callback.
 *
 * Meta does not guarantee ordering, so `read` can arrive before `delivered`.
 * Statuses form a monotonic ladder; we must never downgrade a message that is
 * already READ back to DELIVERED.
 *
 * FAILED is terminal-but-special: it can legitimately follow SENT, and it must
 * never be overwritten by a late DELIVERED for the same message.
 */
const STATUS_RANK = {
  PENDING: 0,
  ACCEPTED: 1,
  SENT: 2,
  DELIVERED: 3,
  READ: 4,
  FAILED: 5,
};

function shouldApplyStatus(currentStatus, incomingStatus) {
  const cur = currentStatus ? String(currentStatus).toUpperCase() : null;
  const inc = incomingStatus ? String(incomingStatus).toUpperCase() : null;

  if (inc === null || STATUS_RANK[inc] === undefined) {
    return { apply: false, reason: 'UNKNOWN_INCOMING_STATUS' };
  }
  if (cur === null || STATUS_RANK[cur] === undefined) {
    return { apply: true, reason: 'NO_PRIOR_STATUS' };
  }
  if (cur === 'FAILED') {
    return { apply: false, reason: 'ALREADY_FAILED_TERMINAL' };
  }
  if (inc === 'FAILED') {
    return { apply: true, reason: 'FAILURE_OVERRIDES' };
  }
  if (STATUS_RANK[inc] > STATUS_RANK[cur]) {
    return { apply: true, reason: 'STATUS_ADVANCED' };
  }
  return { apply: false, reason: 'OUT_OF_ORDER_OR_STALE' };
}

/**
 * Advisory lock for the assignment critical section.
 *
 * HONEST LIMITATION: this is NOT a mutex. Google Sheets has no atomic
 * compare-and-set, so between "read lock row" and "write lock row" another
 * execution can interleave. What this buys us:
 *   - it collapses the race window from "the whole assignment pipeline"
 *     (several seconds of Sheets reads/writes) down to the round-trip of a
 *     single write (~200-400ms),
 *   - it makes contention VISIBLE in the audit log instead of silent,
 *   - it gives the eventual PostgreSQL implementation a drop-in seam: the same
 *     call site becomes `SELECT ... FOR UPDATE`.
 *
 * The real mitigation in the MVP is n8n workflow-level concurrency=1 on the
 * assignment workflow, which removes the race entirely on a single instance.
 * See docs/ASSIGNMENT_ALGORITHM.md.
 */
function buildLockClaim(resource, ownerExecutionId, nowMs, ttlSeconds) {
  const now = nowMs === undefined || nowMs === null ? Date.now() : Number(nowMs);
  const ttl = ttlSeconds === undefined ? 30 : Number(ttlSeconds);
  return {
    lock_resource: String(resource),
    lock_owner: String(ownerExecutionId),
    acquired_at: new Date(now).toISOString(),
    expires_at: new Date(now + ttl * 1000).toISOString(),
  };
}

/**
 * Decide whether a lock can be claimed given the currently stored lock row.
 * Expired locks are reclaimable so a crashed execution cannot deadlock the
 * queue forever.
 */
function canClaimLock(existingLock, nowMs) {
  const now = nowMs === undefined || nowMs === null ? Date.now() : Number(nowMs);
  if (!existingLock || !existingLock.lock_owner || String(existingLock.lock_owner) === '') {
    return { claimable: true, reason: 'NO_EXISTING_LOCK' };
  }
  const expiresAt = existingLock.expires_at ? Date.parse(String(existingLock.expires_at)) : NaN;
  if (isNaN(expiresAt)) {
    return { claimable: true, reason: 'EXISTING_LOCK_HAS_NO_VALID_EXPIRY' };
  }
  if (now >= expiresAt) {
    return { claimable: true, reason: 'EXISTING_LOCK_EXPIRED' };
  }
  return {
    claimable: false,
    reason: 'LOCK_HELD',
    held_by: String(existingLock.lock_owner),
    expires_at: existingLock.expires_at,
  };
}

/**
 * Deterministic correlation id for tracing one webhook through every workflow
 * and every audit row. Derived from the dedupe key so retries of the SAME
 * event share a correlation id (making retry storms obvious in the log).
 */
function buildCorrelationId(dedupeKey) {
  return 'corr-' + crypto.createHash('sha256').update(String(dedupeKey)).digest('hex').slice(0, 16);
}

module.exports = {
  buildDedupeKey,
  checkDuplicate,
  shouldApplyStatus,
  buildLockClaim,
  canClaimLock,
  buildCorrelationId,
  STATUS_RANK,
};
