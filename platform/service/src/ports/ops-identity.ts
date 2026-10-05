export interface OpsIdentityCredentials {
  email: string;
  password: string;
}

export type OpsIdentityAuthenticationResult =
  | { outcome: "authenticated"; externalSubjectId: string }
  | { outcome: "invalid_credentials" }
  | { outcome: "identity_provider_unavailable" };

export interface OpsIdentityAuthenticator {
  authenticate(credentials: OpsIdentityCredentials): Promise<OpsIdentityAuthenticationResult>;
}

export interface OpsAuthorizedActor {
  id: string;
  displayName: string;
  actorType: "staff" | "manager" | "admin";
  platformConsoleAccess: boolean;
}

export interface OpsIdentityRepository {
  findActiveByExternalSubject(
    organizationKey: string,
    externalSubjectId: string,
  ): Promise<OpsAuthorizedActor | null>;

  findActiveById(organizationKey: string, actorId: string): Promise<OpsAuthorizedActor | null>;
}
