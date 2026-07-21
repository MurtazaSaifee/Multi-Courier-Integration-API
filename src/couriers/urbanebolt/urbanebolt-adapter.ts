import type {
  CancelShipmentInput,
  CourierCancelResult,
  CourierCreateResult,
  CourierTrackResult,
  CreateOrderRequest,
  TrackShipmentInput
} from '../../domain/contracts.js';
import {
  CourierProviderError,
  type CourierAdapter,
  type CourierOperation
} from '../courier-adapter.js';

export const URBANEBOLT_COURIER_PARTNER = 'urbanebolt';

function operationNotImplemented(operation: CourierOperation): CourierProviderError {
  return new CourierProviderError({
    operation,
    kind: 'not_implemented',
    message: `UrbaneBolt ${operation} operation is not implemented`,
    retryable: false
  });
}

/** Provider-specific implementation boundary; operations are added in later Phase 3 tasks. */
export class UrbaneBoltAdapter implements CourierAdapter {
  readonly courierPartner = URBANEBOLT_COURIER_PARTNER;

  async createShipment(_request: CreateOrderRequest): Promise<CourierCreateResult> {
    throw operationNotImplemented('create');
  }

  async trackShipment(_input: TrackShipmentInput): Promise<CourierTrackResult> {
    throw operationNotImplemented('track');
  }

  async cancelShipment(_input: CancelShipmentInput): Promise<CourierCancelResult> {
    throw operationNotImplemented('cancel');
  }
}
