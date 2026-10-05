import type { Pool, PoolClient } from "pg";
import type {
  OpsOnboardingMutationResult,
  OpsOnboardingPackage,
  OpsOnboardingRepository,
  OpsOnboardingSnapshot,
} from "../../ports/ops-onboarding-repository.js";
import type { WorkConfigurationRequirement } from "../../ports/ops-configuration-repository.js";

interface PackageRow {
  version_id: string;
  package_id: string;
  package_key: string;
  display_name: string;
  description: string;
  industry_package: string | null;
  version: number;
  workflow_template_id: string;
  workflow_template_name: string;
  blueprint: {
    subjectDefaults: { status?: "active" | "paused"; attributes?: Record<string, unknown> };
    workflow: Record<string, unknown>;
    requirements: WorkConfigurationRequirement[];
  };
  definition_hash: string;
  published_at: Date | string;
}

export class PostgresOpsOnboardingRepository implements OpsOnboardingRepository {
  constructor(private readonly pool: Pool) {}

  async getOnboarding(organizationKey: string, actorId: string, now: Date): Promise<OpsOnboardingSnapshot> {
    return await this.transaction(organizationKey, async (client) => {
      await requireAdmin(client, actorId);
      const packages = await client.query<PackageRow>(`
        SELECT DISTINCT ON (package.id)
               version.id AS version_id, package.id AS package_id, package.package_key,
               package.display_name, package.description, package.industry_package,
               version.version, version.workflow_template_id,
               workflow_template.display_name AS workflow_template_name,
               version.blueprint, version.definition_hash, version.published_at
          FROM work_configuration_packages package
          JOIN work_configuration_package_versions version ON version.id = package.current_published_version_id
          JOIN workflow_templates workflow_template ON workflow_template.id = version.workflow_template_id
         WHERE package.status = 'active' AND version.status = 'published'
         ORDER BY package.id, version.version DESC, version.revision DESC
      `);
      const recent = await client.query<{
        id: string; subject_id: string; subject_key: string; subject_name: string;
        package_name: string; package_version: number; configuration_release_id: string;
        configuration_status: "draft" | "in_review" | "published";
        created_by_name: string; reason: string; created_at: Date | string;
      }>(`
        SELECT onboarding.id, subject.id AS subject_id, subject.subject_key,
               subject.display_name AS subject_name, package.display_name AS package_name,
               package_version.version AS package_version,
               onboarding.configuration_release_id,
               configuration.status AS configuration_status,
               actor.display_name AS created_by_name, onboarding.reason, onboarding.created_at
          FROM subject_onboardings onboarding
          JOIN subjects subject ON subject.id = onboarding.subject_id
          JOIN work_configuration_package_versions package_version ON package_version.id = onboarding.package_version_id
          JOIN work_configuration_packages package ON package.id = package_version.package_id
          JOIN work_configuration_releases configuration ON configuration.id = onboarding.configuration_release_id
          JOIN actors actor ON actor.id = onboarding.created_by_actor_id
         ORDER BY onboarding.created_at DESC LIMIT 50
      `);
      const contacts = await client.query<{ id: string; display_name: string; email: string | null }>(
        "SELECT id, display_name, email FROM actors WHERE actor_type = 'customer' AND status = 'active' ORDER BY lower(display_name)",
      );
      return {
        generatedAt: now.toISOString(),
        packages: packages.rows.map(toPackage),
        recentOnboardings: recent.rows.map((row) => ({
          id: row.id, subjectId: row.subject_id, subjectKey: row.subject_key,
          subjectName: row.subject_name, packageName: row.package_name,
          packageVersion: row.package_version, configurationReleaseId: row.configuration_release_id,
          configurationStatus: row.configuration_status, createdByName: row.created_by_name,
          reason: row.reason, createdAt: iso(row.created_at),
        })),
        customerContacts: contacts.rows.map((row) => ({ id: row.id, displayName: row.display_name, email: row.email })),
      };
    });
  }

  async onboardSubject(organizationKey: string, request: Parameters<OpsOnboardingRepository["onboardSubject"]>[1]) {
    return await this.call(organizationKey,
      "SELECT dop_onboard_subject_from_package($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS result",
      [request.actorId, request.packageVersionId, request.subjectKey, request.displayName,
        request.subjectType, request.primaryContactActorId, request.attributes, request.reason,
        request.idempotencyKey, request.correlationId, request.now]);
  }

  async createCase(organizationKey: string, request: Parameters<OpsOnboardingRepository["createCase"]>[1]) {
    return await this.call(organizationKey,
      "SELECT dop_create_case_from_configuration($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) AS result",
      [request.actorId, request.releaseId, request.periodKey, request.periodStart,
        request.periodEnd, request.dueAt, request.timezone, request.externalReference,
        request.reason, request.idempotencyKey, request.correlationId, request.now]);
  }

  private async call(organizationKey: string, sql: string, values: unknown[]): Promise<OpsOnboardingMutationResult> {
    return await this.transaction(organizationKey, async (client) => {
      const result = await client.query<{ result: OpsOnboardingMutationResult }>(sql, values);
      return result.rows[0]?.result ?? { outcome: "conflict", reason: "mutation_failed" };
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
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }
}

function toPackage(row: PackageRow): OpsOnboardingPackage {
  return {
    id: row.version_id, packageId: row.package_id, packageKey: row.package_key,
    displayName: row.display_name, description: row.description,
    industryPackage: row.industry_package, version: row.version,
    workflowTemplateId: row.workflow_template_id, workflowTemplateName: row.workflow_template_name,
    subjectDefaults: {
      status: row.blueprint.subjectDefaults.status ?? "active",
      attributes: row.blueprint.subjectDefaults.attributes ?? {},
    },
    workflow: row.blueprint.workflow, requirements: row.blueprint.requirements,
    definitionHash: row.definition_hash, publishedAt: iso(row.published_at),
  };
}

async function requireAdmin(client: PoolClient, actorId: string): Promise<void> {
  const result = await client.query(
    "SELECT id FROM actors WHERE id = $1 AND actor_type = 'admin' AND status = 'active'", [actorId],
  );
  if (!result.rows[0]) throw new Error("admin_required");
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
