import type { Pool } from "pg";
import type { ClientPortalReadResult, ClientPortalRepository } from "../../ports/client-portal-repository.js";

export class PostgresClientPortalRepository implements ClientPortalRepository {
  constructor(private readonly pool: Pool) {}

  async read(tokenSha256: string, correlationId: string, now: Date): Promise<ClientPortalReadResult> {
    const result = await this.pool.query<{ result: ClientPortalReadResult }>(
      "SELECT dop_read_client_portal_snapshot($1,$2,$3) AS result",
      [tokenSha256, correlationId, now],
    );
    return result.rows[0]?.result ?? { outcome: "blocked", reason: "link_unavailable" };
  }
}
