/**
 * Test scenario 20: phone normalization.
 * Covers Jordan local/international forms, formatting noise, and the
 * requirement that ambiguous numbers are NOT silently corrupted.
 */

'use strict';

const { normalizePhone, normalizePhoneStrict, buildWaLink } = require('../../scripts/lib/phone');

describe('phone normalization — Jordan forms', () => {
  it('normalizes local 07XXXXXXXX to E.164', () => {
    const r = normalizePhone('0791234567');
    assert.ok(r.ok, 'should normalize');
    assert.equal(r.e164, '962791234567');
    assert.equal(r.e164Plus, '+962791234567');
    assert.equal(r.waLink, 'https://wa.me/962791234567');
    assert.includes(r.applied, 'national_to_e164:962');
  });

  it('normalizes +9627XXXXXXXX', () => {
    const r = normalizePhone('+962791234567');
    assert.ok(r.ok);
    assert.equal(r.e164, '962791234567');
    assert.includes(r.applied, 'stripped_plus');
  });

  it('passes through bare 9627XXXXXXXX unchanged', () => {
    const r = normalizePhone('962791234567');
    assert.ok(r.ok);
    assert.equal(r.e164, '962791234567');
    assert.notOk(r.ambiguous, 'already E.164 with country code, not ambiguous');
  });

  it('strips the 00 international access prefix', () => {
    const r = normalizePhone('00962791234567');
    assert.ok(r.ok);
    assert.equal(r.e164, '962791234567');
    assert.includes(r.applied, 'stripped_00_idd_prefix');
  });

  it('all four Jordan input forms converge on the same E.164 value', () => {
    const forms = ['0791234567', '+962791234567', '962791234567', '00962791234567'];
    const results = forms.map((f) => normalizePhone(f).e164);
    for (const r of results) {
      assert.equal(r, '962791234567', 'form should converge');
    }
  });
});

describe('phone normalization — formatting noise', () => {
  it('strips spaces, dashes, brackets and dots', () => {
    const messy = ['+962 79 123 4567', '+962-79-123-4567', '(+962) 79 1234567', '+962.79.123.4567', ' 0791234567 '];
    for (const m of messy) {
      const r = normalizePhone(m);
      assert.ok(r.ok, 'should normalize: ' + m);
      assert.equal(r.e164, '962791234567', 'from input: ' + m);
    }
  });

  it('never produces a URL containing spaces or plus signs', () => {
    const r = normalizePhone('+962 79 123 4567');
    assert.ok(r.waLink.indexOf(' ') === -1, 'no spaces in wa.me link');
    assert.ok(r.waLink.indexOf('+') === -1, 'no plus sign in wa.me link');
    assert.equal(r.waLink, 'https://wa.me/962791234567');
  });

  it('transliterates Arabic-Indic digits', () => {
    const r = normalizePhone('٠٧٩١٢٣٤٥٦٧');
    assert.ok(r.ok, 'Arabic digits should be handled');
    assert.equal(r.e164, '962791234567');
    assert.includes(r.applied, 'transliterated_arabic_digits');
  });
});

describe('phone normalization — rejects bad input without corrupting it', () => {
  it('rejects empty and whitespace input', () => {
    assert.notOk(normalizePhone('').ok);
    assert.equal(normalizePhone('').reason, 'EMPTY_INPUT');
    assert.notOk(normalizePhone('   ').ok);
    assert.notOk(normalizePhone(null).ok);
    assert.notOk(normalizePhone(undefined).ok);
  });

  it('rejects input containing letters', () => {
    const r = normalizePhone('07912ABCDE');
    assert.notOk(r.ok);
    assert.equal(r.reason, 'CONTAINS_LETTERS');
    assert.equal(r.waLink, null, 'must not build a link from a bad number');
  });

  it('rejects numbers that are too short or too long for E.164', () => {
    assert.equal(normalizePhone('12345').reason, 'TOO_SHORT');
    assert.equal(normalizePhone('+1234567890123456789').reason, 'TOO_LONG');
  });

  it('flags an ambiguous bare national number instead of guessing', () => {
    // 791234567 — could be Jordan without the trunk 0, but we refuse to assume.
    const r = normalizePhone('791234567');
    assert.ok(r.ambiguous, 'should be flagged ambiguous');
    assert.equal(r.reason, 'AMBIGUOUS_MISSING_COUNTRY_CODE');
  });

  it('strict mode treats ambiguity as failure so we never message the wrong person', () => {
    const lenient = normalizePhone('791234567');
    const strict = normalizePhoneStrict('791234567');
    assert.ok(lenient.ok, 'lenient mode still returns a best-effort value');
    assert.notOk(strict.ok, 'strict mode refuses');
    assert.equal(strict.waLink, null);
  });

  it('buildWaLink returns null (never a malformed URL) for bad input', () => {
    assert.equal(buildWaLink('not-a-number'), null);
    assert.equal(buildWaLink(''), null);
    assert.equal(buildWaLink('0791234567'), 'https://wa.me/962791234567');
  });

  it('never throws, whatever it is given', () => {
    const nasty = [null, undefined, '', '   ', {}, [], 0, -1, NaN, '+', '++962', '()-.', '٩'];
    for (const n of nasty) {
      assert.doesNotThrow(() => normalizePhone(n), 'input: ' + String(n));
    }
  });
});

describe('phone normalization — other countries', () => {
  it('accepts a foreign E.164 number without forcing the default country code', () => {
    const r = normalizePhone('+14155552671'); // US
    assert.ok(r.ok);
    assert.equal(r.e164, '14155552671');
    assert.equal(r.waLink, 'https://wa.me/14155552671');
  });

  it('honours a different defaultCountryCode for local forms', () => {
    const r = normalizePhone('05551234567', { defaultCountryCode: '90' }); // Turkey
    assert.ok(r.ok);
    assert.equal(r.e164, '905551234567');
  });
});
