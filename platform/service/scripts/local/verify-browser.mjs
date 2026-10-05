/** Real browser + HTTP + PostgreSQL + original bytes. No mocked APIs or classification. */
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
const service=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const root=resolve(service,'../..');
const home=resolve(process.env.DOP_LOCAL_HOME??join(root,'.local/dop'));
const config=JSON.parse(await readFile(join(home,'runtime.json'),'utf8'));
assert.equal(config.marker,'dop-local-persistence-stage1');
const origin=`http://127.0.0.1:${config.appPort}`;
const {chromium}=await import(process.env.DOP_PLAYWRIGHT_MODULE??'playwright');
const browser=await chromium.launch({headless:true,...(process.env.DOP_CHROME_PATH?{executablePath:process.env.DOP_CHROME_PATH}:{})});
const context=await browser.newContext({viewport:{width:1400,height:1050}});
const blocked=[]; const failures=[];
await context.route('**/*',route=>{
  const url=new URL(route.request().url());
  if(url.origin===origin || ['chrome-extension:','chrome:','data:','blob:','about:'].includes(url.protocol))return route.continue();
  blocked.push(url.origin);return route.abort();
});
const page=await context.newPage();page.on('pageerror',error=>failures.push(error.message));
const output=resolve(process.env.DOP_LOCAL_EVIDENCE_DIR??join(home,'verification'));
await mkdir(output,{recursive:true});
const bytes=await readFile(join(service,'test/fixtures/local-stage1-original.pdf'));
const sha=content=>createHash('sha256').update(content).digest('hex');
const report={kind:'local-stage1-browser-persistence',checkedAt:new Date().toISOString(),
  mockedApis:false,aiCalls:0,checks:[],initialization:JSON.parse(await readFile(join(home,'bootstrap-evidence.json'),'utf8')),
  originalSha256:sha(bytes)};
const pool=new pg.Pool({host:'127.0.0.1',port:config.databasePort,user:'dop_local_app',password:config.databasePassword,
  database:'dop_local_stage1',connectionTimeoutMillis:5000});
async function count() { const client=await pool.connect();try {await client.query('BEGIN READ ONLY');
  await client.query("SELECT dop_set_organization_context('dev-accounting-firm')");
  const rows=(await client.query(`SELECT id,case_id,original_filename,incoming_storage_ref,content_hash_sha256,status
    FROM documents WHERE original_filename='local-stage1-original.pdf' ORDER BY created_at`)).rows;
  await client.query('ROLLBACK');return rows;
}finally{client.release();} }
try {
  await page.goto(origin+'/workbench');
  const password=process.env.DOP_LOCAL_TEST_PASSWORD;
  assert.ok(password, 'DOP_LOCAL_TEST_PASSWORD required for browser verification only');
  await page.locator('#login-email').fill('alden');
  await page.locator('#login-password').fill(password);
  await page.getByRole('button',{name:'进入工作台',exact:true}).click();
  await page.locator('#active-case-list [data-case-id]').first().waitFor();
  const cards=page.locator('#active-case-list [data-case-id]');
  const preferred=cards.filter({hasText:'Blue Peak'});
  await (await preferred.count()?preferred.first():cards.first()).click();
  await page.locator('#local-document').waitFor();
  report.initialDocuments=(await count()).length;
  await page.screenshot({path:join(output,'01-before-upload.png'),fullPage:true});
  async function upload(buffer,name,type) {
    await page.locator('#local-document').setInputFiles({name,mimeType:type,buffer});
    const response=page.waitForResponse(r=>r.url().includes('/v1/local/cases/')&&r.request().method()==='POST');
    await page.getByRole('button',{name:'保存到本机',exact:true}).click();return await response;
  }
  const saved=await upload(bytes,'local-stage1-original.pdf','application/pdf');
  assert.ok([200,201].includes(saved.status()));
  const saveResult=await saved.json();report.documentId=saveResult.documentId;report.caseId=saveResult.caseId;
  await page.getByText('local-stage1-original.pdf',{exact:true}).waitFor();
  assert.equal((await count()).length,1);report.checks.push('browser upload -> real file + database record');
  await page.screenshot({path:join(output,'02-uploaded.png'),fullPage:true});
  const originalRow=page.locator('.row').filter({has:page.getByText('local-stage1-original.pdf',{exact:true})});
  const popupPromise=context.waitForEvent('page');
  await originalRow.getByRole('button',{name:'查看原件'}).click();
  const popup=await popupPromise;
  await popup.waitForLoadState('load');
  await popup.waitForTimeout(1200);
  const preview=await context.request.get(popup.url());assert.equal(preview.status(),200);
  assert.equal(sha(await preview.body()),sha(bytes));report.checks.push('browser opens original; downloaded bytes match input SHA-256');
  // Chrome's native PDF viewer is not consistently exposed in the page DOM.
  // Save its actual rendered screenshot for visual review; assert bytes separately.
  await popup.screenshot({path:join(output,'03-original-preview.png')});
  const unsigned=await context.request.get(origin+`/v1/local/documents/${report.documentId}/original`);
  assert.equal(unsigned.status(),403);
  const anonymous=await browser.newContext();
  assert.equal((await anonymous.request.get(popup.url())).status(),401);await anonymous.close();
  report.checks.push('original requires employee session and valid expiring preview link');
  await popup.close();
  const duplicate=await upload(bytes,'local-stage1-original.pdf','application/pdf');assert.equal(duplicate.status(),200);
  assert.equal((await duplicate.json()).outcome,'duplicate');assert.equal((await count()).length,1);
  report.checks.push('duplicate upload retains one database document');
  await page.locator('#local-document').waitFor();
  const invalid=await upload(Buffer.from('not a PDF'),'invalid.pdf','application/pdf');assert.equal(invalid.status(),422);
  assert.equal((await count()).length,1);report.checks.push('invalid PDF rejected without another document');
  await page.getByText('文件内容与扩展名不一致，请选择有效文件。').waitFor();
  await page.screenshot({path:join(output,'04-invalid-file.png'),fullPage:true});
  const session=await (await context.request.get(origin+'/v1/workbench/session')).json();
  const csrfDenied=await context.request.post(origin+`/v1/local/cases/${report.caseId}/documents`,{
    headers:{origin,'content-type':'application/pdf','x-dop-filename':'blocked.pdf'},data:bytes});assert.equal(csrfDenied.status(),403);
  const foreignOrigin=await context.request.post(origin+`/v1/local/cases/${report.caseId}/documents`,{
    headers:{origin:'https://example.invalid','content-type':'application/pdf','x-dop-filename':'blocked.pdf','x-dop-csrf':session.csrfToken},data:bytes});
  assert.equal(foreignOrigin.status(),403);report.checks.push('missing CSRF and foreign Origin rejected');
  const disallowed=await context.request.post(origin+`/v1/workbench/cases/${report.caseId}/complete`,{headers:{origin},data:{}});
  assert.equal(disallowed.status(),404);report.checks.push('workflow completion unavailable in stage one');
  report.beforeRestart=await count();
  report.beforeProcessIds={app:(await readFile(join(home,'app.pid'),'utf8')).trim(),postgres:(await readFile(join(home,'postgres/postmaster.pid'),'utf8')).split('\n')[0]};
  await pool.end();
  const run=action=>{
    const result=spawnSync(process.execPath,[join(service,'scripts/local/runtime.mjs'),action],{
      cwd:service,env:{...process.env,DOP_LOCAL_HOME:home},encoding:'utf8'});
    assert.equal(result.status,0,`${action}: ${result.stderr}`);
  };
  run('stop');
  assert.equal(spawnSync(join(config.pgBin,'pg_ctl'),['-D',join(home,'postgres'),'status']).status,3);
  let stopped=false;try{await fetch(origin+'/health',{signal:AbortSignal.timeout(1000)});}catch{stopped=true;}
  assert.equal(stopped,true);report.checks.push('application stopped; PostgreSQL stopped by lifecycle command');
  run('start');
  report.afterProcessIds={app:(await readFile(join(home,'app.pid'),'utf8')).trim(),postgres:(await readFile(join(home,'postgres/postmaster.pid'),'utf8')).split('\n')[0]};
  assert.notEqual(report.afterProcessIds.app,report.beforeProcessIds.app);
  assert.notEqual(report.afterProcessIds.postgres,report.beforeProcessIds.postgres);
  await page.reload();
  // The persisted session is reused; no fake auth and no reinsertion of records.
  await page.locator(`#active-case-list [data-case-id="${report.caseId}"]`).click();
  await page.getByText('local-stage1-original.pdf',{exact:true}).waitFor();
  const afterSession=await (await context.request.get(origin+'/v1/workbench/session')).json();
  const renewed=await context.request.post(origin+`/v1/workbench/documents/${report.documentId}/preview`,{
    headers:{origin,'x-dop-csrf':afterSession.csrfToken},data:{}});
  assert.equal(renewed.status(),200);
  const afterPreview=await context.request.get(origin+(await renewed.json()).url);
  assert.equal(afterPreview.status(),200);assert.equal(sha(await afterPreview.body()),sha(bytes));
  const afterPool=new pg.Pool({host:'127.0.0.1',port:config.databasePort,user:'dop_local_app',password:config.databasePassword,database:'dop_local_stage1'});
  const client=await afterPool.connect();try{
    await client.query('BEGIN READ ONLY');await client.query("SELECT dop_set_organization_context('dev-accounting-firm')");
    const rows=(await client.query('SELECT id,case_id,original_filename,incoming_storage_ref,content_hash_sha256,status FROM documents WHERE id=$1',[report.documentId])).rows;
    assert.deepEqual(rows,report.beforeRestart);report.afterRestart=rows;await client.query('ROLLBACK');
  }finally{client.release();await afterPool.end();}
  report.checks.push('application + PostgreSQL restart: same document ID, case, status, reference and original bytes');
  await page.screenshot({path:join(output,'05-after-restart.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.locator('[data-local-upload]').scrollIntoViewIfNeeded();
  await page.screenshot({path:join(output,'06-mobile.png')});
  report.checks.push('390px layout has no horizontal overflow');
  assert.deepEqual(blocked,[]);assert.deepEqual(failures,[]);
  report.sourceHashes={};
  for(const file of ['src/local-main.ts','src/local/file-store.ts','src/local/config.ts','public/workbench/app.js','scripts/local/runtime.mjs','scripts/local/verify-browser.mjs','src/http/ops-router.ts','src/http/workbench-router.ts'])
    report.sourceHashes[file]=sha(await readFile(join(service,file)));
  report.blockedExternalRequests=blocked;report.browserErrors=failures;report.result='passed';
  console.log(JSON.stringify({result:report.result,checks:report.checks.length,output,documentId:report.documentId}));
} finally {
  await pool.end().catch(()=>{});await browser.close();
  await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));
}
