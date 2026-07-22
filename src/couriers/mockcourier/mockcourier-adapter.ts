import type {
  CancelShipmentInput,
  CourierCancelResult,
  CourierCreateResult,
  CourierTrackResult,
  CreateOrderRequest,
  TrackShipmentInput
} from '../../domain/contracts.js';
import type { CourierAdapter } from '../courier-adapter.js';

export const MOCK_COURIER_PARTNER = 'mockcourier';

export class MockCourierAdapter implements CourierAdapter {
  readonly courierPartner = MOCK_COURIER_PARTNER;

  async createShipment(request: CreateOrderRequest): Promise<CourierCreateResult> {
    const trackingNumber = `MOCK-TRK-${request.order_id}`;
    const courierOrderId = `MOCK-ORD-${request.order_id}`;
    const rawRequest = { provider: 'mockcourier', action: 'create', request };
    const rawResponse = { status: 'SUCCESS', tracking_number: trackingNumber, courier_order_id: courierOrderId };

    return {
      response: {
        order_id: request.order_id,
        courier_partner: this.courierPartner,
        courier_order_id: courierOrderId,
        tracking_number: trackingNumber,
        status: 'CREATED'
      },
      raw_request: rawRequest,
      raw_response: rawResponse
    };
  }

  async trackShipment(input: TrackShipmentInput): Promise<CourierTrackResult> {
    const rawRequest = { provider: 'mockcourier', action: 'track', input };
    const rawResponse = { status: 'SUCCESS', tracking_number: input.tracking_number };
    const now = new Date().toISOString();

    return {
      response: {
        order_id: input.tracking_number.replace(/^MOCK-TRK-/, ''),
        courier_partner: this.courierPartner,
        tracking_number: input.tracking_number,
        status: 'IN_TRANSIT',
        status_updated_at: now,
        events: [
          {
            status: 'CREATED',
            status_at: now,
            description: 'Shipment created at MockCourier hub'
          },
          {
            status: 'IN_TRANSIT',
            status_at: now,
            location: 'Central Mock Hub',
            description: 'In transit'
          }
        ]
      },
      raw_response: rawResponse
    };
  }

  async cancelShipment(input: CancelShipmentInput): Promise<CourierCancelResult> {
    const rawRequest = { provider: 'mockcourier', action: 'cancel', input };
    const rawResponse = { status: 'SUCCESS', message: 'Cancelled' };

    return {
      response: {
        order_id: input.tracking_number.replace(/^MOCK-TRK-/, ''),
        courier_partner: this.courierPartner,
        tracking_number: input.tracking_number,
        status: 'CANCELLED'
      },
      raw_response: rawResponse
    };
  }
}
