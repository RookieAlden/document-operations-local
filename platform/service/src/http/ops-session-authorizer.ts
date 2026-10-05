import type { OpsIdentityRepository } from "../ports/ops-identity.js";
import type { OpsSessionRepository } from "../ports/ops-session-repository.js";
import { cookie, sessionTokenHash, verifiedSessionToken } from "./ops-session-security.js";

export interface OpsAuthorizedSession {
  sessionId: string;
  actorId: string;
  displayName: string;
  actorType: "staff" | "manager" | "admin";
  platformConsoleAccess: boolean;
  expiresAt: number;
  cookieValue: string;
  tokenHash: string;
}

export interface OpsSessionAuthorizerOptions {
  organizationKey: string;
  sessionSecret: string;
  identityRepository: OpsIdentityRepository;
  sessionRepository: OpsSessionRepository;
  now?: () => Date;
}

export class OpsSessionAuthorizer {
  private readonly now: () => Date;

  constructor(private readonly options: OpsSessionAuthorizerOptions) {
    if (options.sessionSecret.length < 32) throw new Error("DOP_OPS_SESSION_SECRET must contain at least 32 characters");
    this.now = options.now ?? (() => new Date());
  }

  async authorize(cookieHeader: string | undefined): Promise<OpsAuthorizedSession | null> {
    const value = cookie(cookieHeader, "dop_ops_session");
    const parsed = verifiedSessionToken(value, this.options.sessionSecret);
    if (!value || !parsed) return null;
    const now = this.now();
    const tokenHash = sessionTokenHash(parsed.opaqueToken);
    const persisted = await this.options.sessionRepository.findActive(
      this.options.organizationKey, tokenHash, now,
    );
    if (!persisted || persisted.expiresAt.getTime() <= now.getTime()) return null;
    const actor = await this.options.identityRepository.findActiveById(
      this.options.organizationKey, persisted.actorId,
    );
    if (!actor) {
      await this.options.sessionRepository.revoke(
        this.options.organizationKey, tokenHash, "actor_inactive", now,
      ).catch(() => undefined);
      return null;
    }
    return {
      sessionId: persisted.id,
      actorId: actor.id,
      displayName: actor.displayName,
      actorType: actor.actorType,
      platformConsoleAccess: actor.platformConsoleAccess,
      expiresAt: persisted.expiresAt.getTime(),
      cookieValue: value,
      tokenHash,
    };
  }
}
