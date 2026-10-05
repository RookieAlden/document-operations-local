import { describe,expect,it,vi } from "vitest";
import type { RetentionLifecycleRepository,RetentionObjectStore } from "../src/ports/retention-lifecycle-repository.js";
import { RetentionLifecycleLoop } from "../src/runtime/retention-lifecycle-loop.js";

const claim={outcome:"claimed" as const,candidateId:"candidate-1",retentionRunId:"run-1",caseId:"case-1",
  storageReference:"supabase://bucket/org/document/file.pdf",storageReferenceHash:"a".repeat(64),
  leaseToken:"lease-1",attemptCount:1};
function repository():RetentionLifecycleRepository{return {checkReady:vi.fn(async()=>true),
  claim:vi.fn(async()=>claim),complete:vi.fn(async()=>undefined),finalize:vi.fn(async()=>1)};}
function store(outcome:"deleted"|"not_found"="deleted"):RetentionObjectStore{return {delete:vi.fn(async()=>outcome)};}

describe("RetentionLifecycleLoop",()=>{
  it("deletes one claimed object and finalizes database redaction only afterwards",async()=>{
    const repo=repository();const objects=store();const now=()=>new Date("2026-08-17T01:00:00.000Z");
    const loop=new RetentionLifecycleLoop(repo,objects,{organizationKey:"uat-accounting-firm",workerId:"preserve:retention",
      enabled:true,pollIntervalMs:60_000,errorBackoffMs:1_000,leaseSeconds:120,now});
    await expect(loop.runCycle()).resolves.toBe(1);
    expect(objects.delete).toHaveBeenCalledWith(claim.storageReference);
    expect(repo.complete).toHaveBeenCalledWith(claim.candidateId,claim.leaseToken,"deleted",null,now());
    expect(vi.mocked(repo.complete).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(repo.finalize).mock.invocationCallOrder[0]??0);
    expect(loop.snapshot()).toMatchObject({completedJobs:2,failedJobs:0,lastReadyAt:now().toISOString()});
  });

  it("treats a missing object as a successful terminal result",async()=>{
    const repo=repository();const loop=new RetentionLifecycleLoop(repo,store("not_found"),{
      organizationKey:"uat-accounting-firm",workerId:"preserve:retention",enabled:true,
      pollIntervalMs:60_000,errorBackoffMs:1_000,leaseSeconds:120});
    await loop.runCycle();
    expect(repo.complete).toHaveBeenCalledWith(claim.candidateId,claim.leaseToken,"not_found",null,expect.any(Date));
  });

  it("records a recoverable failure and does not finalize a partially deleted case",async()=>{
    const repo=repository();const objects:RetentionObjectStore={delete:vi.fn(async()=>{throw Object.assign(new Error("failed"),{code:"storage_delete_failed"});})};
    const loop=new RetentionLifecycleLoop(repo,objects,{organizationKey:"uat-accounting-firm",workerId:"preserve:retention",
      enabled:true,pollIntervalMs:60_000,errorBackoffMs:1_000,leaseSeconds:120});
    await expect(loop.runCycle()).resolves.toBe(1);
    expect(repo.complete).toHaveBeenCalledWith(claim.candidateId,claim.leaseToken,"failed","storage_delete_failed",expect.any(Date));
    expect(repo.finalize).not.toHaveBeenCalled();
    expect(loop.snapshot().failedJobs).toBe(1);
  });

  it("keeps execution disabled while still proving database readiness",async()=>{
    const repo=repository();const objects=store();const loop=new RetentionLifecycleLoop(repo,objects,{
      organizationKey:"uat-accounting-firm",workerId:"preserve:retention",enabled:false,
      pollIntervalMs:60_000,errorBackoffMs:1_000,leaseSeconds:120});
    await expect(loop.runCycle()).resolves.toBe(0);
    expect(repo.checkReady).toHaveBeenCalled();expect(repo.claim).not.toHaveBeenCalled();expect(objects.delete).not.toHaveBeenCalled();
  });
});
