import type { Pool } from "pg";
import type { OpsDocumentPreviewRepository } from "../../ports/document-preview.js";

export class PostgresOpsDocumentPreviewRepository implements OpsDocumentPreviewRepository {
  constructor(private readonly pool: Pool) {}

  async getStorageReference(organizationKey: string, documentId: string): Promise<
    { outcome: "available"; storageReference: string } | { outcome: "not_found" } | { outcome: "not_ready" }
  > {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const organization = await client.query<{ id: string | null }>("SELECT dop_set_organization_context($1) AS id", [organizationKey]);
      if (!organization.rows[0]?.id) { await client.query("COMMIT"); return { outcome: "not_found" }; }
      const result = await client.query<{ incoming_storage_ref: string | null }>(
        "SELECT incoming_storage_ref FROM documents WHERE id = $1",
        [documentId],
      );
      await client.query("COMMIT");
      if (!result.rows[0]) return { outcome: "not_found" };
      if (!result.rows[0].incoming_storage_ref) return { outcome: "not_ready" };
      return { outcome: "available", storageReference: result.rows[0].incoming_storage_ref };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }
}
