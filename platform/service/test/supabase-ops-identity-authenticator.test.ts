import { describe, expect, it, vi } from "vitest";
import { SupabaseOpsIdentityAuthenticator } from "../src/adapters/http/supabase-ops-identity-authenticator.js";

const publishableKey = "sb_publishable_test-key-for-ops-authentication";

describe("SupabaseOpsIdentityAuthenticator", () => {
  it("maps a verified Supabase user to a namespaced external subject", async () => {
    const fetchImplementation = vi.fn(async () => new Response(JSON.stringify({
      user: { id: "00000000-0000-4000-9000-000000000999" },
      access_token: "must-not-leave-the-adapter",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const authenticator = new SupabaseOpsIdentityAuthenticator({
      projectUrl: "https://example.supabase.co/",
      publishableKey,
      fetchImplementation,
    });

    await expect(authenticator.authenticate({
      email: "operator@example.invalid",
      password: "correct-password",
    })).resolves.toEqual({
      outcome: "authenticated",
      externalSubjectId: "supabase-auth:00000000-0000-4000-9000-000000000999",
    });
    expect(fetchImplementation).toHaveBeenCalledWith(
      "https://example.supabase.co/auth/v1/token?grant_type=password",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("collapses Supabase credential errors without exposing provider details", async () => {
    const authenticator = new SupabaseOpsIdentityAuthenticator({
      projectUrl: "https://example.supabase.co",
      publishableKey,
      fetchImplementation: async () => new Response(JSON.stringify({ message: "Invalid login credentials" }), { status: 400 }),
    });
    await expect(authenticator.authenticate({ email: "operator@example.invalid", password: "wrong-password" }))
      .resolves.toEqual({ outcome: "invalid_credentials" });
  });

  it("fails closed when Supabase is unavailable or returns a malformed user", async () => {
    const unavailable = new SupabaseOpsIdentityAuthenticator({
      projectUrl: "https://example.supabase.co",
      publishableKey,
      fetchImplementation: async () => new Response("upstream unavailable", { status: 503 }),
    });
    const malformed = new SupabaseOpsIdentityAuthenticator({
      projectUrl: "https://example.supabase.co",
      publishableKey,
      fetchImplementation: async () => new Response(JSON.stringify({ user: {} }), { status: 200 }),
    });
    await expect(unavailable.authenticate({ email: "operator@example.invalid", password: "password" }))
      .resolves.toEqual({ outcome: "identity_provider_unavailable" });
    await expect(malformed.authenticate({ email: "operator@example.invalid", password: "password" }))
      .resolves.toEqual({ outcome: "identity_provider_unavailable" });
  });
});
