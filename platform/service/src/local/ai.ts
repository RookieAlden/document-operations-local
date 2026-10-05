import { open, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { ClassifyDocument } from "../application/classify-document.js";
import { PostgresClassificationWorkRepository } from "../adapters/postgres/postgres-classification-work-repository.js";
import { OpenAIClassificationProvider } from "../adapters/openai/openai-classification-provider.js";
import { loadPersonalSettings, LOCAL_AI_MODEL } from "./settings.js";
import type { ClassificationProvider } from "../ports/classification-provider.js";
import type { LocalFileStore } from "./file-store.js";
import { LOCAL_ORGANIZATION } from "./config.js";

interface Ledger { reservedUsd: number; calls: Array<{id:string; documentId:string; at:string; outcome:string; inputTokens?:number|null; outputTokens?:number|null; actualUsd?:number}> }
async function ledger(directory:string):Promise<Ledger> {
  try { const value=JSON.parse(await readFile(join(directory,"ai-usage.json"),"utf8")) as Ledger;
    if (!Array.isArray(value.calls) || !Number.isFinite(value.reservedUsd) || value.reservedUsd<0) throw Error("invalid_usage_ledger");
    return value;
  } catch(error) { if((error as NodeJS.ErrnoException).code==="ENOENT")return {reservedUsd:0,calls:[]}; throw error; }
}
async function atomic(directory:string,name:string,value:unknown) {
  const temporary=join(directory,`.${name}-${randomUUID()}`);
  await writeFile(temporary,JSON.stringify(value,null,2),{mode:0o600,flag:"wx"});
  const handle=await open(temporary,"r");try{await handle.sync();}finally{await handle.close();}
  await rename(temporary,join(directory,name));
}
export async function aiStatus(directory:string) {
  const settings=await loadPersonalSettings(directory), usage=await ledger(directory);
  return {enabled:settings.ai.enabled,keyConfigured:!!settings.ai.apiKey,model:settings.ai.model,
    budgetUsd:settings.ai.budgetUsd,maxCalls:settings.ai.maxCalls,callsUsed:usage.calls.length,reservedUsd:usage.reservedUsd,
    estimatedKnownUsd:usage.calls.reduce((sum,c)=>sum+(c.actualUsd??0),0)};
}
export async function saveAISettings(directory:string,request:Record<string,unknown>) {
  const settings=await loadPersonalSettings(directory);
  if(typeof request.apiKey!=="string" || request.apiKey.length>500 || typeof request.enabled!=="boolean"
    || typeof request.budgetUsd!=="number" || !Number.isFinite(request.budgetUsd) || request.budgetUsd<0 || request.budgetUsd>100
    || !Number.isInteger(request.maxCalls) || Number(request.maxCalls)<0 || Number(request.maxCalls)>200)
    throw Error("invalid_ai_settings");
  settings.ai={...settings.ai,apiKey:request.apiKey.trim()||settings.ai.apiKey,enabled:request.enabled,
    budgetUsd:request.budgetUsd,maxCalls:Number(request.maxCalls)};
  await atomic(directory,"settings.json",settings);
  return aiStatus(directory);
}

/** User-triggered calls only; no daemon, polling or automatic retry. */
export function localClassifier(pool:Pool,store:LocalFileStore,directory:string) {
  const repository=new PostgresClassificationWorkRepository(pool);
  return new ClassifyDocument(repository,{
    resolve:async request=>{
      const bytes=await store.read(request.storageReference);
      if(request.declaredMimeType.startsWith("image/"))return {kind:"image_url",imageUrl:`data:${request.declaredMimeType};base64,${bytes.toString("base64")}`,detail:"high"};
      return {kind:"file_data",filename:request.filename,mimeType:request.declaredMimeType,base64:bytes.toString("base64")};
    },
  }, localAIProvider(directory), {organizationKey:LOCAL_ORGANIZATION,environment:"DEV",providerModel:LOCAL_AI_MODEL,prompt:"Local pinned release",
    allowCandidateAbstention:true,automaticRetries:false});
}

export function localAIProvider(directory:string): ClassificationProvider {
  return {classify:async request=>{
    if(request.execution?.model!==LOCAL_AI_MODEL || request.execution.maxOutputTokens>1500) throw Error("unapproved_local_model");
    // A shared personal ledger survives demo resets and spans all local databases.
    const lockPath=join(directory,"ai-call.lock");
    const lock=await open(lockPath,"wx",0o600).catch(()=>{throw Error("ai_busy_or_interrupted_use_manual");});
    try {
      const settings=await loadPersonalSettings(directory), usage=await ledger(directory);
      if(!settings.ai.enabled||!settings.ai.apiKey)throw Error("ai_not_configured_use_manual");
      if(usage.calls.length>=settings.ai.maxCalls || usage.reservedUsd+0.5>settings.ai.budgetUsd)throw Error("ai_budget_exhausted_use_manual");
      const call:Ledger["calls"][number]={id:randomUUID(),documentId:request.documentId,at:new Date().toISOString(),outcome:"reserved_or_interrupted"};
      usage.calls.push(call);usage.reservedUsd=Number((usage.reservedUsd+0.5).toFixed(2));
      // Reserve the worst-case allowance BEFORE any network call; never refund unknown outcomes.
      await atomic(directory,"ai-usage.json",usage);
      try {
        const provider=new OpenAIClassificationProvider({apiKey:settings.ai.apiKey,model:LOCAL_AI_MODEL,
          prompt:request.execution.prompt,timeoutMs:60000,
          fetch:async (url,options)=>{
            const payload=JSON.parse(String(options?.body));
            // Count the actual PDF/image input before generation. A failed count never proceeds.
            const count=await fetch("https://api.openai.com/v1/responses/input_tokens",{
              method:"POST",headers:options?.headers as Record<string,string>,signal:options?.signal ?? null,
              body:JSON.stringify({model:payload.model,input:payload.input,instructions:payload.instructions,text:payload.text}),
            });
            if(!count.ok)throw Error("input_count_unavailable");
            const counted=await count.json() as {input_tokens?:number};
            if(!Number.isInteger(counted.input_tokens)||counted.input_tokens!<0||counted.input_tokens!>80000)throw Error("input_exceeds_local_budget");
            // 80k input at $4/M (even allowing 1.25x cache-write price), 1500 output at $20/M < $0.50.
            return fetch(url,{...options,body:JSON.stringify({...payload,service_tier:"default"})});
          }});
        const result=await provider.classify(request);
        call.outcome="completed";call.inputTokens=result.audit.inputTokens;call.outputTokens=result.audit.outputTokens;
        if(call.inputTokens!==null&&call.outputTokens!==null)call.actualUsd=call.inputTokens*4/1e6+call.outputTokens*20/1e6;
        await atomic(directory,"ai-usage.json",usage);return result;
      } catch(error) { call.outcome="failed_or_unknown";await atomic(directory,"ai-usage.json",usage);throw error; }
    } finally { await lock.close();await unlink(lockPath); }
  }};
}
