/**
 * Classification: Arabic normalization, keyword matching, priority tie-breaks,
 * and the cases where a message must NOT be confidently categorized.
 */

'use strict';

const {
  classify,
  parseCategories,
  parseKeywords,
  normalizeForMatch,
  keywordMatches,
  UNCLASSIFIED,
  REASON,
} = require('../../scripts/lib/classify');

/** Helper mirroring how rows actually arrive from Google Sheets: as strings. */
function category(id, name, keywords, priority, overrides) {
  return Object.assign(
    {
      category_id: id,
      name,
      keywords,
      priority: String(priority === undefined ? 20 : priority),
      active: 'TRUE',
      notes: '',
    },
    overrides || {}
  );
}

const PRICE = category('C-PRICE', 'استفسار سعر', 'سعر, بكم, price, how much', 20);
const COMPLAINT = category('C-COMPLAINT', 'شكوى', 'شكوى, مشكلة, complaint', 5);
const DELIVERY = category('C-DELIVERY', 'توصيل', 'توصيل, شحن, delivery', 30);

describe('classify — Arabic normalization', () => {
  it('strips diacritics so a carefully typed message still matches', () => {
    const result = classify('بِدّي أَعْرِف السِّعْر', [PRICE]);
    assert.equal(result.category_id, 'C-PRICE');
  });

  it('matches through the definite article and conjunction prefixes', () => {
    // The keyword is the bare noun; customers write it with ال / وال attached.
    for (const text of ['السعر كم', 'والسعر؟', 'بالسعر']) {
      assert.equal(classify(text, [PRICE]).category_id, 'C-PRICE', 'failed on: ' + text);
    }
  });

  it('unifies alef, teh marbuta and alef maksura variants', () => {
    // Keyword is spelled with ة; the message uses ه. Both must normalize alike.
    const result = classify('في مشكله بالطلب', [COMPLAINT]);
    assert.equal(result.category_id, 'C-COMPLAINT');
  });

  it('converts Arabic-Indic digits to ASCII', () => {
    assert.equal(normalizeForMatch('٣٥٠ دينار'), '350 دينار');
  });

  it('ignores punctuation, so a question mark cannot hide a keyword', () => {
    assert.equal(classify('بكم؟؟؟', [PRICE]).matched, true);
  });
});

describe('classify — keyword matching rules', () => {
  it('matches Latin keywords as whole words, not substrings', () => {
    // The classic false positive: a two-letter keyword inside a longer word.
    const ac = category('C-AC', 'تكييف', 'ac, تكييف', 20);
    assert.equal(classify('please call me back', [ac]).matched, false);
    assert.equal(classify('my ac is broken', [ac]).matched, true);
  });

  it('matches multi-word keywords as a phrase', () => {
    assert.equal(classify('how much is it', [PRICE]).category_id, 'C-PRICE');
    assert.equal(keywordMatches('how many do you have', 'how much', ['how', 'many']), false);
  });

  it('is case-insensitive for Latin text', () => {
    assert.equal(classify('PRICE please', [PRICE]).matched, true);
  });
});

describe('classify — choosing between categories', () => {
  it('prefers the category with the most keyword hits', () => {
    const result = classify('بدي اعرف السعر، بكم؟', [PRICE, DELIVERY]);
    assert.equal(result.category_id, 'C-PRICE');
    assert.equal(result.match_count, 2);
  });

  it('breaks an equal-hit tie by priority, lowest number first', () => {
    // One hit each. The complaint row has priority 5 against pricing's 20, so a
    // customer complaining about a price is a complaint, not a price enquiry.
    const result = classify('عندي مشكلة بالسعر', [PRICE, COMPLAINT]);
    assert.equal(result.category_id, 'C-COMPLAINT');
  });

  it('is order-independent: the same message always lands in the same place', () => {
    const a = classify('عندي مشكلة بالسعر', [PRICE, COMPLAINT]).category_id;
    const b = classify('عندي مشكلة بالسعر', [COMPLAINT, PRICE]).category_id;
    assert.equal(a, b);
  });

  it('breaks a priority tie deterministically by category_id', () => {
    const x = category('C-ZEBRA', 'زد', 'مرحبا', 10);
    const y = category('C-ALPHA', 'الف', 'مرحبا', 10);
    assert.equal(classify('مرحبا', [x, y]).category_id, 'C-ALPHA');
    assert.equal(classify('مرحبا', [y, x]).category_id, 'C-ALPHA');
  });
});

describe('classify — when it must not guess', () => {
  it('falls back rather than leaving the column blank', () => {
    const result = classify('السلام عليكم', [PRICE]);
    assert.equal(result.category_id, UNCLASSIFIED.category_id);
    assert.equal(result.matched, false);
    assert.equal(result.reason, REASON.NO_MATCH);
  });

  it('reports NO_TEXT for a message with no words (image, location, audio)', () => {
    // The workflow passes null for these rather than the "[location] ..."
    // preview, which would otherwise match a keyword like "location".
    const result = classify(null, [PRICE]);
    assert.equal(result.reason, REASON.NO_TEXT);
    assert.equal(result.category_id, UNCLASSIFIED.category_id);
  });

  it('reports NO_CATEGORIES when the tab is empty, instead of throwing', () => {
    assert.equal(classify('بكم السعر', []).reason, REASON.NO_CATEGORIES);
    assert.equal(classify('بكم السعر', null).reason, REASON.NO_CATEGORIES);
  });

  it('accepts a caller-supplied fallback', () => {
    const fallback = { category_id: 'C-GENERAL', category: 'عام' };
    assert.equal(classify('السلام عليكم', [PRICE], { fallback }).category_id, 'C-GENERAL');
  });

  it('never throws on malformed input', () => {
    assert.doesNotThrow(() => classify(undefined, [null, 'nonsense', {}, PRICE]));
    assert.doesNotThrow(() => classify({ weird: true }, [PRICE]));
  });
});

describe('classify — reading the Categories tab', () => {
  it('skips rows the business has switched off', () => {
    const off = category('C-OFF', 'مغلق', 'سعر', 1, { active: 'FALSE' });
    assert.equal(classify('كم السعر', [off, PRICE]).category_id, 'C-PRICE');
  });

  it('treats a blank active cell as on, so a new row works immediately', () => {
    const blank = category('C-NEW', 'جديد', 'سعر', 1, { active: '' });
    assert.equal(classify('كم السعر', [blank]).category_id, 'C-NEW');
  });

  it('skips blank rows and rows with no keywords', () => {
    const parsed = parseCategories([
      { category_id: '', name: '', keywords: '' },
      category('C-NOKEYS', 'بدون كلمات', '   ', 10),
      PRICE,
    ]);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].category_id, 'C-PRICE');
  });

  it('accepts the separators people actually type, including the Arabic comma', () => {
    assert.deepEqual(parseKeywords('سعر،بكم | price; cost'), ['سعر', 'بكم', 'price', 'cost']);
  });

  it('sorts a blank or non-numeric priority last rather than producing NaN', () => {
    const broken = category('C-BAD', 'بلا أولوية', 'سعر', undefined, { priority: 'abc' });
    const parsed = parseCategories([broken, PRICE]);
    assert.equal(parsed[0].category_id, 'C-PRICE');
    assert.equal(parsed[1].priority, 9999);
  });
});
