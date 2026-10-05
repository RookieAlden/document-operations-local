import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ReceiveSubmissionResult } from "../application/receive-submission.js";
import {
  FormConnector,
  type CanonicalSubmissionReceiver,
  type FormConnectorInspection,
} from "../connectors/forms/form-connector.js";
import type { CanonicalSubmission } from "../domain/submission.js";
import type { DemoFormAuthorizationRepository } from "../ports/demo-form-authorization-repository.js";

export interface FormConnectorRouterOptions {
  connector: FormConnector;
  receiver: CanonicalSubmissionReceiver;
  token: string;
  organizationKey?: string;
  authorizationRepository?: DemoFormAuthorizationRepository;
  now?: () => Date;
  maxBodyBytes?: number;
  fileMetadataResolver?: FormConnectorFileMetadataResolver;
}

export interface FormConnectorFileMetadataResolver {
  resolve(files: CanonicalSubmission["files"]): Promise<CanonicalSubmission["files"]>;
}

export class FormConnectorRouter {
  private readonly expectedTokenHash: Buffer;
  private readonly route: string;
  private readonly maxBodyBytes: number;

  constructor(private readonly options: FormConnectorRouterOptions) {
    this.expectedTokenHash = sha256(options.token);
    this.route = `/v1/connectors/forms/${encodeURIComponent(options.connector.profile.connectorId)}/submissions`;
    this.maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/v1/connectors/forms/")) return false;
    const requestId = String(response.getHeader("x-request-id") ?? "unknown");
    if (request.method !== "POST" || url.pathname !== this.route) {
      sendJson(response, 404, { error: "connector_not_found", request_id: requestId });
      return true;
    }
    if (!authorized(request, this.expectedTokenHash)) {
      sendJson(response, 401, { error: "unauthorized", request_id: requestId });
      return true;
    }
    if (!isJsonContentType(request.headers["content-type"])) {
      sendJson(response, 415, { error: "content_type_must_be_application_json", request_id: requestId });
      return true;
    }

    let rawBody: string;
    try {
      rawBody = await readBody(request, this.maxBodyBytes);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        sendJson(response, 413, { error: "payload_too_large", request_id: requestId });
        return true;
      }
      throw error;
    }
    let input: unknown;
    try {
      input = JSON.parse(rawBody);
    } catch {
      sendJson(response, 400, { error: "invalid_json", request_id: requestId });
      return true;
    }
    const inspected = this.options.connector.inspect(input);
    if (!inspected.ok) {
      sendJson(response, 422, {
        outcome: "rejected",
        request_id: requestId,
        errors: inspected.errors,
      });
      return true;
    }
    let inspectedValue: FormConnectorInspection = inspected.value;
    if (this.options.fileMetadataResolver) {
      try {
        inspectedValue = {
          ...inspected.value,
          files: await this.options.fileMetadataResolver.resolve(inspected.value.files),
        };
      } catch (error) {
        const candidate = error instanceof Error ? error.message : "";
        const reason = ["host_not_allowed", "metadata_unavailable", "invalid_content_length"].includes(candidate)
          ? candidate : "metadata_unavailable";
        sendJson(response, 422, {
          outcome: "rejected",
          request_id: requestId,
          error: "source_file_metadata_unavailable",
          reason,
        });
        return true;
      }
    }
    let authorizedScope;
    if (this.options.connector.profile.demoGovernanceRequired) {
      const invitationToken = inspectedValue.invitationToken;
      if (!invitationToken || !this.options.authorizationRepository || !this.options.organizationKey) {
        sendJson(response, 403, { outcome: "rejected", request_id: requestId, error: "demo_invitation_required" });
        return true;
      }
      const sizes = inspectedValue.files.map((file) => file.declared_size_bytes);
      const authorization = await this.options.authorizationRepository.authorize(this.options.organizationKey, {
        connectorKey: this.options.connector.profile.connectorId,
        providerFormId: inspectedValue.providerFormId,
        providerSubmissionId: inspectedValue.providerSubmissionId,
        invitationTokenSha256: createHash("sha256").update(invitationToken).digest("hex"),
        claimedPeriod: inspectedValue.claimedPeriod,
        fileCount: inspectedValue.files.length,
        declaredTotalBytes: sizes.reduce<number>((total, size) => total + (size ?? 0), 0),
        declaredBytesComplete: sizes.every((size) => size !== undefined),
        mimeTypes: inspectedValue.files.map((file) => file.declared_mime_type ?? ""),
        correlationId: requestId,
        now: this.options.now?.() ?? new Date(),
      });
      if (authorization.outcome === "rejected") {
        const boundaryReason = ["period_mismatch", "file_count_exceeded", "declared_bytes_required",
          "declared_bytes_exceeded", "mime_type_required", "mime_type_not_allowed", "invalid_request"]
          .includes(authorization.reason);
        sendJson(response, boundaryReason ? 422 : 403, {
          outcome: "rejected", request_id: requestId, error: authorization.reason,
        });
        return true;
      }
      authorizedScope = authorization;
    }
    const mapped = this.options.connector.mapInspection(inspectedValue, authorizedScope);
    if (!mapped.ok) {
      sendJson(response, 422, {
        outcome: "rejected",
        request_id: requestId,
        errors: mapped.errors,
      });
      return true;
    }
    const result = await this.options.receiver.execute({
      input: mapped.value,
      workerId: `form-connector:${this.options.connector.profile.connectorId}:${requestId}`,
      correlationId: requestId,
    });
    sendResult(response, requestId, result);
    return true;
  }
}

function authorized(request: IncomingMessage, expectedTokenHash: Buffer): boolean {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return false;
  const supplied = authorization.slice("Bearer ".length);
  return supplied.length > 0 && timingSafeEqual(sha256(supplied), expectedTokenHash);
}

function readBody(request: IncomingMessage, maximum: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maximum) {
        reject(new BodyTooLargeError());
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

class BodyTooLargeError extends Error {}

function isJsonContentType(value: string | undefined): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function sendResult(response: ServerResponse, requestId: string, result: ReceiveSubmissionResult): void {
  if (result.outcome === "accepted") {
    return sendJson(response, 202, {
      outcome: result.outcome,
      request_id: requestId,
      submission_id: result.submissionId,
      document_ids: result.documentIds,
      event_ids: result.eventIds,
    });
  }
  if (result.outcome === "rejected") {
    return sendJson(response, 422, { outcome: result.outcome, request_id: requestId, errors: result.errors });
  }
  return sendJson(response, 200, { outcome: result.outcome, request_id: requestId });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
