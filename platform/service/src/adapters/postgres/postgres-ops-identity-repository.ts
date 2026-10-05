import type { Pool, PoolClient } from "pg";
import type { OpsAuthorizedActor, OpsIdentityRepository } from "../../ports/ops-identity.js";

interface ActorRow {
  id: string;
  display_name: string;
  actor_type: "staff" | "manager" | "admin";
}

export class PostgresOpsIdentityRepository implements OpsIdentityRepository {
  constructor(private readonly pool: Pool) {}

  async findActiveByExternalSubject(
    organizationKey: string,
    externalSubjectId: string,
  ): Promise<OpsAuthorizedActor | null> {
    return await this.find(organizationKey, "external_subject_id", externalSubjectId);
  }

  async findActiveById(organizationKey: string, actorId: string): Promise<OpsAuthorizedActor | null> {
    return await this.find(organizationKey, "id", actorId);
  }

  private async find(
    organizationKey: string,
    column: "id" | "external_subject_id",
    value: string,
  ): Promise<OpsAuthorizedActor | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const organization = await client.query<{ id: string | null }>(
        "SELECT dop_set_organization_context($1) AS id",
        [organizationKey],
      );
      if (!organization.rows[0]?.id) {
        await client.query("ROLLBACK");
        return null;
      }
      const actor = await selectActor(client, column, value);
      await client.query("COMMIT");
      return actor.rows[0] ? mapActor(actor.rows[0]) : null;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function selectActor(
  client: PoolClient,
  column: "id" | "external_subject_id",
  value: string,
) {
  return await client.query<ActorRow>(
    `SELECT id, display_name, actor_type
       FROM actors
      WHERE ${column} = $1
        AND status = 'active'
        AND actor_type IN ('staff','manager','admin')`,
    [value],
  );
}

function mapActor(row: ActorRow): OpsAuthorizedActor {
  return {
    id: row.id,
    displayName: row.display_name,
    actorType: row.actor_type,
    platformConsoleAccess: row.actor_type === "admin",
  };
}
