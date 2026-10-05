/** Verify fixed local login against real running instances, without cloud calls. */
import assert from 'node:assert/strict';
import { readFile, access, mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const service = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const password = process.env.DOP_LOCAL_TEST_PASSWORD;
assert.ok(password, 'DOP_LOCAL_TEST_PASSWORD is required for automated verification');
assert.ok(process.env.DOP_LOCAL_HOME && process.env.DOP_LOCAL_FRESH_HOME, 'Two local test homes required');
const home = resolve(process.env.DOP_LOCAL_HOME);
const freshHome = resolve(process.env.DOP_LOCAL_FRESH_HOME);
assert.notEqual(home, freshHome);
const output = resolve(process.env.DOP_LOCAL_EVIDENCE_DIR ?? join(home, 'login-verification'));
await mkdir(output, { recursive: true });
const report = { checkedAt: new Date().toISOString(), checks: [], result: 'incomplete' };
const { chromium } = await import(process.env.DOP_PLAYWRIGHT_MODULE ?? 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.DOP_CHROME_PATH ? { executablePath: process.env.DOP_CHROME_PATH } : {}) });
const errors = []; const external = [];
async function setup(directory) {
  const config = JSON.parse(await readFile(join(directory, 'runtime.json'), 'utf8'));
  assert.equal(config.marker, 'dop-local-persistence-stage1');
  for (const key of ['loginEmail', 'passwordSalt', 'passwordHash']) assert.equal(key in config, false);
  await assert.rejects(access(join(directory, 'login.txt')), { code: 'ENOENT' });
  const origin = `http://127.0.0.1:${config.appPort}`;
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    external.push(route.request().url()); return route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/workbench');
  return { page, context };
}
async function login(page, suppliedPassword = password) {
  await page.locator('#login-email').fill('alden');
  await page.locator('#login-password').fill(suppliedPassword);
  const response = page.waitForResponse(r => r.url().endsWith('/v1/ops/session') && r.request().method() === 'POST');
  await page.getByRole('button', { name: '进入工作台', exact: true }).click();
  return await response;
}
async function accepted(page) {
  assert.equal((await login(page)).status(), 200);
  await page.locator('[data-view="cases"]').first().click();
  await page.locator('#active-case-list [data-case-id]').first().waitFor();
}
const run = action => {
  const result = spawnSync(process.execPath, [join(service, 'scripts/local/runtime.mjs'), action], {
    cwd: service, env: { ...process.env, DOP_LOCAL_HOME: home }, encoding: 'utf8', timeout: 60000,
  });
  assert.equal(result.status, 0, `${action}: ${result.stderr}`);
};
try {
  const { page, context } = await setup(home);
  assert.equal(await page.locator('#login-email').getAttribute('type'), 'text');
  assert.equal(await page.locator('#login-email').getAttribute('name'), 'username');
  assert.equal(await page.locator('#login-email').getAttribute('autocomplete'), 'username');
  assert.equal(await page.locator('#login-password').getAttribute('autocomplete'), 'current-password');
  assert.equal(await page.locator('#login-form').getAttribute('autocomplete'), 'on');
  assert.equal((await login(page, 'incorrect-local-password')).status(), 401);
  await page.getByText('账号或密码不正确。', { exact: true }).waitFor();
  report.checks.push('wrong password rejected; standard username/current-password form attributes');
  await accepted(page);
  assert.equal(await page.evaluate(() => localStorage.getItem('dop.local.username')), 'alden');
  assert.equal(await page.evaluate(secret => Object.values(localStorage).some(value => value.includes(secret)), password), false);
  report.checks.push('existing instance accepts fixed credentials; stores username only');
  await page.locator('#logout-button').click();
  await page.locator('#login-password').waitFor();
  assert.equal(await page.locator('#login-password').inputValue(), '');
  await page.reload();
  await page.locator('#login-email').waitFor();
  assert.equal(await page.locator('#login-email').inputValue(), 'alden');
  await page.screenshot({ path: join(output, 'login.png'), fullPage: true });
  report.checks.push('logout clears password; reload remembers account');
  await page.locator('#login-remember').uncheck();
  await accepted(page);
  assert.equal(await page.evaluate(() => localStorage.getItem('dop.local.username')), null);
  await page.locator('#logout-button').click();
  await page.locator('#login-email').waitFor();
  assert.equal(await page.locator('#login-email').inputValue(), '');
  report.checks.push('unchecking remember account removes saved username');
  await context.close();
  run('stop'); run('start');
  const restarted = await setup(home);
  await accepted(restarted.page);
  await restarted.page.locator('#active-case-list [data-case-id]').filter({ hasText: 'Blue Peak' }).first().click();
  await restarted.page.getByText('local-stage1-original.pdf', { exact: true }).waitFor();
  report.checks.push('rebuild and app/database restart: fresh login succeeds and previous uploaded record remains');
  await restarted.context.close();
  const fresh = await setup(freshHome);
  const initialization = JSON.parse(await readFile(join(freshHome, 'bootstrap-evidence.json'), 'utf8'));
  report.freshInitialization = initialization;
  await accepted(fresh.page);
  report.checks.push('fresh separate local database accepts same fixed credentials; no login file needed');
  await fresh.context.close();
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  report.browserErrors = errors; report.externalRequests = external; report.result = 'passed';
  console.log(JSON.stringify({ result: report.result, checks: report.checks.length, output }));
} finally {
  await browser.close();
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
}
