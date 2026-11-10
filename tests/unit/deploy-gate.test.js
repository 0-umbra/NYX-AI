/**
 * Deployment safety regression tests.
 *
 * The deploy workflow used to trigger on a push to `develop` and run `wrangler deploy` with no
 * test step in its own job graph — CI ran separately and could never block it. These tests pin the
 * gate in place so a future edit cannot quietly remove it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const deploy = read('.github/workflows/cloudflare-deploy.yml');
const check = read('.github/workflows/cloudflare-check.yml');

test('the deploy job cannot run until the verification job succeeds', () => {
  assert.match(deploy, /^\s{2}deploy:\s*$/m, 'deploy job exists');
  assert.match(deploy, /^\s{2}verify:\s*$/m, 'verify job exists');
  // `needs:` directly under the deploy job, whatever the indentation style.
  const deployBlock = deploy.slice(deploy.indexOf('\n  deploy:'));
  assert.match(deployBlock, /^\s{4}needs:\s*verify\s*$/m, 'deploy must declare needs: verify');
});

test('verification reuses the existing check workflow rather than duplicating it', () => {
  // Reuse means the gate cannot drift from the checks developers actually run.
  const verifyBlock = deploy.slice(deploy.indexOf('\n  verify:'), deploy.indexOf('\n  deploy:'));
  assert.match(verifyBlock, /^\s{4}uses:\s*\.\/\.github\/workflows\/cloudflare-check\.yml\s*$/m,
    'verify must call the shared check workflow');
});

test('the shared check workflow is callable and still runs on develop pushes', () => {
  assert.match(check, /^\s{2}workflow_call:\s*$/m, 'must declare workflow_call to be reusable');
  assert.match(check, /^\s{2}push:\s*$/m, 'must keep running on push, as before');
  assert.match(check, /branches:\s*\[develop\]/, 'still scoped to develop');
});

test('the gate actually runs frontend tests, build and backend tests', () => {
  // Without these, `needs: verify` would gate on nothing meaningful.
  assert.match(check, /run:\s*npm test/, 'frontend tests');
  assert.match(check, /run:\s*npm run build/, 'frontend build');
  assert.match(check, /Run backend tests[\s\S]{0,120}npm test/, 'backend tests');
  assert.match(check, /wrangler deploy --dry-run/, 'worker compile check');
});

test('deployment happens only in the gated job, and only from a verified commit', () => {
  // Only `run:` lines count; the file's own explanatory comments mention the command too.
  const occurrences = deploy.split('\n')
    .filter((line) => /^\s*run:/.test(line))
    .filter((line) => /wrangler deploy/.test(line) && !/--dry-run/.test(line));
  assert.equal(occurrences.length, 1, 'exactly one real deploy command');
  const deployBlock = deploy.slice(deploy.indexOf('\n  deploy:'));
  assert.ok(deployBlock.includes('wrangler deploy'), 'the deploy command lives in the deploy job');
  assert.match(deployBlock, /ref:\s*\$\{\{\s*github\.sha\s*\}\}/,
    'must check out the commit that was verified, not a moving branch tip');
});

test('credentials are only exposed to the deploy step', () => {
  const deployBlock = deploy.slice(deploy.indexOf('\n  deploy:'));
  assert.match(deployBlock, /CLOUDFLARE_API_TOKEN:\s*\$\{\{\s*secrets\.CLOUDFLARE_API_TOKEN\s*\}\}/);
  // The verification job must never receive deployment credentials.
  const verifyBlock = deploy.slice(deploy.indexOf('\n  verify:'), deploy.indexOf('\n  deploy:'));
  assert.doesNotMatch(verifyBlock, /secrets\./, 'verify must not be given any secret');
});
