import { describe, expect, it } from "vitest";
import { OpsSessionAuthorizer } from "../src/http/ops-session-authorizer.js";
import { sessionTokenHash, signSessionPayload } from "../src/http/ops-session-security.js";
import type { OpsAuthorizedActor, OpsIdentityRepository } from "../src/ports/ops-identity.js";
import type {
  OpsManagedSession,
  OpsPersistedSession,
  OpsSessionCleanupResult,
  OpsSessionMutationResult,
  OpsSessionRepository,
} from "../src/ports/ops-session-repository.js";

const sessionSecret = "synthetic-session-secret-that-is-longer-than-32-characters";
const opaqueToken = "a".repeat(43);
const signedCookieValue = `v2.${opaqueToken}.${signSessionPayload(`v2.${opaqueToken}`, sessionSecret)}`;
const cookieHeader = `dop_ops_session=${signedCookieValue}`;
const now = new Date("2026-08-22T01:00:00.000Z");

class MutableIdentityRepository implements OpsIdentityRepository {
  actor: OpsAuthorizedActor | null = {
    id: "actor-1",
    displayName: "Synthetic Platform Admin",
    actorType: "admin",
    platformConsoleAccess: true,
  };

  async findActiveByExternalSubject(): Promise<OpsAuthorizedActor | null> {
    return this.actor;
  }

  async findActiveById(): Promise<OpsAuthorizedActor | null> {
    return this.actor;
  }
}

class AuthorizerSessionRepository implements OpsSessionRepository {
  readonly revocations: Array<{ tokenHash: string; reason: string }> = [];
  persisted: OpsPersistedSession | null = {
    id: "session-1",
    actorId: "actor-1",
    expiresAt: new Date("2026-08-22T02:00:00.000Z"),
    sessionMode: "standard",
    issuedAt: new Date("2026-08-22T00:00:00.000Z"),
    lastSeenAt: new Date("2026-08-22T00:00:00.000Z"),
  };

  async create(): Promise<boolean> { throw new Error("not used"); }
  async findActive(): Promise<OpsPersistedSession | null> { return this.persisted; }
  async revoke(_organizationKey: string, tokenHash: string, reason: "logout" | "actor_inactive"): Promise<boolean> {
    this.revocations.push({ tokenHash, reason });
    return true;
  }
  async list(): Promise<OpsManagedSession[]> { throw new Error("not used"); }
  async revokeById(): Promise<OpsSessionMutationResult> { throw new Error("not used"); }
  async revokeOtherDevices(): Promise<OpsSessionMutationResult> { throw new Error("not used"); }
  async cleanup(): Promise<OpsSessionCleanupResult> { throw new Error("not used"); }
}

function setup() {
  const identityRepository = new MutableIdentityRepository();
  const sessionRepository = new AuthorizerSessionRepository();
  const authorizer = new OpsSessionAuthorizer({
    organizationKey: "dev-accounting-firm",
    sessionSecret,
    identityRepository,
    sessionRepository,
    now: () => now,
  });
  return { authorizer, identityRepository, sessionRepository };
}

describe("OpsSessionAuthorizer", () => {
  it("projects the current platform capability from the actor on every request", async () => {
    const { authorizer, identityRepository } = setup();

    await expect(authorizer.authorize(cookieHeader)).resolves.toMatchObject({
      actorId: "actor-1",
      actorType: "admin",
      platformConsoleAccess: true,
      tokenHash: sessionTokenHash(opaqueToken),
    });

    identityRepository.actor = { ...identityRepository.actor!, platformConsoleAccess: false };
    await expect(authorizer.authorize(cookieHeader)).resolves.toMatchObject({
      actorId: "actor-1",
      platformConsoleAccess: false,
    });
  });

  it("invalidates and revokes an existing session when its actor is no longer active", async () => {
    const { authorizer, identityRepository, sessionRepository } = setup();
    identityRepository.actor = null;

    await expect(authorizer.authorize(cookieHeader)).resolves.toBeNull();
    expect(sessionRepository.revocations).toEqual([{
      tokenHash: sessionTokenHash(opaqueToken),
      reason: "actor_inactive",
    }]);
  });

  it("rejects an expired persisted session", async () => {
    const { authorizer, sessionRepository } = setup();
    sessionRepository.persisted = { ...sessionRepository.persisted!, expiresAt: now };

    await expect(authorizer.authorize(cookieHeader)).resolves.toBeNull();
  });
});
