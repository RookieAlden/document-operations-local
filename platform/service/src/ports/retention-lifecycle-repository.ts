export type RetentionObjectClaim = {
  outcome: "claimed";
  candidateId: string;
  retentionRunId: string;
  caseId: string;
  storageReference: string;
  storageReferenceHash: string;
  leaseToken: string;
  attemptCount: number;
};

export interface RetentionLifecycleRepository {
  checkReady(organizationKey: string): Promise<boolean>;
  claim(organizationKey: string, workerId: string, leaseSeconds: number, now: Date): Promise<RetentionObjectClaim | { outcome: "empty" }>;
  complete(candidateId: string, leaseToken: string, outcome: "deleted" | "not_found" | "failed", errorCode: string | null, now: Date): Promise<void>;
  finalize(organizationKey: string, now: Date): Promise<number>;
}

export interface RetentionObjectStore {
  delete(storageReference: string): Promise<"deleted" | "not_found">;
}
