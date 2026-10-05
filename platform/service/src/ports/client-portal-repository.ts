export interface ClientPortalRequirement {
  code: string;
  displayName: string;
  minimumCount: number;
  acceptedCount: number;
  missingCount: number;
  reviewCount: number;
  status: "accepted" | "in_review" | "missing";
}

export interface ClientPortalDocument {
  filename: string;
  submittedAt: string;
  updatedAt: string;
  status: "submitted" | "processing" | "in_review" | "accepted" | "needs_supplement";
  noteCode: "duplicate_not_counted" | "not_counted" | null;
}

export interface ClientPortalQuestion {
  title: string;
  body: string;
  requestedAction: "supplement";
  status: "published";
  publishedAt: string;
}

export interface ClientPortalSnapshot {
  organizationName: string;
  subjectName: string;
  periodKey: string;
  caseStatus: string;
  portalStatus: "complete" | "needs_action" | "processing" | "missing" | "in_review";
  isComplete: boolean;
  uploadAllowed: boolean;
  validUntil: string;
  remainingSubmissions: number;
  requiredCount: number;
  acceptedRequirementCount: number;
  processingDocumentCount: number;
  reviewDocumentCount: number;
  acceptedDocumentCount: number;
  requirements: ClientPortalRequirement[];
  documents: ClientPortalDocument[];
  questions: ClientPortalQuestion[];
  updatedAt: string;
}

export type ClientPortalReadResult =
  | { outcome: "authorized"; providerFormId: string; periodKey: string; snapshot: ClientPortalSnapshot }
  | { outcome: "blocked"; reason: "link_unavailable" };

export interface ClientPortalRepository {
  read(tokenSha256: string, correlationId: string, now: Date): Promise<ClientPortalReadResult>;
}
