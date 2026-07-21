import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import type { CancelOrderResponse } from '../src/domain/contracts.js';
import {
  CourierRejectedError,
  CourierUnavailableError,
  OrderNotFoundError,
  ValidationError
} from '../src/errors/application-error.js';
import type { createOrderService } from '../src/services/order-service.js';

type OrderService = ReturnType<typeof createOrderService>;

const sampleCancelResponse: CancelOrderResponse = {
  order_id: 'ORD-8008',
  courier_partner: 'urbanebolt',
  tracking_number: 'UB-8008-AWB',
  status: 'CANCELLED'
};

describe('POST /api/v1/orders/:order_id/cancel endpoint (P6-T2)', () => {
  it('returns 200 OK with normalized cancel response on successful cancellation', async () => {
    const mockOrderService: Partial<OrderService> = {
      cancelOrder: vi.fn().mockResolvedValue(sampleCancelResponse)
    };

    const app = createApp({ orderService: mockOrderService as OrderService });

    const response = await request(app)
      .post('/api/v1/orders/ORD-8008/cancel')
      .expect(200);

    expect(mockOrderService.cancelOrder).toHaveBeenCalledWith('ORD-8008');
    expect(response.body).toEqual(sampleCancelResponse);
  });

  it('returns 200 OK on repeated cancellation of an already-cancelled order (idempotent no-op)', async () => {
    const mockOrderService: Partial<OrderService> = {
      cancelOrder: vi.fn().mockResolvedValue(sampleCancelResponse)
    };

    const app = createApp({ orderService: mockOrderService as OrderService });

    const response1 = await request(app)
      .post('/api/v1/orders/ORD-8008/cancel')
      .expect(200);

    const response2 = await request(app)
      .post('/api/v1/orders/ORD-8008/cancel')
      .expect(200);

    expect(response1.body).toEqual(sampleCancelResponse);
    expect(response2.body).toEqual(sampleCancelResponse);
    expect(mockOrderService.cancelOrder).toHaveBeenCalledTimes(2);
  });

  it('returns 404 Not Found with ORDER_NOT_FOUND when order does not exist or is soft-deleted', async () => {
    const mockOrderService: Partial<OrderService> = {
      cancelOrder: vi.fn().mockRejectedValue(new OrderNotFoundError('ORD-UNKNOWN'))
    };

    const app = createApp({ orderService: mockOrderService as OrderService });

    const response = await request(app)
      .post('/api/v1/orders/ORD-UNKNOWN/cancel')
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
      cancelOrder: vi.fn().mockRejectedValue(
        new ValidationError([
          { field: 'tracking_number', message: "Order 'ORD-NOTRACK' does not have a tracking number to cancel" }
        ])
      )
    };

    const app = createApp({ orderService: mockOrderService as OrderService });

    const response = await request(app)
      .post('/api/v1/orders/ORD-NOTRACK/cancel')
      .expect(400);

    expect(response.body).toMatchObject({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: [
          { field: 'tracking_number', message: "Order 'ORD-NOTRACK' does not have a tracking number to cancel" }
        ],
        request_id: expect.any(String)
      }
    });
  });

  it('returns 422 Unprocessable Entity with COURIER_REJECTED when courier rejects cancellation', async () => {
    const mockOrderService: Partial<OrderService> = {
      cancelOrder: vi.fn().mockRejectedValue(new CourierRejectedError())
    };

    const app = createApp({ orderService: mockOrderService as OrderService });

    const response = await request(app)
      .post('/api/v1/orders/ORD-8008/cancel')
      .expect(422);

    expect(response.body).toMatchObject({
      error: {
        code: 'COURIER_REJECTED',
        message: 'The courier partner rejected the order request',
        request_id: expect.any(String)
      }
    });
  });

  it('returns 503 Service Unavailable with COURIER_UNAVAILABLE when courier service is unavailable', async () => {
    const mockOrderService: Partial<OrderService> = {
      cancelOrder: vi.fn().mockRejectedValue(new CourierUnavailableError())
    };

    const app = createApp({ orderService: mockOrderService as OrderService });

    const response = await request(app)
      .post('/api/v1/orders/ORD-8008/cancel')
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
