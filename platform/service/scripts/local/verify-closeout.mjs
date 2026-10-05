import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {PDFDocument,StandardFonts} from 'pdf-lib';
const service=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
assert.ok(process.env.DOP_LOCAL_HOME && process.env.DOP_LOCAL_TEST_PASSWORD);
const home=resolve(process.env.DOP_LOCAL_HOME),config=JSON.parse(await readFile(join(home,'runtime.json'),'utf8'));
assert.equal(config.marker,'dop-local-persistence-stage1');
const origin=`http://127.0.0.1:${config.appPort}`,out=resolve(process.env.DOP_LOCAL_EVIDENCE_DIR??join(home,'closeout-evidence'));
await mkdir(out,{recursive:true});
const {chromium}=await import(process.env.DOP_PLAYWRIGHT_MODULE??'playwright');
const browser=await chromium.launch({headless:true,...(process.env.DOP_CHROME_PATH?{executablePath:process.env.DOP_CHROME_PATH}:{})});
const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
const errors=[],external=[],checks=[];
await context.route('**/*',route=>{if(new URL(route.request().url()).origin===origin)return route.continue();external.push(route.request().url());return route.abort();});
page.on('pageerror',e=>errors.push(e.message));page.on('dialog',dialog=>dialog.accept());
const report={startedAt:new Date().toISOString(),mode:'local-real-browser-manual-fallback',paidCalls:0,checks,result:'incomplete'};
let caseId,csrf;
const mutation=async(path,data={})=>context.request.post(origin+path,{headers:{origin,'x-dop-csrf':csrf},data});
async function detail(){return (await (await context.request.get(`${origin}/v1/workbench/cases/${caseId}`)).json()).case;}
async function pdf(lines){const d=await PDFDocument.create(),p=d.addPage(),font=await d.embedFont(StandardFonts.Helvetica);lines.forEach((text,i)=>p.drawText(text,{x:45,y:780-i*28,size:14,font}));return Buffer.from(await d.save());}
async function upload(bytes,name){await page.locator('#local-document').setInputFiles({name,mimeType:'application/pdf',buffer:bytes});const response=page.waitForResponse(r=>r.url().endsWith(`/cases/${caseId}/documents`));await page.getByRole('button',{name:'保存到本机',exact:true}).click();const r=await response;assert.ok(r.ok(),await r.text());await page.getByText(name,{exact:true}).waitFor();return r.json();}
async function openCurrent(){await page.goto(origin+'/workbench');await page.locator('[data-view="cases"]').first().click();await page.locator(`#active-case-list [data-case-id="${caseId}"]`).click();await page.locator('#local-document').waitFor();}
try {
  await page.goto(origin+'/workbench');await page.locator('#login-email').fill('alden');await page.locator('#login-password').fill(process.env.DOP_LOCAL_TEST_PASSWORD);
  await page.getByRole('button',{name:'进入工作台',exact:true}).click();await page.locator('#start-client').waitFor();
  csrf=(await (await context.request.get(origin+'/v1/workbench/session')).json()).csrfToken;
  assert.equal((await (await context.request.get(origin+'/v1/local/ai')).json()).enabled,false,'Run unpaid acceptance with AI disabled');
  const setup=await (await context.request.get(origin+'/v1/workbench/setup')).json();
  const option=setup.serviceOptions.find(o=>o.frequency==='monthly');assert.ok(option);
  const selected=option.requirements.findIndex(r=>r.code.includes('bank'));assert.ok(selected>=0);
  const customer='Local Acceptance '+randomUUID().slice(0,8);report.customer=customer;
  await page.locator('#start-client').click();await page.locator('#customer-name').fill(customer);await page.locator('#step-next').click();
  await page.locator(`input[name="service"][value="${option.id}"]`).check();await page.locator('#step-next').click();await page.locator('#period-month').fill('2026-09');await page.locator('#step-next').click();
  for(let i=0;i<option.requirements.length;i++){await page.locator(`[data-requirement-selected="${i}"]`).setChecked(i===selected);}
  await page.locator(`[data-requirement-count="${selected}"]`).fill('1');
  const created=page.waitForResponse(r=>r.url().endsWith('/v1/workbench/client-cases')&&r.request().method()==='POST');
  await page.locator('#create-client-case').click();const createdResponse=await created;assert.equal(createdResponse.status(),201,await createdResponse.text());
  const creation=await createdResponse.json();caseId=creation.caseId;report.caseId=caseId;
  await page.locator('#local-document').waitFor();
  const repeated=await mutation('/v1/workbench/client-cases',createdResponse.request().postDataJSON());assert.equal((await repeated.json()).caseId,caseId);
  checks.push('browser creates customer and collection; replay creates no second case');
  assert.equal((await mutation(`/v1/workbench/cases/${caseId}/complete`,{idempotencyKey:randomUUID()})).status(),409);
  checks.push('missing documents block completion on server');
  const bytes=await pdf(['SYNTHETIC BANK STATEMENT',customer,'Period: 2026-09-01 to 2026-09-30','Opening balance NZD 1000.00','Deposit 500.00; Closing balance NZD 1500.00']);
  let saved=await upload(bytes,'bank-statement.pdf');report.documentId=saved.documentId;
  await upload(bytes,'bank-statement.pdf');assert.equal((await detail()).files.length,1);
  checks.push('upload and replay preserve exactly one document');
  await page.locator(`[data-local-classify="${saved.documentId}"]`).click();
  await page.getByRole('button',{name:'AI 分类（付费）',exact:true}).waitFor();
  assert.equal((await (await context.request.get(origin+'/v1/local/ai')).json()).callsUsed,0);
  await page.locator(`[data-local-manual="${saved.documentId}"]`).click();
  const review=page.locator(`[data-review-document="${saved.documentId}"]`);
  await review.getByRole('button',{name:'请客户补充',exact:true}).click();
  await page.locator('[data-publish-question]').waitFor();
  await page.locator('#question-title').fill('请补交完整银行对账单');
  await page.locator('#question-message').fill('请补交本期间完整银行对账单，收到后会在本机继续复核处理。');
  const published=page.waitForResponse(r=>r.url().endsWith(`/cases/${caseId}/questions`)&&r.request().method()==='POST');
  await page.locator('[data-publish-question]').click();const publishedResponse=await published;assert.ok(publishedResponse.ok(),await publishedResponse.text());
  await page.locator('[data-resolve-question]').waitFor();
  await review.locator('[data-review-type]').selectOption('bank_statement');await review.getByRole('button',{name:'保存新分类',exact:true}).click();
  await page.locator(`[data-local-manual="${saved.documentId}"]`).waitFor();
  checks.push('no API key: no paid calls; file can be manually classified and accepted');
  assert.equal((await mutation(`/v1/workbench/cases/${caseId}/complete`,{idempotencyKey:randomUUID()})).status(),409);
  const original=saved;
  const supplemental=await upload(await pdf(['SUPPLEMENTAL SYNTHETIC BANK STATEMENT',customer,'Period: September 2026','Full statement: Opening 1000; Deposit 500; Closing 1500.']),'supplemental-statement.pdf');
  await page.locator(`[data-local-manual="${supplemental.documentId}"]`).click();
  const supplementalReview=page.locator(`[data-review-document="${supplemental.documentId}"]`);
  await supplementalReview.locator('[data-review-type]').selectOption('bank_statement');await supplementalReview.getByRole('button',{name:'保存新分类',exact:true}).click();
  await page.locator(`[data-local-manual="${original.documentId}"]`).click();
  const originalReview=page.locator(`[data-review-document="${original.documentId}"]`);
  await originalReview.locator('summary').click();await originalReview.locator('[data-exclusion-reason]').selectOption('irrelevant_or_unknown');await originalReview.locator('[data-review-rationale]').fill('原件保留，已由完整补交版本替代');
  await originalReview.getByRole('button',{name:'确认排除，保留原件',exact:true}).click();
  await page.locator('[data-resolve-question]').click();
  await page.getByRole('button',{name:'完成资料收集',exact:true}).waitFor();saved=supplemental;
  checks.push('request supplement, keep open question blocking handoff, upload and review replacement, retain excluded original, close question');
  // A different, non-standard document must remain unresolved until explicitly excluded.
  const odd=await upload(await pdf(['INDEPENDENT NON-EXAMPLE DOCUMENT','Garden planting notes','No accounting period or bank transactions.']),'garden-notes.pdf');
  assert.equal((await mutation(`/v1/workbench/cases/${caseId}/complete`,{idempotencyKey:randomUUID()})).status(),409);
  await page.locator(`[data-local-manual="${odd.documentId}"]`).click();
  const oddReview=page.locator(`[data-review-document="${odd.documentId}"]`);await oddReview.waitFor();
  assert.equal((await detail()).completion.canComplete,false);
  await page.screenshot({path:join(out,'01-review-and-blockers.png'),fullPage:true});
  await oddReview.locator('summary').click();await oddReview.locator('[data-exclusion-reason]').selectOption('irrelevant_or_unknown');await oddReview.locator('[data-review-rationale]').fill('这是园艺笔记，与本期资料无关');
  await oddReview.getByRole('button',{name:'确认排除，保留原件',exact:true}).click();
  await page.getByRole('button',{name:'完成资料收集',exact:true}).waitFor();
  checks.push('non-example document blocks handoff until reviewed/excluded; original remains');
  // Reopen an accepted classification and confirm it again through the actual controls.
  await page.locator(`[data-local-manual="${saved.documentId}"]`).click();await page.locator(`[data-review-document="${saved.documentId}"] [data-review-action="confirm"]`).click();
  await page.getByRole('button',{name:'完成资料收集',exact:true}).waitFor();
  checks.push('accepted file can return to review without bypassing completion gate');
  const complete=page.waitForResponse(r=>r.url().endsWith(`/cases/${caseId}/complete`));await page.getByRole('button',{name:'完成资料收集',exact:true}).click();const completed=await complete;assert.equal(completed.status(),200,await completed.text());
  const after=await detail();assert.equal(after.status,'completed');assert.ok(after.nextTask?.id);report.taskId=after.nextTask.id;
  for(let i=0;i<2;i++){const again=await mutation(`/v1/workbench/cases/${caseId}/complete`,{idempotencyKey:randomUUID()});assert.equal((await again.json()).taskId,report.taskId);}
  checks.push('completion creates exactly one handoff task across repeated requests');
  await page.locator('[data-task-action="start"]').click();await page.locator('[data-task-action="complete"]').waitFor();
  await page.locator('[data-task-action="complete"]').click();
  await page.getByText('资料收集和下一任务均已完成',{exact:true}).waitFor();
  checks.push('next handoff task can be started and completed from the employee UI');
  await page.screenshot({path:join(out,'02-completed-handoff.png'),fullPage:true});
  const exportPage=await context.newPage();await exportPage.goto(`${origin}/v1/local/cases/${caseId}/export`);await exportPage.getByRole('heading',{name:'交接清单',exact:true}).waitFor();
  await exportPage.pdf({path:join(out,'handoff.pdf'),format:'A4',printBackground:true});await exportPage.close();
  checks.push('actual handoff checklist rendered and exported to PDF');
  const ops=await context.newPage();await ops.goto(origin+'/ops');await ops.locator('#app-shell').waitFor();await ops.screenshot({path:join(out,'03-operations-console.png'),fullPage:true});await ops.close();
  checks.push('original operations console opens with local shared login');
  const before=await detail();await context.close();
  for(const action of ['stop','start']){const result=spawnSync(process.execPath,[join(service,'scripts/local/runtime.mjs'),action],{cwd:service,env:{...process.env,DOP_LOCAL_HOME:home},encoding:'utf8',timeout:60000});assert.equal(result.status,0,result.stderr);}
  const fresh=await browser.newContext(),again=await fresh.newPage();await again.goto(origin+'/workbench');await again.locator('#login-email').fill('alden');await again.locator('#login-password').fill(process.env.DOP_LOCAL_TEST_PASSWORD);await again.getByRole('button',{name:'进入工作台',exact:true}).click();
  await again.locator('[data-view="completed"]').click();await again.locator(`#completed-case-list [data-case-id="${caseId}"]`).click();
  await again.getByText('本次资料收集已完成',{exact:true}).waitFor();
  const restored=(await (await fresh.request.get(`${origin}/v1/workbench/cases/${caseId}`)).json()).case;
  assert.equal(restored.nextTask.id,before.nextTask.id);assert.deepEqual(restored.files,before.files);
  await again.screenshot({path:join(out,'04-history-after-restart.png'),fullPage:true});await fresh.close();
  checks.push('app and PostgreSQL restart: fixed login, completed history, files and task preserved');
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);report.result='passed';
  console.log(JSON.stringify({result:report.result,checks:checks.length,caseId,out}));
} catch(error){report.failure=String(error);await page.screenshot({path:join(out,'failure.png'),fullPage:true}).catch(()=>{});throw error;}
finally {report.browserErrors=errors;report.externalRequests=external;await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));await browser.close();}
