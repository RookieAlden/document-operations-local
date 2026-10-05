export interface WorkflowEvent {
  schema_version: "1.0";
  event_id: string;
  idempotency_key: string;
  event_type: string;
  event_version: number;
  organization_id: string;
  aggregate_type: string;
  aggregate_id: string;
  correlation_id: string;
  causation_id?: string | null;
  actor_id?: string | null;
  producer: string;
  occurred_at: string;
  payload: Record<string, unknown>;
}
