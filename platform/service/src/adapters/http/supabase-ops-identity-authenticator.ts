import type {
  OpsIdentityAuthenticationResult,
  OpsIdentityAuthenticator,
  OpsIdentityCredentials,
} from "../../ports/ops-identity.js";

export interface SupabaseOpsIdentityAuthenticatorOptions {
  projectUrl: string;
  publishableKey: string;
  timeoutMilliseconds?: number;
  fetchImplementation?: typeof fetch;
}

export class SupabaseOpsIdentityAuthenticator implements OpsIdentityAuthenticator {
  private readonly fetchImplementation: typeof fetch;
  private readonly projectUrl: string;
  private readonly timeoutMilliseconds: number;

  constructor(private readonly options: SupabaseOpsIdentityAuthenticatorOptions) {
    this.projectUrl = options.projectUrl.replace(/\/$/, "");
    if (!/^https:\/\//.test(this.projectUrl)) throw new Error("SUPABASE_URL must use HTTPS");
    if (!options.publishableKey.startsWith("sb_publishable_")) {
      throw new Error("SUPABASE_PUBLISHABLE_KEY must be a Supabase publishable key");
    }
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? 8_000;
  }

  async authenticate(credentials: OpsIdentityCredentials): Promise<OpsIdentityAuthenticationResult> {
    try {
      const response = await this.fetchImplementation(`${this.projectUrl}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: {
          apikey: this.options.publishableKey,
          "content-type": "application/json",
        },
        body: JSON.stringify(credentials),
        signal: AbortSignal.timeout(this.timeoutMilliseconds),
      });
      if ([400, 401, 422].includes(response.status)) return { outcome: "invalid_credentials" };
      if (!response.ok) return { outcome: "identity_provider_unavailable" };
      const body = await response.json() as { user?: { id?: unknown } };
      const subject = body.user?.id;
      if (typeof subject !== "string" || !isUuid(subject)) {
        return { outcome: "identity_provider_unavailable" };
      }
      return { outcome: "authenticated", externalSubjectId: `supabase-auth:${subject.toLowerCase()}` };
    } catch {
      return { outcome: "identity_provider_unavailable" };
    }
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
