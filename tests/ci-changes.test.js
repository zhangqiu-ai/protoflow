import test from 'node:test';
import assert from 'node:assert/strict';
import { needsCodeChecks } from '../scripts/ci-changes.js';

test('documentation-only changes skip code checks; anything else runs them', () => {
  assert.equal(needsCodeChecks(['docs/proposals/0001-anchor-contracts.md']), false);
  assert.equal(needsCodeChecks(['README.md', 'examples/anchors/README.md', 'docs/architecture.md']), false);
  assert.equal(needsCodeChecks(['README.md', 'src/anchors.js']), true);
  assert.equal(needsCodeChecks(['.github/workflows/test.yml']), true);
  assert.equal(needsCodeChecks(['docs-site/index.html']), true);
  assert.equal(needsCodeChecks(['skills/protoflow/SKILL.md']), false);
  // An unknown diff (for example the first push of a branch) runs everything.
  assert.equal(needsCodeChecks([]), true);
});
