import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import type { CreateOrderRequest } from '../src/domain/contracts.js';
import {
  CourierRejectedError,
  CourierUnavailableError
} from '../src/errors/application-error.js';
import type { createOrderService } from '../src/services/order-service.js';

type OrderService = ReturnType<typeof createOrderService>;

const sampleOrder = (id: string, courier = 'urbanebolt'): CreateOrderRequest => ({
  order_id: id,
  courier_partner: courier,
  service_type: 'express',
  sender: {
    name: 'Sender Corp',
    phone: '+911111111111',
    street: '1 Hub Road',
    city: 'Mumbai',
    state: 'Maharashtra',
    country: 'IN',
    postal_code: '400001'
  },
  recipient: {
    name: 'Jane Smith',
    phone: '+919999999999',
    street: '10 Destination St',
    city: 'Bangalore',
    state: 'Karnataka',
    country: 'IN',
    postal_code: '560001'
  },
  package: {
    description: 'Gadgets',
    pieces: 1,
    weight: 1.5
  },
  payment: {
    mode: 'prepaid'
  }
});

describe('POST /api/v1/orders/bulk endpoint (P8-T3)', () => {
  it('returns HTTP 200 OK with processed batch response when orders succeed', async () => {
    const mockOrderService: Partial<OrderService> = {
      createBulkOrders: vi.fn().mockResolvedValue({
        results: [
          {
            order_id: 'BULK-1',
            success: true,
            result: {
              order_id: 'BULK-1',
              courier_partner: 'urbanebolt',
              courier_order_id: 'UB-1',
              tracking_number: 'AWB-1',
              status: 'CREATED'
            }
          },
          {
            order_id: 'BULK-2',
            success: true,
            result: {
              order_id: 'BULK-2',
              courier_partner: 'urbanebolt',
              courier_order_id: 'UB-2',
              tracking_number: 'AWB-2',
              status: 'CREATED'
            }
          }
        ]
      })
    };

    const app = createApp({ orderService: mockOrderService as OrderService });

    const response = await request(app)
      .post('/api/v1/orders/bulk')
      .set('x-request-id', 'test-req-123')
      .send([sampleOrder('BULK-1'), sampleOrder('BULK-2')]);

    expect(response.status).toBe(200);
    expect(response.headers['x-request-id']).toBe('test-req-123');
    expect(response.body).toEqual({
      results: [
        {
          order_id: 'BULK-1',
          success: true,
          result: {
            order_id: 'BULK-1',
            courier_partner: 'urbanebolt',
            courier_order_id: 'UB-1',
            tracking_number: 'AWB-1',
            status: 'CREATED'
          }
        },
        {
          order_id: 'BULK-2',
          success: true,
          result: {
            order_id: 'BULK-2',
            courier_partner: 'urbanebolt',
            courier_order_id: 'UB-2',
            tracking_number: 'AWB-2',
            status: 'CREATED'
          }
        }
      ]
    });
  });

  it('returns HTTP 200 OK with partial success results when individual items fail', async () => {
    const mockOrderService: Partial<OrderService> = {
      createBulkOrders: vi.fn().mockResolvedValue({
        results: [
          {
            order_id: 'BULK-1',
            success: true,
            result: {
              order_id: 'BULK-1',
              courier_partner: 'urbanebolt',
              courier_order_id: 'UB-1',
              tracking_number: 'AWB-1',
              status: 'CREATED'
            }
          },
          {
            order_id: 'BULK-2',
            success: false,
            error: {
              code: 'COURIER_REJECTED',
              message: 'Address not serviceable',
              details: [],
              request_id: 'test-req-456'
            }
          }
        ]
      })
    };

    const app = createApp({ orderService: mockOrderService as OrderService });

    const response = await request(app)
      .post('/api/v1/orders/bulk')
      .set('x-request-id', 'test-req-456')
      .send([sampleOrder('BULK-1'), sampleOrder('BULK-2')]);

    expect(response.status).toBe(200);
    expect(response.body.results).toHaveLength(2);
    expect(response.body.results[0].success).toBe(true);
    expect(response.body.results[1].success).toBe(false);
    expect(response.body.results[1].error.code).toBe('COURIER_REJECTED');
  });

  it('returns HTTP 400 Bad Request when bulk request payload is not an array', async () => {
    const app = createApp();

    const response = await request(app)
      .post('/api/v1/orders/bulk')
      .send({ invalid: 'payload' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.details).toEqual([
      { field: 'request', message: 'Bulk request body must be an array of order items' }
    ]);
  });

  it('returns HTTP 400 Bad Request when bulk request payload has > 100 items', async () => {
    const app = createApp();

    const oversizedArray = Array.from({ length: 101 }, (_, i) => sampleOrder(`ORD-${i}`));

    const response = await request(app)
      .post('/api/v1/orders/bulk')
      .send(oversizedArray);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.details).toEqual([
      { field: 'request', message: 'Bulk request cannot exceed 100 orders' }
    ]);
  });
});
