#!/usr/bin/env node
/**
 * Check the documentation against the system it describes.
 *
 * Documentation rots quietly. A README that says "169 unit tests" when there
 * are 192, or that links to a file deleted three commits ago, is worse than no
 * README: it is confidently wrong, and the reader has no way to tell which
 * parts still hold.
 *
 * This checks the claims that CAN be checked mechanically:
 *   - every relative link resolves to a file that exists
 *   - counts of tests, checks, columns and workflows match reality
 *   - nothing still refers to a file or feature that was removed
 *   - every script, workflow and sheet tab that exists is mentioned somewhere
 *   - the docs are in English, and carry no tool branding
 *
 * It cannot check that prose is TRUE. It can check that prose is not
 * provably STALE, which is most of the rot.
 *
 * Usage:
 *   node scripts/validation/check-docs.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');

let checks = 0;
let failures = 0;
const problems = [];

function ok(label) {
  checks += 1;
  console.log('  [ok]   ' + label);
}

function fail(label, detail) {
  checks += 1;
  failures += 1;
  problems.push(label + (detail ? '  — ' + detail : ''));
  console.log('  [FAIL] ' + label);
  if (detail) console.log('         ' + detail);
}

function check(label, condition, detail) {
  if (condition) ok(label); else fail(label, detail);
}

// ------------------------------------------------------------ the system ---

/** Every markdown file git tracks. Untracked scratch files are not docs. */
function markdownFiles() {
  const out = execFileSync('git', ['ls-files', '*.md'], { cwd: ROOT, encoding: 'utf8' });
  return out.trim().split('\n').filter(Boolean);
}

function countTests() {
  const out = execFileSync(process.execPath, ['tests/run-tests.js'], { cwd: ROOT, encoding: 'utf8' });
  const m = /(\d+) passed, (\d+) failed, (\d+) total/.exec(out);
  if (!m) throw new Error('could not read the test count');
  return { passed: Number(m[1]), failed: Number(m[2]), total: Number(m[3]) };
}

function countWorkflowChecks() {
  const out = execFileSync(process.execPath, ['scripts/validation/validate-workflows.js'],
    { cwd: ROOT, encoding: 'utf8' });
  const m = /(\d+) checks passed, (\d+) failed/.exec(out);
  if (!m) throw new Error('could not read the workflow check count');
  return { passed: Number(m[1]), failed: Number(m[2]) };
}

function countSchemaChecks() {
  let out;
  try {
    out = execFileSync(process.execPath, ['scripts/validation/check-schema-consistency.js'],
      { cwd: ROOT, encoding: 'utf8' });
  } catch (e) {
    out = String(e.stdout || '');
  }
  const m = /(\d+) checks, (\d+) failed/.exec(out);
  if (!m) throw new Error('could not read the schema check count');
  return { total: Number(m[1]), failed: Number(m[2]) };
}

/** How many checks a verification script declares, counted from its source. */
function countRecordCalls(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  // record(...) calls inside loops are counted once here; the numbers the docs
  // quote come from an actual run, so this is only a floor.
  return (src.match(/^\s*record\(/gm) || []).length;
}

/** Prose only: fenced blocks and inline code are examples, not claims. */
function prose(text) {
  return text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
}

function csvColumns(file) {
  return fs.readFileSync(path.join(ROOT, 'sheets-templates', file), 'utf8')
    .split(/\r?\n/)[0].split(',').map((s) => s.trim()).filter(Boolean);
}

// ------------------------------------------------------------------ main ---

function main() {
  const files = markdownFiles();
  const docs = files.map((f) => ({ file: f, text: fs.readFileSync(path.join(ROOT, f), 'utf8') }));
  const all = docs.map((d) => d.text).join('\n');

  console.log('Checking ' + files.length + ' documents against the system\n');

  // --- links ---------------------------------------------------------------
  console.log('Links');
  let broken = [];
  for (const doc of docs) {
    const dir = path.dirname(path.join(ROOT, doc.file));
    const re = /\[[^\]]*\]\(([^)]+)\)/g;
    const body = prose(doc.text);
    let m;
    while ((m = re.exec(body)) !== null) {
      const target = m[1].split('#')[0].trim();
      if (!target || /^(https?:|mailto:)/.test(target)) continue;
      if (!fs.existsSync(path.resolve(dir, target))) {
        broken.push(doc.file + ' -> ' + target);
      }
    }
  }
  check('every relative link resolves', broken.length === 0, broken.join('; '));

  // --- removed things ------------------------------------------------------
  console.log('\nRemoved features');
  // CHANGELOG is a record of what happened; it is allowed to mention what was
  // removed. Everything else must not.
  const live = docs.filter((d) => path.basename(d.file) !== 'CHANGELOG.md');
  for (const [what, pattern] of [
    ['the MVP workflow as something you can use', /\]\(.*MVP_WORKFLOW\.md|n8n\/workflows\/00-mvp|webhook\/whatsapp\/mvp/],
    ['the Categories tab', /Categories\.csv|sheets-templates\/Categories/],
    ['the classifier', /lib\/classify|classify\.js/],
  ]) {
    const hits = live.filter((d) => pattern.test(d.text)).map((d) => d.file);
    check('nothing outside the changelog still describes ' + what,
      hits.length === 0, hits.join(', '));
  }

  // --- counts --------------------------------------------------------------
  console.log('\nCounts');
  const tests = countTests();
  const wf = countWorkflowChecks();
  const schema = countSchemaChecks();

  check('the test suite passes', tests.failed === 0, tests.failed + ' failing');
  check('workflow validation passes', wf.failed === 0, wf.failed + ' failing');
  check('schema consistency passes', schema.failed === 0, schema.failed + ' failing');

  /** Any "<n> unit tests" / "<n> tests" claim must be the real number. */
  const claim = (label, re, actual) => {
    const wrong = [];
    for (const doc of live) {
      let m;
      const r = new RegExp(re.source, 'g');
      while ((m = r.exec(doc.text)) !== null) {
        if (Number(m[1]) !== actual) wrong.push(doc.file + ': "' + m[0].trim() + '"');
      }
    }
    check('every "' + label + '" figure says ' + actual, wrong.length === 0, wrong.join('; '));
  };

  claim('unit tests', /(\d+)\s+unit\s+tests\b/, tests.total);
  claim('workflow checks', /(\d+)\s+checks\s+(?:passed|across)/, wf.passed);

  const wfFiles = fs.readdirSync(path.join(ROOT, 'n8n', 'workflows')).filter((f) => f.endsWith('.json'));
  const wfClaims = [];
  for (const doc of live) {
    const r = /(\d+)\s+workflows\b/g;
    let m;
    while ((m = r.exec(doc.text)) !== null) {
      if (Number(m[1]) !== wfFiles.length) wfClaims.push(doc.file + ': "' + m[0] + '"');
    }
  }
  check('every "n workflows" figure says ' + wfFiles.length, wfClaims.length === 0, wfClaims.join('; '));

  // --- sheet schema --------------------------------------------------------
  console.log('\nSheet schema');
  const conv = csvColumns('Conversations.csv');
  const arch = csvColumns('Archive.csv');
  const msgs = csvColumns('Messages.csv');

  const schemaDoc = docs.find((d) => d.file.endsWith('GOOGLE_SHEETS_SCHEMA.md'));
  const missingConv = conv.filter((c) => !schemaDoc.text.includes('`' + c + '`'));
  check('the schema document lists every Conversations column',
    missingConv.length === 0, 'missing: ' + missingConv.join(', '));

  const missingMsgs = msgs.filter((c) => !schemaDoc.text.includes('`' + c + '`'));
  check('the schema document lists every Messages column',
    missingMsgs.length === 0, 'missing: ' + missingMsgs.join(', '));

  check('Archive mirrors Conversations plus archived_at',
    arch.length === conv.length + 1 && arch[arch.length - 1] === 'archived_at',
    'Archive has ' + arch.length + ', Conversations ' + conv.length);

  // --- everything that exists is documented --------------------------------
  console.log('\nCoverage');
  const scripts = []
    .concat(fs.readdirSync(path.join(ROOT, 'scripts', 'setup')).map((f) => 'scripts/setup/' + f))
    .concat(fs.readdirSync(path.join(ROOT, 'scripts', 'testing')).map((f) => 'scripts/testing/' + f))
    .concat(fs.readdirSync(path.join(ROOT, 'scripts', 'validation')).map((f) => 'scripts/validation/' + f));
  const undocumented = scripts.filter((s) => !all.includes(path.basename(s)));
  check('every script is mentioned in the documentation',
    undocumented.length === 0, undocumented.join(', '));

  const tabs = ['Dashboard', 'Conversations', 'Agents', 'Archive', 'Messages', 'Log'];
  const missingTabs = tabs.filter((t) => !schemaDoc.text.includes('`' + t + '`'));
  check('the schema document covers every tab', missingTabs.length === 0, missingTabs.join(', '));

  // --- language and branding ----------------------------------------------
  console.log('\nLanguage and branding');
  // The documentation is WRITTEN in English. Arabic appearing as sample data -
  // a message body in an example table, a payload in a code block - is correct
  // and worth keeping: it is what proves the system handles it.
  const sentences = (text) => prose(text).split('\n')
    .filter((l) => !l.trim().startsWith('|'))
    .join('\n');
  const arabic = docs.filter((d) => /[؀-ۿ]/.test(sentences(d.text))).map((d) => d.file);
  check('the documentation is written in English', arabic.length === 0, arabic.join(', '));

  const branded = docs.filter((d) => /Generated with \[Claude|Co-Authored-By: Claude|🤖/i.test(d.text))
    .map((d) => d.file);
  check('no tool branding in the documentation', branded.length === 0, branded.join(', '));

  // --- the README specifically ---------------------------------------------
  console.log('\nREADME');
  const readme = docs.find((d) => d.file === 'README.md');
  for (const [what, needle] of [
    ['says what the system is for', /customer[- ]support|support routing/i],
    ['shows the pipeline', /\[1\]|Webhook Receiver/],
    ['links the setup guide', /docs\/SETUP\.md/],
    ['links the operating guide', /docs\/OPERATING_GUIDE\.md/],
    ['links the client report', /docs\/CLIENT_ONBOARDING\.md/],
    ['says how to verify it', /verify-live\.js/],
    ['states the running cost', /\$5|cost/i],
  ]) {
    check('the README ' + what, needle.test(readme.text));
  }

  // --- the verification scripts the docs quote -----------------------------
  console.log('\nVerification scripts');
  for (const f of ['scripts/testing/verify-live.js', 'scripts/testing/verify-archive.js']) {
    check(path.basename(f) + ' exists and declares checks', countRecordCalls(f) > 0);
  }

  console.log('\n' + '-'.repeat(64));
  console.log('  ' + (checks - failures) + ' passed, ' + failures + ' failed, ' + checks + ' checks');
  console.log('-'.repeat(64));
  if (failures) {
    console.log('\nProblems:');
    for (const p of problems) console.log('  - ' + p);
  }
  process.exit(failures ? 1 : 0);
}

main();
