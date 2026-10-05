import type { Pool, PoolClient } from "pg";
import type { OpsAccessRepository, OpsAccessRole, OpsAccessSnapshot, OpsAccessMutationResult } from "../../ports/ops-access-repository.js";

export class PostgresOpsAccessRepository implements OpsAccessRepository {
  constructor(private readonly pool: Pool) {}

  async getAccess(organizationKey: string, actorId: string, now: Date): Promise<OpsAccessSnapshot> {
    return await this.transaction(organizationKey, async (client) => {
      await requireAdmin(client, actorId);
      const members = await client.query<{ id: string; display_name: string; email: string | null; actor_type: OpsAccessRole; status: "active" | "inactive"; external_subject_id: string; created_at: Date | string; updated_at: Date | string }>(
        `SELECT id, display_name, email, actor_type, status, external_subject_id, created_at, updated_at
           FROM actors WHERE actor_type IN ('staff','manager','admin')
          ORDER BY status, CASE actor_type WHEN 'admin' THEN 1 WHEN 'manager' THEN 2 ELSE 3 END, lower(display_name)`,
      );
      const invitations = await client.query<{ id: string; email: string; display_name: string; actor_type: OpsAccessRole; status: "draft" | "cancelled" | "provisioned"; reason: string; created_by_name: string; created_at: Date | string; cancelled_at: Date | string | null }>(
        `SELECT invitation.id, invitation.email, invitation.display_name, invitation.actor_type,
                invitation.status, invitation.reason, creator.display_name AS created_by_name,
                invitation.created_at, invitation.cancelled_at
           FROM identity_invitation_drafts invitation
           JOIN actors creator ON creator.id = invitation.created_by_actor_id
          ORDER BY invitation.created_at DESC LIMIT 100`,
      );
      return {
        generatedAt: now.toISOString(),
        members: members.rows.map((row) => ({ id: row.id, displayName: row.display_name, email: row.email,
          actorType: row.actor_type, status: row.status, externalIdentityLinked: row.external_subject_id.startsWith("supabase-auth:"),
          createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) })),
        invitations: invitations.rows.map((row) => ({ id: row.id, email: row.email, displayName: row.display_name,
          actorType: row.actor_type, status: row.status, reason: row.reason, createdByName: row.created_by_name,
          createdAt: iso(row.created_at), cancelledAt: row.cancelled_at ? iso(row.cancelled_at) : null })),
      };
    });
  }

  async createInvitation(organizationKey: string, request: Parameters<OpsAccessRepository["createInvitation"]>[1]) {
    return await this.call(organizationKey,
      "SELECT dop_create_identity_invitation_draft($1,$2,$3,$4,$5,$6,$7,$8) AS result",
      [request.actorId, request.email, request.displayName, request.actorType, request.reason, request.idempotencyKey, request.correlationId, request.now]);
  }
  async cancelInvitation(organizationKey: string, request: Parameters<OpsAccessRepository["cancelInvitation"]>[1]) {
    return await this.call(organizationKey,
      "SELECT dop_cancel_identity_invitation_draft($1,$2,$3,$4,$5,$6) AS result",
      [request.actorId, request.invitationId, request.reason, request.idempotencyKey, request.correlationId, request.now]);
  }
  async changeActorAccess(organizationKey: string, request: Parameters<OpsAccessRepository["changeActorAccess"]>[1]) {
    return await this.call(organizationKey,
      "SELECT dop_change_actor_access($1,$2,$3,$4,$5,$6,$7,$8) AS result",
      [request.actorId, request.targetActorId, request.action, request.actorType ?? null, request.reason, request.idempotencyKey, request.correlationId, request.now]);
  }

  private async call(organizationKey: string, sql: string, values: unknown[]): Promise<OpsAccessMutationResult> {
    return await this.transaction(organizationKey, async (client) => {
      const result = await client.query<{ result: OpsAccessMutationResult }>(sql, values);
      return result.rows[0]?.result ?? { outcome: "conflict", reason: "mutation_failed" };
    });
  }
  private async transaction<T>(organizationKey: string, operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const organization = await client.query<{ id: string | null }>("SELECT dop_set_organization_context($1) AS id", [organizationKey]);
      if (!organization.rows[0]?.id) throw new Error("organization_not_found");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }
}

async function requireAdmin(client: PoolClient, actorId: string): Promise<void> {
  const result = await client.query("SELECT id FROM actors WHERE id = $1 AND actor_type = 'admin' AND status = 'active'", [actorId]);
  if (!result.rows[0]) throw new Error("admin_required");
}
function iso(value: Date | string): string { return value instanceof Date ? value.toISOString() : new Date(value).toISOString(); }
