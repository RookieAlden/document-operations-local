export interface ReservationRequest {
  organizationId: string;
  scope: string;
  idempotencyKey: string;
  leaseOwner: string;
  leaseSeconds: number;
  now: Date;
}

export type ReservationResult =
  | { outcome: "acquired"; reservationId: string; leaseExpiresAt: Date }
  | { outcome: "duplicate"; reservationId: string; status: string }
  | { outcome: "in_progress"; reservationId: string; leaseExpiresAt: Date | null };

export interface IdempotencyRepository {
  reserve(request: ReservationRequest): Promise<ReservationResult>;
}
