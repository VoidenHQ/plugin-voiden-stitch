import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/sectionOutcome.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext },
});
const { isSectionFailed, isFileFailed } = await import(`data:text/javascript,${encodeURIComponent(outputText)}`);

function section(status, { total = 0, failed = 0, error = null } = {}) {
  return { status, error, assertions: { total, passed: total - failed, failed, results: [] } };
}

test('passing assertions accept expected HTTP errors', () => {
  assert.equal(isSectionFailed(section(404, { total: 1 })), false);
  assert.equal(isSectionFailed(section(500, { total: 2 })), false);
});

test('failed assertions and request errors still fail', () => {
  assert.equal(isSectionFailed(section(404, { total: 1, failed: 1 })), true);
  assert.equal(isSectionFailed(section(200, { total: 1, failed: 1 })), true);
  assert.equal(isSectionFailed(section(500, { total: 1, error: 'connection reset' })), true);
});

test('HTTP status remains the fallback without assertions', () => {
  assert.equal(isSectionFailed(section(200)), false);
  assert.equal(isSectionFailed(section(404)), true);
  assert.equal(isSectionFailed(section(500)), true);
});

test('file filtering uses the same section outcome', () => {
  assert.equal(isFileFailed({ status: 'passed', sections: [section(404, { total: 1 })] }), false);
  assert.equal(isFileFailed({ status: 'failed', sections: [section(404, { total: 1 })] }), true);
  assert.equal(isFileFailed({ status: 'passed', sections: [section(404)] }), true);
});
