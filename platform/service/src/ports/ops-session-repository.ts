export type OpsSessionMode = "standard" | "remembered_device";

export interface OpsPersistedSession {
  id: string;
  actorId: string;
  expiresAt: Date;
  sessionMode: OpsSessionMode;
  issuedAt: Date;
  lastSeenAt: Date;
}

export interface OpsManagedSession {
  id: string;
  actorId: string;
  actorDisplayName: string;
  actorType: "staff" | "manager" | "admin";
  sessionMode: OpsSessionMode;
  status: "active" | "revoked" | "expired";
  issuedAt: Date;
  expiresAt: Date;
  lastSeenAt: Date;
  revokedAt: Date | null;
  revokeReason: string | null;
  isCurrent: boolean;
}

export interface OpsSessionMutationResult {
  outcome: string;
  revoked?: boolean;
  currentSession?: boolean;
  revokedCount?: number;
}

export interface OpsSessionCleanupResult {
  outcome: string;
  candidateCount: number;
  deletedCount: number;
  cutoffAt: Date | null;
}

export interface OpsSessionRepository {
  create(organizationKey: string, request: {
    actorId: string;
    tokenHash: string;
    sessionMode: OpsSessionMode;
    issuedAt: Date;
    expiresAt: Date;
  }): Promise<boolean>;

  findActive(organizationKey: string, tokenHash: string, now: Date): Promise<OpsPersistedSession | null>;

  revoke(organizationKey: string, tokenHash: string, reason: "logout" | "actor_inactive", now: Date): Promise<boolean>;

  list(organizationKey: string, request: {
    actorId: string;
    currentTokenHash: string;
    now: Date;
  }): Promise<OpsManagedSession[]>;

  revokeById(organizationKey: string, request: {
    actorId: string;
    sessionId: string;
    currentTokenHash: string;
    reason: string;
    idempotencyKey: string;
    correlationId: string;
    now: Date;
  }): Promise<OpsSessionMutationResult>;

  revokeOtherDevices(organizationKey: string, request: {
    actorId: string;
    currentTokenHash: string;
    reason: string;
    idempotencyKey: string;
    correlationId: string;
    now: Date;
  }): Promise<OpsSessionMutationResult>;

  cleanup(organizationKey: string, request: {
    actorId: string;
    retentionDays: number;
    apply: boolean;
    reason: string;
    idempotencyKey: string;
    correlationId: string;
    now: Date;
  }): Promise<OpsSessionCleanupResult>;
}
