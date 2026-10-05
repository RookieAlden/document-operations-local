import type {
  RetentionLifecycleRepository, RetentionObjectStore,
} from "../ports/retention-lifecycle-repository.js";
import type { ClassificationWorkerSnapshot } from "./classification-worker-loop.js";

export class RetentionLifecycleLoop {
  private readonly startedAt:Date;
  private status:ClassificationWorkerSnapshot["status"]="starting";
  private lastPollAt:Date|null=null;
  private lastReadyAt:Date|null=null;
  private lastErrorAt:Date|null=null;
  private lastErrorCode:string|null=null;
  private activeJobs=0;
  private completedJobs=0;
  private failedJobs=0;

  constructor(private readonly repository:RetentionLifecycleRepository,
    private readonly objectStore:RetentionObjectStore,
    private readonly options:{organizationKey:string;workerId:string;enabled:boolean;pollIntervalMs:number;
      errorBackoffMs:number;leaseSeconds:number;now?:()=>Date;sleep?:(ms:number,signal:AbortSignal)=>Promise<void>}) {
    this.startedAt=this.now();
  }
  private now(){return (this.options.now??(()=>new Date()))();}
  private async wait(ms:number,signal:AbortSignal){
    if (this.options.sleep) return this.options.sleep(ms,signal);
    if (signal.aborted) return;
    await new Promise<void>((resolve)=>{const timer=setTimeout(resolve,ms);
      signal.addEventListener("abort",()=>{clearTimeout(timer);resolve();},{once:true});});
  }

  async run(signal:AbortSignal):Promise<void> {
    this.status="running";
    try {
      while (!signal.aborted) {
        try {
          const processed=await this.runCycle(); this.lastErrorCode=null;
          if (processed===0) await this.wait(this.options.pollIntervalMs,signal);
        } catch (error) { this.markError(error); await this.wait(this.options.errorBackoffMs,signal); }
      }
    } finally { this.status="stopping"; this.status="stopped"; }
  }

  async runCycle():Promise<number> {
    this.lastPollAt=this.now();
    if (!await this.repository.checkReady(this.options.organizationKey)) throw codeError("database_not_ready");
    this.lastReadyAt=this.now();
    if (!this.options.enabled) return 0;
    const claim=await this.repository.claim(this.options.organizationKey,this.options.workerId,this.options.leaseSeconds,this.now());
    if (claim.outcome==="empty") {
      this.completedJobs+=await this.repository.finalize(this.options.organizationKey,this.now()); return 0;
    }
    this.activeJobs+=1;
    try {
      const outcome=await this.objectStore.delete(claim.storageReference);
      await this.repository.complete(claim.candidateId,claim.leaseToken,outcome,null,this.now());
      this.completedJobs+=1;
      this.completedJobs+=await this.repository.finalize(this.options.organizationKey,this.now());
      return 1;
    } catch (error) {
      const errorCode=errorCodeOf(error);
      await this.repository.complete(claim.candidateId,claim.leaseToken,"failed",errorCode,this.now());
      this.failedJobs+=1; this.markError(error); return 1;
    } finally { this.activeJobs-=1; }
  }

  snapshot():ClassificationWorkerSnapshot { return {status:this.status,startedAt:this.startedAt.toISOString(),
    lastPollAt:this.lastPollAt?.toISOString()??null,lastReadyAt:this.lastReadyAt?.toISOString()??null,
    lastErrorAt:this.lastErrorAt?.toISOString()??null,lastErrorCode:this.lastErrorCode,
    activeJobs:this.activeJobs,completedJobs:this.completedJobs,reviewJobs:0,failedJobs:this.failedJobs}; }
  private markError(error:unknown){this.lastErrorAt=this.now();this.lastErrorCode=errorCodeOf(error);}
}

function errorCodeOf(error:unknown):string { return typeof error==="object"&&error!==null&&"code" in error
  &&typeof (error as {code?:unknown}).code==="string"?(error as {code:string}).code:"retention_worker_error"; }
function codeError(code:string){return Object.assign(new Error(code),{code});}
