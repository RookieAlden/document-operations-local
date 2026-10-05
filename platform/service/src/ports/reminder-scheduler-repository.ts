export interface ReminderScheduleResult {
  outcome: "completed" | "duplicate" | "conflict";
  scheduleRunId?: string;
  reason?: string;
  casesScanned: number;
  remindersCreated: number;
  remindersStopped: number;
  escalationsCreated: number;
  externalCallCount: 0;
}

export interface ReminderSchedulerRepository {
  checkReady(organizationKey: string): Promise<boolean>;
  run(request: {
    organizationKey: string;
    workerId: string;
    runKey: string;
    now: Date;
  }): Promise<ReminderScheduleResult>;
}
