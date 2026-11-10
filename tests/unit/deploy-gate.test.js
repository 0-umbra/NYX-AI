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

test('verification is pinned to the triggering SHA, not a branch name', () => {
  // A branch name here is a race: the checks would read whatever `develop` pointed at when the
  // checkout ran, which need not be the commit the run was raised for. `github.sha` is that
  // commit. Inside a reusable workflow the `github` context belongs to the caller, so the
  // verification job resolves it to the caller's triggering commit.
  const verifyBlock = deploy.slice(deploy.indexOf('\n  verify:'), deploy.indexOf('\n  deploy:'));
  assert.match(verifyBlock, /uses:\s*\.\/\.github\/workflows\/cloudflare-check\.yml/,
    'verify calls the shared workflow');

  const checkCheckout = check.slice(check.indexOf('actions/checkout'));
  // The expression contains a space, so match the trimmed rest of the line.
  const refMatch = /ref:[ \t]*(.+)[ \t]*\r?$/m.exec(checkCheckout);
  assert.ok(refMatch, 'the shared check workflow declares a checkout ref');
  assert.equal(refMatch[1].trim(), '${{ github.sha }}', 'must check out the triggering commit');

  // No branch-name checkout anywhere in the shared workflow: any `ref:` must be github.sha (or
  // another expression), and specifically not a literal branch.
  for (const line of check.split('\n').filter((l) => /^\s+ref:/.test(l))) {
    assert.doesNotMatch(line, /ref:\s*(develop|main|master)\s*$/,
      `branch-name checkout is a race: ${line.trim()}`);
    assert.match(line, /github\.sha/, `every checkout ref must be the triggering SHA: ${line.trim()}`);
  }
});

test('the verification and deploy jobs use the same commit SHA', () => {
  // Both resolve `github.sha` from the same run context, so the verified commit is the shipped one.
  const deployBlock = deploy.slice(deploy.indexOf('\n  deploy:'));
  assert.match(deployBlock, /ref:\s*\$\{\{\s*github\.sha\s*\}\}/, 'deploy pins the SHA');
  const checkRefs = check.split('\n').filter((l) => /^\s+ref:/.test(l));
  assert.ok(checkRefs.length > 0, 'verification declares its ref');
  for (const line of checkRefs) {
    assert.match(line, /\$\{\{\s*github\.sha\s*\}\}/, 'verification pins the same SHA expression');
  }
  // No SHA is hardcoded, which would silently pin both jobs away from the triggering commit.
  assert.doesNotMatch(deploy + check, /ref:\s*[0-9a-f]{40}\s*$/m, 'no hardcoded SHA');
});

test('the reusable workflow is called locally, so it resolves at the caller commit', () => {
  // GitHub resolves `./` and `$/` references from the caller's own commit, not the default branch,
  // so the gate works on the very first merge without a bootstrap step. An `owner/repo/...@ref`
  // form would NOT have that property -- that is why it must stay local.
  assert.match(deploy, /uses:\s*\.\/\.github\/workflows\/cloudflare-check\.yml/,
    'must use the local ./ form');
  assert.doesNotMatch(deploy, /uses:\s*[\w-]+\/[\w.-]+\/\.github\/workflows\/[^\s]+@/,
    'a cross-repo @ref form would not track the caller commit');
  // And the caller must not pin the call to a branch either.
  assert.doesNotMatch(deploy, /cloudflare-check\.yml@/, 'no @ref on the local reference');
});

test('credentials are only exposed to the deploy step', () => {
  const deployBlock = deploy.slice(deploy.indexOf('\n  deploy:'));
  assert.match(deployBlock, /CLOUDFLARE_API_TOKEN:\s*\$\{\{\s*secrets\.CLOUDFLARE_API_TOKEN\s*\}\}/);
  // The verification job must never receive deployment credentials.
  const verifyBlock = deploy.slice(deploy.indexOf('\n  verify:'), deploy.indexOf('\n  deploy:'));
  assert.doesNotMatch(verifyBlock, /secrets\./, 'verify must not be given any secret');
});
