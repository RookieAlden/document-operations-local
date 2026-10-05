/** Explicitly approved paid integration verification. No retry and no model substitution. */
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile,access} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
assert.equal(process.env.DOP_AI_APPROVAL,'gpt-5.6-sol:6:3','Requires explicit approval of model, calls and USD budget');
assert.ok(process.env.DOP_LOCAL_HOME && process.env.DOP_LOCAL_TEST_PASSWORD && process.env.DOP_AI_SAMPLES);
const home=resolve(process.env.DOP_LOCAL_HOME),config=JSON.parse(await readFile(join(home,'runtime.json'),'utf8'));
assert.equal(config.marker,'dop-local-persistence-stage1');
const origin=`http://127.0.0.1:${config.appPort}`,samples=resolve(process.env.DOP_AI_SAMPLES),out=join(home,'ai-closeout-evidence');
await mkdir(out,{recursive:true});
const reportPath=join(out,'report.json');
try {await access(reportPath);throw Error('Existing report: refusing automatic rerun; inspect previous calls first');}catch(e){if(e.code!=='ENOENT')throw e;}
const manifest=JSON.parse(await readFile(join(samples,'manifest.json'),'utf8'));assert.equal(manifest.fictional,true);assert.equal(manifest.files.length,6);
for(const item of manifest.files)assert.equal(createHash('sha256').update(await readFile(join(samples,item.file))).digest('hex'),item.sha256);
const report={startedAt:new Date().toISOString(),mode:'real-local-browser-real-openai',approved:{model:'gpt-5.6-sol',maxGenerationRequests:6,budgetUsd:3,automaticRetries:false},caseId:null,casePeriod:{start:'2026-07-01',end:'2026-09-30'},files:[],checks:[],result:'incomplete'};
const save=()=>writeFile(reportPath,JSON.stringify(report,null,2),{mode:0o600});
const {chromium}=await import(process.env.DOP_PLAYWRIGHT_MODULE??'playwright');
const browser=await chromium.launch({headless:true,...(process.env.DOP_CHROME_PATH?{executablePath:process.env.DOP_CHROME_PATH}:{})});
const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
page.setDefaultTimeout(15000);page.on('dialog',d=>d.accept());
let csrf;
const post=(path,data={})=>context.request.post(origin+path,{headers:{origin,'x-dop-csrf':csrf},data,timeout:90000});
const detail=async()=> (await (await context.request.get(origin+`/v1/workbench/cases/${report.caseId}`)).json()).case;
try {
 await page.goto(origin+'/workbench');await page.locator('#login-email').fill('alden');await page.locator('#login-password').fill(process.env.DOP_LOCAL_TEST_PASSWORD);await page.getByRole('button',{name:'进入工作台',exact:true}).click();await page.locator('#start-client').waitFor();
 csrf=(await (await context.request.get(origin+'/v1/workbench/session')).json()).csrfToken;
 const settings=await (await context.request.get(origin+'/v1/local/ai')).json();assert.equal(settings.keyConfigured,true);assert.equal(settings.model,report.approved.model);assert.equal(settings.callsUsed,0);assert.equal(settings.reservedUsd,0);
 const enabled=await post('/v1/local/ai',{apiKey:'',enabled:true,budgetUsd:3,maxCalls:6});assert.equal(enabled.status(),200);report.initialAI=await enabled.json();
 const setup=await (await context.request.get(origin+'/v1/workbench/setup')).json();const types=['bank_statement','invoice','expense_receipt'];
 const option=setup.serviceOptions.find(o=>o.frequency==='quarterly'&&types.every(t=>o.requirements.some(r=>r.code===t||r.code.startsWith(t+'.'))));
 assert.ok(option,'Quarterly service must offer bank, invoice and receipt');
 if(process.env.DOP_AI_RESUME_CASE){report.caseId=process.env.DOP_AI_RESUME_CASE;await page.locator('[data-view="cases"]').first().click();await page.locator(`#active-case-list [data-case-id="${report.caseId}"]`).click();await page.locator('#local-document').waitFor();await save();} else {
 await page.locator('#start-client').click();await page.locator('#customer-name').fill(manifest.client);await page.locator('#step-next').click();await page.locator(`input[name="service"][value="${option.id}"]`).check();await page.locator('#step-next').click();await page.locator('#period-year').fill('2026');await page.locator('input[name="quarter"][value="3"]').check();await page.locator('#step-next').click();
 for(let i=0;i<option.requirements.length;i++){const selected=types.some(t=>option.requirements[i].code===t||option.requirements[i].code.startsWith(t+'.'));await page.locator(`[data-requirement-selected="${i}"]`).setChecked(selected);if(selected)await page.locator(`[data-requirement-count="${i}"]`).fill('1');}
 const creation=page.waitForResponse(r=>r.url().endsWith('/v1/workbench/client-cases')&&r.request().method()==='POST');await page.locator('#create-client-case').click();const created=await creation;if(created.status()!==201)throw Error("Creation HTTP "+created.status()+": "+await created.text());report.caseId=(await created.json()).caseId;await page.locator('#local-document').waitFor();await save();
 }
 for(const sample of manifest.files){
  await page.locator('#local-document').setInputFiles(join(samples,sample.file));const saved=page.waitForResponse(r=>r.url().endsWith(`/cases/${report.caseId}/documents`)&&r.request().method()==='POST');await page.getByRole('button',{name:'保存到本机',exact:true}).click();const uploaded=await saved;if(!uploaded.ok())throw Error('Upload HTTP '+uploaded.status());await page.getByText(sample.file,{exact:true}).waitFor();const documentId=(await detail()).files.find(f=>f.filename===sample.file)?.id;assert.ok(documentId);
  const record={...sample,documentId,classification:null};report.files.push(record);await save();
  const classified=page.waitForResponse(r=>r.url().endsWith(`/documents/${documentId}/classify`),{timeout:90000});await page.locator(`[data-local-classify="${documentId}"]`).click();const response=await classified;
  record.httpStatus=response.status();record.afterAI=(await detail()).files.find(f=>f.id===documentId);record.classification=await response.json().catch(()=>({outcome:({automatically_accepted:'accepted',awaiting_human_review:'review_required',processing_failed:'failed_recoverable'})[record.afterAI.status]??'unknown',source:'persisted_readback',documentTypeCode:record.afterAI.documentTypeCode}));report.aiStatus=await (await context.request.get(origin+'/v1/local/ai')).json();await save();
  console.log(JSON.stringify({file:sample.file,result:record.classification,usage:report.aiStatus}));
  assert.ok(response.ok());assert.ok(['accepted','review_required'].includes(record.classification.outcome),'Stop on API failure; never automatically retry');
  await page.screenshot({path:join(out,`${report.files.length}-after-ai.png`),fullPage:true});
 }
 report.checks.push('Six real original-file classifications returned and were persisted');
 const wrong=report.files.find(f=>f.category==='wrong_period'),unknown=report.files.find(f=>f.category==='unknown');
 assert.equal(wrong.afterAI.status,'awaiting_human_review');assert.ok(wrong.afterAI.reviewExplanation.some(s=>s.includes('期间')));
 assert.equal(unknown.afterAI.status,'awaiting_human_review');assert.equal(unknown.afterAI.documentTypeCode,null);
 assert.equal((await post(`/v1/workbench/cases/${report.caseId}/complete`,{idempotencyKey:randomUUID()})).status(),409);
 report.checks.push('Wrong period and unknown file require review and block completion');
 for(const record of report.files){
  const current=(await detail()).files.find(f=>f.id===record.documentId);
  const reviewSaved=page.waitForResponse(r=>r.url().endsWith(`/v1/workbench/reviews/${record.documentId}`)&&r.request().method()==='POST');
  if(['wrong_period','unknown'].includes(record.category)){
   const card=page.locator(`[data-review-document="${record.documentId}"]`);await card.locator('summary').click();await card.locator('[data-exclusion-reason]').selectOption(record.category==='wrong_period'?'wrong_period':'irrelevant_or_unknown');await card.locator('[data-review-rationale]').fill(record.category==='wrong_period'?'原件日期为2025年8月，不属于2026年第三季度本期，保留原件并排除':'园艺笔记不属于会计资料，保留原件并排除');
   await card.getByRole('button',{name:'确认排除，保留原件',exact:true}).click();
  } else {
   if(current.status!=='awaiting_human_review')await page.locator(`[data-local-manual="${record.documentId}"]`).click();
   const card=page.locator(`[data-review-document="${record.documentId}"]`);await card.locator('[data-review-type]').selectOption(record.expectedType);await card.getByRole('button',{name:'保存新分类',exact:true}).click();
  }
  assert.equal((await reviewSaved).status(),200);report.afterReview=await detail();await save();
 }
 await page.getByRole('button',{name:'完成资料收集',exact:true}).waitFor();
 const done=page.waitForResponse(r=>r.url().endsWith(`/cases/${report.caseId}/complete`));await page.getByRole('button',{name:'完成资料收集',exact:true}).click();assert.equal((await done).status(),200);report.finalCase=await detail();assert.equal(report.finalCase.status,'completed');
 const repeated=await post(`/v1/workbench/cases/${report.caseId}/complete`,{idempotencyKey:randomUUID()});assert.equal((await repeated.json()).taskId,report.finalCase.nextTask.id);
 report.checks.push('Human review resolves exceptions; handoff completion is idempotent');
 await page.screenshot({path:join(out,'7-completed.png'),fullPage:true});
 await page.goto(origin+`/v1/local/cases/${report.caseId}/export`);await page.getByRole('heading',{name:'交接清单',exact:true}).waitFor();await page.screenshot({path:join(out,'8-handoff-export.png'),fullPage:true});
 report.result='passed';report.finishedAt=new Date().toISOString();
} catch(error){report.failure=String(error);console.error(String(error));await page.screenshot({path:join(out,'failure.png'),fullPage:true}).catch(()=>{});process.exitCode=1;}
finally {await save();await browser.close();console.log(JSON.stringify({result:report.result,caseId:report.caseId,reportPath}));}
