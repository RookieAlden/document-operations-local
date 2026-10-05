export type OpsAccessRole = "staff" | "manager" | "admin";

export interface OpsAccessMember {
  id: string; displayName: string; email: string | null; actorType: OpsAccessRole;
  status: "active" | "inactive"; externalIdentityLinked: boolean; createdAt: string; updatedAt: string;
}

export interface OpsInvitationDraft {
  id: string; email: string; displayName: string; actorType: OpsAccessRole;
  status: "draft" | "cancelled" | "provisioned"; reason: string;
  createdByName: string; createdAt: string; cancelledAt: string | null;
}

export interface OpsAccessSnapshot { generatedAt: string; members: OpsAccessMember[]; invitations: OpsInvitationDraft[] }
export type OpsAccessMutationResult = Record<string, unknown> & { outcome: "completed" | "duplicate" | "conflict" | "not_found"; reason?: string };

export interface OpsAccessRepository {
  getAccess(organizationKey: string, actorId: string, now: Date): Promise<OpsAccessSnapshot>;
  createInvitation(organizationKey: string, request: { actorId: string; email: string; displayName: string; actorType: OpsAccessRole; reason: string; idempotencyKey: string; correlationId: string; now: Date }): Promise<OpsAccessMutationResult>;
  cancelInvitation(organizationKey: string, request: { actorId: string; invitationId: string; reason: string; idempotencyKey: string; correlationId: string; now: Date }): Promise<OpsAccessMutationResult>;
  changeActorAccess(organizationKey: string, request: { actorId: string; targetActorId: string; action: "change_role" | "deactivate" | "reactivate"; actorType?: OpsAccessRole; reason: string; idempotencyKey: string; correlationId: string; now: Date }): Promise<OpsAccessMutationResult>;
}
