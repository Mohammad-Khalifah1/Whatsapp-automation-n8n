#!/usr/bin/env node
/**
 * Zero-dependency test runner.
 *
 * Deliberately has NO npm dependencies: the whole point of this project is that
 * a new machine can clone it and verify correctness with nothing but Docker and
 * Node. `npm install` failing behind a corporate proxy must never be the reason
 * nobody runs the tests.
 *
 * Usage:
 *   node tests/run-tests.js            # run everything
 *   node tests/run-tests.js assignment # run suites whose path matches a filter
 */

'use strict';

const fs = require('fs');
const path = require('path');

const state = {
  suites: [],
  currentSuite: null,
  passed: 0,
  failed: 0,
  failures: [],
};

/** Register a suite. */
function describe(name, fn) {
  const suite = { name, tests: [] };
  state.suites.push(suite);
  const previous = state.currentSuite;
  state.currentSuite = suite;
  fn();
  state.currentSuite = previous;
}

/** Register a test inside the current suite. */
function it(name, fn) {
  if (!state.currentSuite) throw new Error('it() called outside describe(): ' + name);
  state.currentSuite.tests.push({ name, fn });
}

function formatValue(v) {
  if (typeof v === 'string') return JSON.stringify(v);
  if (v === undefined) return 'undefined';
  try {
    return JSON.stringify(v);
  } catch (e) {
    return String(v);
  }
}

const assert = {
  equal(actual, expected, message) {
    if (actual !== expected) {
      throw new Error(
        (message ? message + '\n     ' : '') +
          'expected ' + formatValue(expected) + '\n     received ' + formatValue(actual)
      );
    }
  },
  deepEqual(actual, expected, message) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) {
      throw new Error(
        (message ? message + '\n     ' : '') +
          'expected ' + b + '\n     received ' + a
      );
    }
  },
  ok(value, message) {
    if (!value) {
      throw new Error((message || 'expected a truthy value') + ', received ' + formatValue(value));
    }
  },
  notOk(value, message) {
    if (value) {
      throw new Error((message || 'expected a falsy value') + ', received ' + formatValue(value));
    }
  },
  throws(fn, message) {
    let threw = false;
    try {
      fn();
    } catch (e) {
      threw = true;
    }
    if (!threw) throw new Error(message || 'expected function to throw');
  },
  /** Asserts a function does NOT throw — used heavily for malformed-input tests. */
  doesNotThrow(fn, message) {
    try {
      fn();
    } catch (e) {
      throw new Error((message || 'expected function not to throw') + ', but it threw: ' + e.message);
    }
  },
  includes(haystack, needle, message) {
    const arr = Array.isArray(haystack) ? haystack : String(haystack);
    const found = Array.isArray(arr) ? arr.indexOf(needle) !== -1 : arr.indexOf(needle) !== -1;
    if (!found) {
      throw new Error(
        (message ? message + '\n     ' : '') +
          'expected ' + formatValue(haystack) + ' to include ' + formatValue(needle)
      );
    }
  },
};

// Expose to test files.
global.describe = describe;
global.it = it;
global.assert = assert;

/** Recursively collect *.test.js files. */
function collectTestFiles(dir, acc) {
  const out = acc || [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      collectTestFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
      out.push(full);
    }
  }
  return out;
}

function main() {
  const filter = process.argv[2] || null;
  const testsRoot = __dirname;
  let files = collectTestFiles(testsRoot).sort();

  if (filter) {
    files = files.filter((f) => f.replace(/\\/g, '/').indexOf(filter) !== -1);
  }

  if (files.length === 0) {
    console.log('No test files found' + (filter ? ' matching filter: ' + filter : '') + '.');
    process.exit(1);
  }

  for (const file of files) {
    require(file);
  }

  const startedAt = Date.now();
  console.log('');
  for (const suite of state.suites) {
    console.log('  ' + suite.name);
    for (const test of suite.tests) {
      try {
        test.fn();
        state.passed += 1;
        console.log('    PASS  ' + test.name);
      } catch (err) {
        state.failed += 1;
        state.failures.push({ suite: suite.name, test: test.name, error: err });
        console.log('    FAIL  ' + test.name);
        console.log('          ' + String(err.message).split('\n').join('\n          '));
      }
    }
    console.log('');
  }

  const duration = Date.now() - startedAt;
  console.log('  ' + '-'.repeat(60));
  console.log(
    '  ' + state.passed + ' passed, ' + state.failed + ' failed, ' +
      (state.passed + state.failed) + ' total  (' + duration + 'ms)'
  );
  console.log('  ' + '-'.repeat(60));
  console.log('');

  if (state.failed > 0) {
    console.log('  Failing tests:');
    for (const f of state.failures) {
      console.log('    - ' + f.suite + ' > ' + f.test);
    }
    console.log('');
    process.exit(1);
  }
  process.exit(0);
}

main();
