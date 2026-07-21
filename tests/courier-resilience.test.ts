import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import type { CourierAdapter } from '../src/couriers/courier-adapter.js';
import { createCourierRegistry } from '../src/couriers/courier-registry.js';
import { CourierProviderError } from '../src/couriers/courier-adapter.js';
import { db } from '../src/db/knex.js';
import { createOrderRepository } from '../src/db/repositories/order-repository.js';
import { createTrackingHistoryRepository } from '../src/db/repositories/tracking-history-repository.js';
import type { CreateOrderRequest } from '../src/domain/contracts.js';
import { createOrderService } from '../src/services/order-service.js';

const sampleRequest: CreateOrderRequest = {
  order_id: 'RESILIENCE-INT-500',
  courier_partner: 'urbanebolt',
  service_type: 'express',
  sender: {
    name: 'Sender Co',
    phone: '+919999999999',
    street: '1 First St',
    city: 'Delhi',
    state: 'Delhi',
    country: 'IN',
    postal_code: '110001'
  },
  recipient: {
    name: 'Receiver Co',
    phone: '+918888888888',
    street: '2 Second St',
    city: 'Mumbai',
    state: 'Maharashtra',
    country: 'IN',
    postal_code: '400001'
  },
  package: {
    description: 'Resilience Test Box',
    pieces: 1,
    weight: 2.5
  },
  payment: {
    mode: 'PREPAID'
  }
};

async function cleanupTestData(): Promise<void> {
  const testOrders = await db('orders')
    .select('id')
    .where('merchant_order_id', 'like', 'RESILIENCE-INT-%');

  const orderIds = testOrders.map((o) => o.id);

  if (orderIds.length > 0) {
    await db('tracking_history').whereIn('order_id', orderIds).delete();
    await db('orders').whereIn('id', orderIds).delete();
  }
}

describe('Courier Resilience & Error Normalization Behavior (P7-T5)', () => {
  let mockAdapter: CourierAdapter;

  beforeAll(async () => {
    await cleanupTestData();
  });

  beforeEach(async () => {
    await cleanupTestData();
  });

  afterEach(async () => {
    await cleanupTestData();
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  function createTestApp() {
    mockAdapter = {
      courierPartner: 'urbanebolt',
      createShipment: vi.fn(),
      trackShipment: vi.fn(),
      cancelShipment: vi.fn()
    };

    const registry = createCourierRegistry([mockAdapter]);
    const orderRepo = createOrderRepository(db);
    const historyRepo = createTrackingHistoryRepository(db);
    const service = createOrderService(orderRepo, historyRepo, registry, db);

    return createApp({ orderService: service });
  }

  it('maps 4xx provider rejection to HTTP 422 COURIER_REJECTED with normalized error envelope on create, track, and cancel', async () => {
    const app = createTestApp();

    // 1. Create order 4xx rejection
    (mockAdapter.createShipment as any).mockRejectedValueOnce(
      new CourierProviderError({
        operation: 'create',
        kind: 'client',
        message: 'Invalid destination address',
        retryable: false,
        statusCode: 400
      })
    );

    const createRes = await request(app)
      .post('/api/v1/orders')
      .send(sampleRequest)
      .expect(422);

    expect(createRes.body).toMatchObject({
      error: {
        code: 'COURIER_REJECTED',
        message: 'The courier partner rejected the order request',
        details: [],
        request_id: expect.any(String)
      }
    });

    // Seed valid order in DB for track/cancel tests with unique order ID
    const trackOrderId = 'RESILIENCE-INT-501';
    await db('orders').insert({
      merchant_order_id: trackOrderId,
      courier_partner: 'urbanebolt',
      courier_order_id: 'UB-RES-501',
      tracking_number: 'AWB-RES-501',
      status: 'CREATED',
      normalized_request: { ...sampleRequest, order_id: trackOrderId },
      is_deleted: false
    });

    // 2. Track order 4xx rejection
    (mockAdapter.trackShipment as any).mockRejectedValueOnce(
      new CourierProviderError({
        operation: 'track',
        kind: 'client',
        message: 'Invalid AWB format',
        retryable: false,
        statusCode: 400
      })
    );

    const trackRes = await request(app)
      .get(`/api/v1/orders/${trackOrderId}/track`)
      .expect(422);

    expect(trackRes.body).toMatchObject({
      error: {
        code: 'COURIER_REJECTED',
        message: 'The courier partner rejected the order request',
        request_id: expect.any(String)
      }
    });

    // 3. Cancel order 4xx rejection
    (mockAdapter.cancelShipment as any).mockRejectedValueOnce(
      new CourierProviderError({
        operation: 'cancel',
        kind: 'client',
        message: 'Order cannot be cancelled in current state',
        retryable: false,
        statusCode: 422
      })
    );

    const cancelRes = await request(app)
      .post(`/api/v1/orders/${trackOrderId}/cancel`)
      .expect(422);

    expect(cancelRes.body).toMatchObject({
      error: {
        code: 'COURIER_REJECTED',
        message: 'The courier partner rejected the order request',
        request_id: expect.any(String)
      }
    });
  });

  it('maps 5xx retry exhaustion to HTTP 503 COURIER_UNAVAILABLE across public endpoints', async () => {
    const app = createTestApp();

    (mockAdapter.createShipment as any).mockRejectedValueOnce(
      new CourierProviderError({
        operation: 'create',
        kind: 'server',
        message: 'Internal server error 503',
        retryable: true,
        statusCode: 503
      })
    );

    const res = await request(app)
      .post('/api/v1/orders')
      .send(sampleRequest)
      .expect(503);

    expect(res.body).toMatchObject({
      error: {
        code: 'COURIER_UNAVAILABLE',
        message: 'Courier partner is temporarily unavailable',
        request_id: expect.any(String)
      }
    });
  });

  it('maps timeout exhaustion and network failures to HTTP 503 COURIER_UNAVAILABLE', async () => {
    const app = createTestApp();

    // Timeout failure
    (mockAdapter.createShipment as any).mockRejectedValueOnce(
      new CourierProviderError({
        operation: 'create',
        kind: 'timeout',
        message: 'Courier request timed out',
        retryable: true
      })
    );

    const timeoutRes = await request(app)
      .post('/api/v1/orders')
      .send(sampleRequest)
      .expect(503);

    expect(timeoutRes.body.error.code).toBe('COURIER_UNAVAILABLE');

    // Network failure
    const sampleRequestNetwork = { ...sampleRequest, order_id: 'RESILIENCE-INT-502' };
    (mockAdapter.createShipment as any).mockRejectedValueOnce(
      new CourierProviderError({
        operation: 'create',
        kind: 'network',
        message: 'Network socket failure',
        retryable: true
      })
    );

    const networkRes = await request(app)
      .post('/api/v1/orders')
      .send(sampleRequestNetwork)
      .expect(503);

    expect(networkRes.body.error.code).toBe('COURIER_UNAVAILABLE');
  });

  it('handles uncertain create failure by storing FAILED state and preventing duplicate remote shipment on public retry', async () => {
    const app = createTestApp();

    // Initial attempt times out
    (mockAdapter.createShipment as any).mockRejectedValueOnce(
      new CourierProviderError({
        operation: 'create',
        kind: 'timeout',
        message: 'Gateway Timeout 504',
        retryable: true,
        statusCode: 504
      })
    );

    await request(app)
      .post('/api/v1/orders')
      .send(sampleRequest)
      .expect(503);

    // Verify DB stored FAILED status
    const orderInDb = await db('orders').where('merchant_order_id', sampleRequest.order_id).first();
    expect(orderInDb.status).toBe('FAILED');

    // Resubmitting identical order request returns stored COURIER_UNAVAILABLE without extra courier shipment call
    const retryRes = await request(app)
      .post('/api/v1/orders')
      .send(sampleRequest)
      .expect(503);

    expect(retryRes.body.error.code).toBe('COURIER_UNAVAILABLE');
    expect(mockAdapter.createShipment).toHaveBeenCalledTimes(1);
  });
});
