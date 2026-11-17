import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('public permission record contains only the local-development go-ahead with no individual or private register entry', () => {
  const clean = read('CLEAN-ROOM.md');
  const permission = clean.split('### Permission record — 17 November 2026')[1]?.split('## 2.')[0].trim();
  assert.ok(permission === 'Optimizely gave a written go-ahead for local-development use, on file privately.', 'Permission record must use the approved anonymous sentence');
  assert.equal(/\bIP-\d+\b|private IP register|personal go-ahead/i.test(clean), false);
});

test('release and clean-room records state relocated diagnostics and a passing gate with zero findings', () => {
  for (const path of ['CLEAN-ROOM.md', 'docs/release-check.md']) {
    const text = read(path);
    assert.match(text, /relocated/i);
    assert.match(text, /passes with \*\*0 findings\*\*/);
    assert.equal(/relocation blocked|relocation is still pending|gate intentionally fails|still require removal or relocation|must not be published or recursively copied/i.test(text), false);
  }
});
