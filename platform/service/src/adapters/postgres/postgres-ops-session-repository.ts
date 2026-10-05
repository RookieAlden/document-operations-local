import type { Pool, PoolClient } from "pg";
import type {
  OpsManagedSession,
  OpsPersistedSession,
  OpsSessionRepository,
} from "../../ports/ops-session-repository.js";

interface SessionRow {
  session_id: string;
  actor_id: string;
  expires_at: Date;
  session_mode: "standard" | "remembered_device";
  issued_at: Date;
  last_seen_at: Date;
}

interface ManagedSessionRow extends SessionRow {
  actor_display_name: string;
  actor_type: "staff" | "manager" | "admin";
  session_status: "active" | "revoked" | "expired";
  revoked_at: Date | null;
  revoke_reason: string | null;
  is_current: boolean;
}

export class PostgresOpsSessionRepository implements OpsSessionRepository {
  constructor(private readonly pool: Pool) {}

  async create(
    organizationKey: string,
    request: Parameters<OpsSessionRepository["create"]>[1],
  ): Promise<boolean> {
    return await this.transaction(organizationKey, async (client) => {
      const result = await client.query<{ created: boolean }>(
        "SELECT dop_create_ops_session($1,$2,$3,$4,$5) AS created",
        [request.actorId, request.tokenHash, request.sessionMode, request.issuedAt, request.expiresAt],
      );
      return result.rows[0]?.created === true;
    });
  }

  async findActive(organizationKey: string, tokenHash: string, now: Date): Promise<OpsPersistedSession | null> {
    return await this.transaction(organizationKey, async (client) => {
      const result = await client.query<SessionRow>(
        "SELECT session_id, actor_id, expires_at, session_mode, issued_at, last_seen_at FROM dop_validate_ops_session($1,$2)",
        [tokenHash, now],
      );
      const row = result.rows[0];
      return row ? {
        id: row.session_id, actorId: row.actor_id, expiresAt: row.expires_at,
        sessionMode: row.session_mode, issuedAt: row.issued_at, lastSeenAt: row.last_seen_at,
      } : null;
    });
  }

  async list(
    organizationKey: string,
    request: Parameters<OpsSessionRepository["list"]>[1],
  ): Promise<OpsManagedSession[]> {
    return await this.transaction(organizationKey, async (client) => {
      const result = await client.query<ManagedSessionRow>(
        `SELECT session_id, actor_id, actor_display_name, actor_type, session_mode,
                session_status, issued_at, expires_at, last_seen_at, revoked_at,
                revoke_reason, is_current
           FROM dop_list_ops_sessions($1,$2,$3)`,
        [request.actorId, request.currentTokenHash, request.now],
      );
      return result.rows.map((row) => ({
        id: row.session_id, actorId: row.actor_id, actorDisplayName: row.actor_display_name,
        actorType: row.actor_type, sessionMode: row.session_mode, status: row.session_status,
        issuedAt: row.issued_at, expiresAt: row.expires_at, lastSeenAt: row.last_seen_at,
        revokedAt: row.revoked_at, revokeReason: row.revoke_reason, isCurrent: row.is_current,
      }));
    });
  }

  async revokeById(
    organizationKey: string,
    request: Parameters<OpsSessionRepository["revokeById"]>[1],
  ) {
    return await this.transaction(organizationKey, async (client) => {
      const result = await client.query<{ outcome: string; revoked: boolean; current_session: boolean }>(
        "SELECT * FROM dop_revoke_ops_session_by_id($1,$2,$3,$4,$5,$6,$7)",
        [request.actorId, request.sessionId, request.currentTokenHash, request.reason,
          request.idempotencyKey, request.correlationId, request.now],
      );
      const row = result.rows[0];
      return { outcome: row?.outcome ?? "failed", revoked: row?.revoked ?? false, currentSession: row?.current_session ?? false };
    });
  }

  async revokeOtherDevices(
    organizationKey: string,
    request: Parameters<OpsSessionRepository["revokeOtherDevices"]>[1],
  ) {
    return await this.transaction(organizationKey, async (client) => {
      const result = await client.query<{ outcome: string; revoked_count: number }>(
        "SELECT * FROM dop_revoke_other_ops_sessions($1,$2,$3,$4,$5,$6)",
        [request.actorId, request.currentTokenHash, request.reason,
          request.idempotencyKey, request.correlationId, request.now],
      );
      const row = result.rows[0];
      return { outcome: row?.outcome ?? "failed", revokedCount: row?.revoked_count ?? 0 };
    });
  }

  async cleanup(
    organizationKey: string,
    request: Parameters<OpsSessionRepository["cleanup"]>[1],
  ) {
    return await this.transaction(organizationKey, async (client) => {
      const result = await client.query<{
        outcome: string; candidate_count: number; deleted_count: number; cutoff_at: Date | null;
      }>(
        "SELECT * FROM dop_cleanup_ops_sessions($1,$2,$3,$4,$5,$6,$7)",
        [request.actorId, request.retentionDays, request.apply, request.reason,
          request.idempotencyKey, request.correlationId, request.now],
      );
      const row = result.rows[0];
      return {
        outcome: row?.outcome ?? "failed", candidateCount: row?.candidate_count ?? 0,
        deletedCount: row?.deleted_count ?? 0, cutoffAt: row?.cutoff_at ?? null,
      };
    });
  }

  async revoke(
    organizationKey: string,
    tokenHash: string,
    reason: "logout" | "actor_inactive",
    now: Date,
  ): Promise<boolean> {
    return await this.transaction(organizationKey, async (client) => {
      const result = await client.query<{ revoked: boolean }>(
        "SELECT dop_revoke_ops_session($1,$2,$3) AS revoked",
        [tokenHash, reason, now],
      );
      return result.rows[0]?.revoked === true;
    });
  }

  private async transaction<T>(organizationKey: string, operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const organization = await client.query<{ id: string | null }>(
        "SELECT dop_set_organization_context($1) AS id", [organizationKey],
      );
      if (!organization.rows[0]?.id) throw new Error("organization_not_found");
      const value = await operation(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
