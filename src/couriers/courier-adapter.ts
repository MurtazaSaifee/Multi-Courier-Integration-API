import type {
  CancelShipmentInput,
  CourierCancelResult,
  CourierCreateResult,
  CourierTrackResult,
  CreateOrderRequest,
  TrackShipmentInput
} from '../domain/contracts.js';

export type CourierOperation = 'create' | 'track' | 'cancel';

export type CourierFailureKind =
  | 'authentication'
  | 'client'
  | 'server'
  | 'timeout'
  | 'network'
  | 'not_implemented';

export type CourierProviderErrorOptions = {
  operation: CourierOperation;
  kind: CourierFailureKind;
  message: string;
  retryable: boolean;
  statusCode?: number;
  providerCode?: string;
  rawRequestPayload?: unknown;
  rawResponsePayload?: unknown;
};

/** Internal error shape for failures returned by a courier provider. */
export class CourierProviderError extends Error {
  readonly operation: CourierOperation;
  readonly kind: CourierFailureKind;
  readonly retryable: boolean;
  readonly statusCode?: number;
  readonly providerCode?: string;
  readonly rawRequestPayload?: unknown;
  readonly rawResponsePayload?: unknown;

  constructor(options: CourierProviderErrorOptions) {
    super(options.message);
    this.name = 'CourierProviderError';
    this.operation = options.operation;
    this.kind = options.kind;
    this.retryable = options.retryable;
    this.statusCode = options.statusCode;
    this.providerCode = options.providerCode;
    this.rawRequestPayload = options.rawRequestPayload;
    this.rawResponsePayload = options.rawResponsePayload;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface CourierAdapter {
  readonly courierPartner: string;

  createShipment(request: CreateOrderRequest): Promise<CourierCreateResult>;

  trackShipment(input: TrackShipmentInput): Promise<CourierTrackResult>;

  cancelShipment(input: CancelShipmentInput): Promise<CourierCancelResult>;
}
