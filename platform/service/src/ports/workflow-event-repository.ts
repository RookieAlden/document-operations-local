import type { WorkflowEvent } from "../domain/workflow-event.js";

export interface WorkflowEventRepository {
  append(event: WorkflowEvent): Promise<"inserted" | "duplicate">;
}
