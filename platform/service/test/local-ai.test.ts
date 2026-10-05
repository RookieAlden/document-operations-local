import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {it,expect,afterEach,vi} from 'vitest';
import {localAIProvider,aiStatus,saveAISettings} from '../src/local/ai.js';
import {CANDIDATE_MODEL_OUTPUT_SCHEMA_HASH} from '../src/adapters/openai/openai-classification-provider.js';
import type {ClassificationRequest} from '../src/ports/classification-provider.js';
const directories:string[]=[];
afterEach(async()=>{vi.unstubAllGlobals();await Promise.all(directories.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
async function setup(){const dir=await mkdtemp(join(tmpdir(),'dop-local-ai-'));directories.push(dir);await writeFile(join(dir,'settings.json'),JSON.stringify({login:{username:'tester',salt:'test-salt',verifier:'a'.repeat(128)},ai:{enabled:true,apiKey:'synthetic-test-key',model:'gpt-5.6-sol',budgetUsd:.5,maxCalls:1}}));return dir;}
const prompt='Classify this test document';
function request():ClassificationRequest{return {documentId:'doc_test',filename:'fictional.pdf',declaredMimeType:'application/pdf',allowedDocumentTypes:[{code:'bank_statement',displayName:'Bank statement'}],source:{kind:'text',text:'A synthetic bank statement'},execution:{model:'gpt-5.6-sol',prompt,promptInstructionHash:createHash('sha256').update(prompt).digest('hex'),responseSchemaVersion:'2.0-candidate.1',responseSchemaHash:CANDIDATE_MODEL_OUTPUT_SCHEMA_HASH,maxOutputTokens:1500,reasoningEffort:'low'}};}
it('failed token preflight never sends a generation request and consumes the reserved allowance across provider restarts',async()=>{
 const dir=await setup(),network=vi.fn(async(_url:unknown)=>new Response('{}',{status:503}));vi.stubGlobal('fetch',network);
 await expect(localAIProvider(dir).classify(request())).rejects.toThrow();
 expect(network).toHaveBeenCalledTimes(1);expect(String(network.mock.calls[0]?.[0])).toContain('/responses/input_tokens');
 expect(await aiStatus(dir)).toMatchObject({callsUsed:1,reservedUsd:.5});
 await expect(localAIProvider(dir).classify(request())).rejects.toThrow('ai_budget_exhausted');expect(network).toHaveBeenCalledTimes(1);
});
it('oversized original input is refused before any paid generation',async()=>{
 const dir=await setup(),network=vi.fn(async()=>Response.json({input_tokens:80001}));vi.stubGlobal('fetch',network);
 await expect(localAIProvider(dir).classify(request())).rejects.toThrow();expect(network).toHaveBeenCalledTimes(1);
});
it('disabled AI makes no network call, consumes no allowance, and settings updates preserve personal login without returning the key',async()=>{
 const dir=await setup(),before=JSON.parse(await readFile(join(dir,'settings.json'),'utf8'));
 const status=await saveAISettings(dir,{apiKey:'',enabled:false,budgetUsd:3,maxCalls:6});expect(JSON.stringify(status)).not.toContain('synthetic-test-key');
 expect(JSON.parse(await readFile(join(dir,'settings.json'),'utf8')).login).toEqual(before.login);
 const network=vi.fn();vi.stubGlobal('fetch',network);await expect(localAIProvider(dir).classify(request())).rejects.toThrow('ai_not_configured');
 expect(network).not.toHaveBeenCalled();expect(await aiStatus(dir)).toMatchObject({callsUsed:0,reservedUsd:0});
});
it('interrupted call lock prevents overlapping calls without discarding the lock',async()=>{
 const dir=await setup();await writeFile(join(dir,'ai-call.lock'),'');const network=vi.fn();vi.stubGlobal('fetch',network);
 await expect(localAIProvider(dir).classify(request())).rejects.toThrow('ai_busy_or_interrupted');
 expect(network).not.toHaveBeenCalled();expect(await readFile(join(dir,'ai-call.lock'),'utf8')).toBe('');
});
it('owner can explicitly raise cumulative limits without erasing consumed allowance or changing login',async()=>{
 const dir=await setup();await writeFile(join(dir,'ai-usage.json'),JSON.stringify({reservedUsd:.5,calls:[{id:'previous',documentId:'doc_test',at:'2026-10-05',outcome:'completed',actualUsd:.01}]}));
 const before=JSON.parse(await readFile(join(dir,'settings.json'),'utf8'));
 expect(await saveAISettings(dir,{apiKey:'',enabled:true,budgetUsd:4,maxCalls:8})).toMatchObject({budgetUsd:4,maxCalls:8,callsUsed:1,reservedUsd:.5});
 expect(JSON.parse(await readFile(join(dir,'settings.json'),'utf8')).login).toEqual(before.login);
 for(const budgetUsd of [NaN,Infinity,101])await expect(saveAISettings(dir,{apiKey:'',enabled:true,budgetUsd,maxCalls:8})).rejects.toThrow('invalid_ai_settings');
});
