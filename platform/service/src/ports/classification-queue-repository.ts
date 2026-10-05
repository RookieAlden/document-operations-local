export interface FindClassificationCandidatesRequest {
  organizationKey: string;
  limit: number;
  now: Date;
}

export interface ClassificationQueueRepository {
  findCandidates(request: FindClassificationCandidatesRequest): Promise<string[]>;
  checkReady(organizationKey: string): Promise<boolean>;
}
