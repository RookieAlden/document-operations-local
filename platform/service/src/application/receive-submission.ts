import { randomUUID } from "node:crypto";
import { ContractValidator } from "../contracts/json-schema-validator.js";
import {
  documentIdempotencyKey,
  submissionIdempotencyKey,
  type Environment,
} from "../domain/submission.js";
import type { SubmissionIntakeRepository } from "../ports/submission-intake-repository.js";

export interface ReceiveSubmissionCommand {
  input: unknown;
  workerId: string;
  correlationId?: string;
  now?: Date;
}

export type ReceiveSubmissionResult =
  | {
      outcome: "accepted";
      idempotencyKey: string;
      submissionId: string;
      documentIds: string[];
      eventIds: string[];
    }
  | { outcome: "duplicate" | "in_progress"; idempotencyKey: string }
  | { outcome: "rejected"; errors: Array<{ instancePath: string; message: string }> };

export interface ReceiveSubmissionScope {
  environment: Environment;
  organizationKey: string;
}

export class ReceiveSubmission {
  constructor(
    private readonly validator: ContractValidator,
    private readonly repository: SubmissionIntakeRepository,
    private readonly scope: ReceiveSubmissionScope,
  ) {}

  async execute(command: ReceiveSubmissionCommand): Promise<ReceiveSubmissionResult> {
    const validated = this.validator.validateSubmission(command.input);
    if (!validated.ok) {
      return {
        outcome: "rejected",
        errors: validated.errors.map((error) => ({
          instancePath: error.instancePath,
          message: error.message ?? "schema validation failed",
        })),
      };
    }

    if (validated.value.environment !== this.scope.environment) {
      return {
        outcome: "rejected",
        errors: [{
          instancePath: "/environment",
          message: `must equal runtime environment ${this.scope.environment}`,
        }],
      };
    }
    if (validated.value.organization_key !== this.scope.organizationKey) {
      return {
        outcome: "rejected",
        errors: [{
          instancePath: "/organization_key",
          message: "does not match the organization bound to this intake credential",
        }],
      };
    }
    const dataMode = validated.value.data_classification?.mode;
    if (this.scope.environment !== "PROD" && dataMode === "real_data") {
      return {
        outcome: "rejected",
        errors: [{
          instancePath: "/data_classification/mode",
          message: "real data is prohibited outside the separately authorized PROD environment",
        }],
      };
    }
    if (this.scope.environment === "PROD" && dataMode !== "real_data") {
      return {
        outcome: "rejected",
        errors: [{
          instancePath: "/data_classification/mode",
          message: "PROD intake requires an explicit real_data claim and active admission policy",
        }],
      };
    }

    const now = command.now ?? new Date();
    const key = submissionIdempotencyKey(validated.value);
    const submissionId = randomUUID();
    const documents = validated.value.files.map((file, index) => ({
      id: randomUUID(),
      idempotencyKey: documentIdempotencyKey(validated.value, file, index),
      file,
      eventId: randomUUID(),
    }));
    const accepted = await this.repository.accept({
      submission: validated.value,
      submissionId,
      submissionKey: key,
      correlationId: command.correlationId ?? randomUUID(),
      workflowRunId: randomUUID(),
      submissionEventId: randomUUID(),
      documents,
      workerId: command.workerId,
      leaseSeconds: 300,
      now,
    });

    if (accepted.outcome === "not_found") {
      return {
        outcome: "rejected",
        errors: [{
          instancePath: accepted.resource === "organization" ? "/organization_key" : "/case_key",
          message: accepted.resource === "organization"
            ? "organization is not configured"
            : "case and workflow template combination is not configured",
        }],
      };
    }
    if (accepted.outcome === "binding_rejected") {
      return {
        outcome: "rejected",
        errors: [{
          instancePath: "/source/connector_key",
          message: ({
            source_connector_not_active: "the Case source connector is not active",
            source_connector_claim_required: "is required for a governed Case source",
            source_connector_claim_mismatch: "does not match the connector pinned to the Case",
            source_connector_transport_mismatch: "does not support the submitted source transport",
            source_connector_documents_capability_required: "does not permit document intake",
            source_connector_webhook_capability_required: "does not permit webhook intake",
            source_connector_attachment_capability_required: "does not permit attachment intake",
            source_connector_file_count_exceeded: "exceeds the Connector file-count boundary",
            source_connector_declared_mime_required: "requires a declared MIME type for every file",
            source_connector_declared_size_required: "requires a declared byte size for every file",
            source_connector_mime_not_allowed: "contains a MIME type not allowed by the Connector",
            source_connector_file_too_large: "contains a file larger than the Connector boundary",
          } as const)[accepted.reason],
        }],
      };
    }
    if (accepted.outcome === "admission_rejected") {
      return {
        outcome: "rejected",
        errors: [{
          instancePath: "/data_classification",
          message: ({
            nonproduction_real_data_blocked: "real data is prohibited in DEV and UAT",
            synthetic_subject_required: "DEV and UAT intake requires an explicitly synthetic Subject",
            production_real_data_claim_required: "PROD requires an explicit real_data claim",
            production_subject_and_case_not_authorized: "the Subject and Case are not explicitly authorized for production real data",
            production_policy_key_required: "PROD requires a production admission policy key",
            active_production_policy_required: "no active production data admission policy matches this Case",
            production_policy_expired: "the production data admission policy is not currently valid",
            production_policy_evidence_invalid: "the production data admission evidence is incomplete",
            production_period_out_of_scope: "the Case period is outside the approved production scope",
            production_source_out_of_scope: "the intake source is outside the approved production scope",
            production_file_boundary_exceeded: "the submission exceeds the approved production file boundary",
            production_mime_out_of_scope: "a file MIME type is outside the approved production scope",
            idempotency_payload_mismatch: "the admission idempotency key was reused with different content",
            data_admission_invalid_request: "the data admission request is invalid",
          } as const)[accepted.reason],
        }],
      };
    }
    if (accepted.outcome !== "accepted") {
      return { outcome: accepted.outcome, idempotencyKey: key };
    }

    return {
      outcome: "accepted",
      idempotencyKey: key,
      submissionId: accepted.submissionId,
      documentIds: accepted.documentIds,
      eventIds: accepted.eventIds,
    };
  }
}
