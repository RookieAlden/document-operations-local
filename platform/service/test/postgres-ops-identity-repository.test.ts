import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { PostgresOpsIdentityRepository } from "../src/adapters/postgres/postgres-ops-identity-repository.js";

interface ActorRow {
  id: string;
  display_name: string;
  actor_type: "staff" | "manager" | "admin";
}

class IdentityFakeClient {
  readonly statements: string[] = [];

  constructor(readonly actor: ActorRow | null) {}

  async query(text: string): Promise<{ rowCount: number; rows: Array<Record<string, unknown>> }> {
    const sql = text.replace(/\s+/g, " ").trim();
    this.statements.push(sql);
    if (sql.startsWith("SELECT dop_set_organization_context($1) AS id")) {
      return result([{ id: "organization-1" }]);
    }
    if (sql.startsWith("SELECT id, display_name, actor_type FROM actors")) {
      return result(this.actor ? [{ ...this.actor }] : []);
    }
    return result([]);
  }

  release(): void {}
}

function result(rows: Array<Record<string, unknown>>) {
  return { rowCount: rows.length, rows };
}

function actor(actorType: ActorRow["actor_type"]): ActorRow {
  return {
    id: "actor-1",
    display_name: "Synthetic Operator",
    actor_type: actorType,
  };
}

function repositoryFor(row: ActorRow) {
  const client = new IdentityFakeClient(row);
  return {
    client,
    repository: new PostgresOpsIdentityRepository({ connect: async () => client } as unknown as Pool),
  };
}

describe("PostgresOpsIdentityRepository platform console capability", () => {
  it("reserves the advanced console for the organization admin", async () => {
    const { client, repository } = repositoryFor(actor("admin"));

    await expect(repository.findActiveById("dev-accounting-firm", "actor-1")).resolves.toMatchObject({
      actorType: "admin",
      platformConsoleAccess: true,
    });
    expect(client.statements.at(-1)).toBe("COMMIT");
  });

  it.each([
    ["staff", "staff"],
    ["manager", "manager"],
  ] as const)("does not grant the capability to %s", async (_label, actorType) => {
    const { repository } = repositoryFor(actor(actorType));

    await expect(repository.findActiveById("dev-accounting-firm", "actor-1")).resolves.toMatchObject({
      actorType,
      platformConsoleAccess: false,
    });
  });
});
