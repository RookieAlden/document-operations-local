import type { Pool, PoolClient } from "pg";
import type {
  WorkbenchCreateResult,
  WorkbenchInvitationResult,
  WorkbenchRepository,
  WorkbenchServiceOption,
  WorkbenchSetupSnapshot,
} from "../../ports/workbench-repository.js";

interface ServiceRow {
  id: string;
  display_name: string;
  description: string;
  frequency: string;
  requirements: unknown;
}

export class PostgresWorkbenchRepository implements WorkbenchRepository {
  constructor(private readonly pool: Pool) {}

  async acknowledgeDuplicates(organizationKey: string, request: Parameters<WorkbenchRepository["acknowledgeDuplicates"]>[1]) {
    return await this.transaction(organizationKey, async (client) => {
      const result = await client.query<{ result: Awaited<ReturnType<WorkbenchRepository["acknowledgeDuplicates"]>> }>(
        "SELECT dop_workbench_acknowledge_duplicates($1,$2,$3,$4,$5) AS result",
        [request.actorId, request.caseId, request.idempotencyKey, request.correlationId, request.now]);
      return result.rows[0]?.result ?? { outcome: "conflict" as const, reason: "invalid_request" };
    });
  }

  async escalateReview(organizationKey: string, request: Parameters<WorkbenchRepository["escalateReview"]>[1]) {
    return await this.transaction(organizationKey, async (client) => {
      const result = await client.query<{ result: Awaited<ReturnType<WorkbenchRepository["escalateReview"]>> }>(
        "SELECT dop_workbench_escalate_document_review($1,$2,$3,$4,$5) AS result",
        [request.actorId, request.documentId, request.idempotencyKey, request.correlationId, request.now]);
      return result.rows[0]?.result ?? { outcome: "conflict" as const, reason: "invalid_request" };
    });
  }

  async getSetup(organizationKey: string, now: Date): Promise<WorkbenchSetupSnapshot> {
    return await this.transaction(organizationKey, async (client) => {
      const result = await client.query<ServiceRow>(`
        SELECT version.id,
               coalesce(version.display_name_snapshot, package.display_name) AS display_name,
               coalesce(version.description_snapshot, package.description) AS description,
               version.blueprint#>>'{workflow,frequency}' AS frequency,
               coalesce(jsonb_agg(jsonb_build_object(
                 'code', requirement->>'code',
                 'name', coalesce(document_type.display_name, requirement->>'code'),
                 'minimumCount', (requirement->>'minimumCount')::integer,
                 'maximumCount', CASE
                   WHEN requirement->'maximumCount' IS NULL OR requirement->'maximumCount' = 'null'::jsonb
                     THEN NULL
                   ELSE (requirement->>'maximumCount')::integer
                 END
               ) ORDER BY requirement->>'code') FILTER (WHERE requirement IS NOT NULL), '[]'::jsonb) AS requirements
          FROM work_configuration_package_versions version
          JOIN work_configuration_packages package
            ON package.organization_id=version.organization_id AND package.id=version.package_id
          CROSS JOIN LATERAL jsonb_array_elements(version.blueprint->'requirements') requirement
          LEFT JOIN document_types document_type
            ON document_type.organization_id=version.organization_id
           AND document_type.code=requirement->>'documentTypeCode'
           AND document_type.status='active'
         WHERE version.status='published' AND package.status='active'
           AND package.current_published_version_id=version.id
           AND version.blueprint#>'{subjectDefaults,attributes,synthetic}'='true'::jsonb
           AND version.blueprint#>>'{workflow,frequency}' IN ('monthly','quarterly')
         GROUP BY version.id,package.display_name,package.description
         ORDER BY frequency,display_name
      `);
      return {
        generatedAt: now.toISOString(),
        serviceOptions: result.rows.map(mapServiceOption),
      };
    });
  }

  async createClientCase(
    organizationKey: string,
    request: Parameters<WorkbenchRepository["createClientCase"]>[1],
  ): Promise<WorkbenchCreateResult> {
    return await this.transaction(organizationKey, async (client) => {
      const result = await client.query<{ result: WorkbenchCreateResult }>(
        "SELECT dop_create_workbench_client_case($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS result",
        [request.actorId, request.packageVersionId, request.displayName, request.contactName,
          request.periodStart, request.periodEnd, JSON.stringify(request.requirements), request.idempotencyKey,
          request.correlationId, request.now],
      );
      return result.rows[0]?.result ?? { outcome: "conflict", reason: "invalid_request" };
    });
  }

  async issueInvitation(
    organizationKey: string,
    request: Parameters<WorkbenchRepository["issueInvitation"]>[1],
  ): Promise<WorkbenchInvitationResult> {
    return await this.transaction(organizationKey, async (client) => {
      const result = await client.query<{ result: WorkbenchInvitationResult }>(
        "SELECT dop_workbench_issue_case_invitation($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result",
        [request.actorId, request.caseId, request.invitationTokenSha256, request.maximumSubmissions,
          request.validUntil, request.idempotencyKey, request.correlationId, request.now, request.replaceInvitationId ?? null],
      );
      return result.rows[0]?.result ?? { outcome: "conflict", reason: "invalid_request" };
    });
  }

  private async transaction<T>(organizationKey: string, operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const organization = await client.query<{ id: string | null }>(
        "SELECT dop_set_organization_context($1) AS id",
        [organizationKey],
      );
      if (!organization.rows[0]?.id) throw new Error("organization_not_found");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

function mapServiceOption(row: ServiceRow): WorkbenchServiceOption {
  if (row.frequency !== "monthly" && row.frequency !== "quarterly") {
    throw new Error("unsupported_workbench_frequency");
  }
  const requirements = Array.isArray(row.requirements) ? row.requirements : [];
  return {
    id: row.id,
    name: row.display_name,
    description: row.description,
    frequency: row.frequency,
    requirements: requirements.map((value) => {
      const item = value as Record<string, unknown>;
      return {
        code: String(item.code ?? ""),
        name: String(item.name ?? "资料"),
        minimumCount: Number(item.minimumCount ?? 1),
        maximumCount: item.maximumCount === null || item.maximumCount === undefined
          ? null
          : Number(item.maximumCount),
      };
    }),
  };
}
