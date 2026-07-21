import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import type { TrackOrderResponse } from '../src/domain/contracts.js';
import {
  OrderNotFoundError,
  ValidationError,
  CourierUnavailableError
} from '../src/errors/application-error.js';
import type { createOrderService } from '../src/services/order-service.js';

type OrderService = ReturnType<typeof createOrderService>;

const sampleTrackResponse: TrackOrderResponse = {
  order_id: 'ORD-7007',
  courier_partner: 'urbanebolt',
  tracking_number: 'UB-7007-AWB',
  status: 'IN_TRANSIT',
  status_updated_at: '2026-07-21T12:00:00.000Z',
  events: [
    {
      status: 'CREATED',
      status_at: '2026-07-21T10:00:00.000Z',
      description: 'Shipment created'
    },
    {
      status: 'IN_TRANSIT',
      status_at: '2026-07-21T12:00:00.000Z',
      location: 'Hub North',
      description: 'In transit to destination'
    }
  ]
};

describe('GET /api/v1/orders/:order_id/track endpoint (P5-T2)', () => {
  it('returns 200 OK with normalized track response on successful tracking', async () => {
    const mockOrderService: Partial<OrderService> = {
      trackOrder: vi.fn().mockResolvedValue(sampleTrackResponse)
    };

    const app = createApp({ orderService: mockOrderService as OrderService });

    const response = await request(app)
      .get('/api/v1/orders/ORD-7007/track')
      .expect(200);

    expect(mockOrderService.trackOrder).toHaveBeenCalledWith('ORD-7007');
    expect(response.body).toEqual(sampleTrackResponse);
  });

  it('returns 404 Not Found with ORDER_NOT_FOUND when order does not exist or is soft-deleted', async () => {
    const mockOrderService: Partial<OrderService> = {
      trackOrder: vi.fn().mockRejectedValue(new OrderNotFoundError('ORD-UNKNOWN'))
    };

    const app = createApp({ orderService: mockOrderService as OrderService });

    const response = await request(app)
      .get('/api/v1/orders/ORD-UNKNOWN/track')
      .expect(404);

    expect(response.body).toMatchObject({
      error: {
        code: 'ORDER_NOT_FOUND',
        message: "Order 'ORD-UNKNOWN' was not found",
        request_id: expect.any(String)
      }
    });
  });

  it('returns 400 Bad Request with VALIDATION_ERROR when order has no tracking_number', async () => {
    const mockOrderService: Partial<OrderService> = {
      trackOrder: vi.fn().mockRejectedValue(
        new ValidationError([
          { field: 'tracking_number', message: "Order 'ORD-NOTRACK' does not have a tracking number to track" }
        ])
      )
    };

    const app = createApp({ orderService: mockOrderService as OrderService });

    const response = await request(app)
      .get('/api/v1/orders/ORD-NOTRACK/track')
      .expect(400);

    expect(response.body).toMatchObject({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: [
          { field: 'tracking_number', message: "Order 'ORD-NOTRACK' does not have a tracking number to track" }
        ],
        request_id: expect.any(String)
      }
    });
  });

  it('returns 503 Service Unavailable when courier is unavailable', async () => {
    const mockOrderService: Partial<OrderService> = {
      trackOrder: vi.fn().mockRejectedValue(new CourierUnavailableError())
    };

    const app = createApp({ orderService: mockOrderService as OrderService });

    const response = await request(app)
      .get('/api/v1/orders/ORD-7007/track')
      .expect(503);

    expect(response.body).toMatchObject({
      error: {
        code: 'COURIER_UNAVAILABLE',
        message: 'Courier partner is temporarily unavailable',
        request_id: expect.any(String)
      }
    });
  });
});
