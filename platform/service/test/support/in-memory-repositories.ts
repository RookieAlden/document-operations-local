import { randomUUID } from "node:crypto";
import type {
  IdempotencyRepository,
  ReservationRequest,
  ReservationResult,
} from "../../src/ports/idempotency-repository.js";
import type { WorkflowEventRepository } from "../../src/ports/workflow-event-repository.js";
import type { WorkflowEvent } from "../../src/domain/workflow-event.js";
import type {
  AcceptSubmissionRequest,
  AcceptSubmissionResult,
  SubmissionIntakeRepository,
} from "../../src/ports/submission-intake-repository.js";

export class InMemoryIdempotencyRepository implements IdempotencyRepository {
  readonly reservations = new Map<string, { id: string; leaseExpiresAt: Date }>();

  async reserve(request: ReservationRequest): Promise<ReservationResult> {
    const mapKey = `${request.organizationId}|${request.scope}|${request.idempotencyKey}`;
    const existing = this.reservations.get(mapKey);
    if (existing && existing.leaseExpiresAt > request.now) {
      return { outcome: "in_progress", reservationId: existing.id, leaseExpiresAt: existing.leaseExpiresAt };
    }

    const reservation = {
      id: existing?.id ?? randomUUID(),
      leaseExpiresAt: new Date(request.now.getTime() + request.leaseSeconds * 1000),
    };
    this.reservations.set(mapKey, reservation);
    return { outcome: "acquired", reservationId: reservation.id, leaseExpiresAt: reservation.leaseExpiresAt };
  }
}

export class InMemoryWorkflowEventRepository implements WorkflowEventRepository {
  readonly events: WorkflowEvent[] = [];

  async append(event: WorkflowEvent): Promise<"inserted" | "duplicate"> {
    if (this.events.some((candidate) =>
      candidate.organization_id === event.organization_id &&
      candidate.idempotency_key === event.idempotency_key)) {
      return "duplicate";
    }
    this.events.push(event);
    return "inserted";
  }
}

export class InMemorySubmissionIntakeRepository implements SubmissionIntakeRepository {
  readonly accepted = new Map<string, AcceptSubmissionResult & { outcome: "accepted" }>();
  readonly activeLeases = new Map<string, Date>();
  readonly knownOrganizations = new Set(["dev-accounting-firm"]);
  readonly knownCases = new Set([
    "dev-accounting-firm|accounting.monthly.document_collection|dev-client-001|2026-07",
  ]);

  async accept(request: AcceptSubmissionRequest): Promise<AcceptSubmissionResult> {
    if (!this.knownOrganizations.has(request.submission.organization_key)) {
      return { outcome: "not_found", resource: "organization" };
    }
    if (!this.knownCases.has(request.submission.case_key)) {
      return { outcome: "not_found", resource: "case_or_workflow" };
    }
    if (request.submission.environment === "PROD") {
      return { outcome: "admission_rejected", reason: "active_production_policy_required" };
    }
    const existing = this.accepted.get(request.submissionKey);
    if (existing) {
      return { outcome: "duplicate", submissionId: existing.submissionId };
    }
    const lease = this.activeLeases.get(request.submissionKey);
    if (lease && lease > request.now) {
      return { outcome: "in_progress", leaseExpiresAt: lease };
    }
    this.activeLeases.delete(request.submissionKey);

    const result: AcceptSubmissionResult & { outcome: "accepted" } = {
      outcome: "accepted",
      organizationId: "129a9b08-31f0-44df-b173-e76273a16cd0",
      caseId: "c1a09a99-8348-4c8f-a979-9368f094105f",
      submissionId: request.submissionId,
      documentIds: request.documents.map((document) => document.id),
      eventIds: [request.submissionEventId, ...request.documents.map((document) => document.eventId)],
    };
    this.accepted.set(request.submissionKey, result);
    return result;
  }
}
