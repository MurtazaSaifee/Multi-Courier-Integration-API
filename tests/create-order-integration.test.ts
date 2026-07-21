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
  order_id: 'INT-TEST-1001',
  courier_partner: 'urbanebolt',
  service_type: 'express',
  sender: {
    name: 'Logistics Hub',
    phone: '+911111111111',
    street: '1 Depot Rd',
    city: 'Mumbai',
    state: 'Maharashtra',
    country: 'IN',
    postal_code: '400001'
  },
  recipient: {
    name: 'Alice Johnson',
    phone: '+917777777777',
    street: '15 Ocean Drive',
    city: 'Chennai',
    state: 'Tamil Nadu',
    country: 'IN',
    postal_code: '600001'
  },
  package: {
    description: 'Apparel & Goods',
    pieces: 3,
    weight: 1.8
  },
  payment: {
    mode: 'PREPAID'
  }
};

async function cleanupTestData(): Promise<void> {
  const testOrders = await db('orders')
    .select('id')
    .where('merchant_order_id', 'like', 'INT-TEST-%');

  const orderIds = testOrders.map((o) => o.id);

  if (orderIds.length > 0) {
    await db('tracking_history').whereIn('order_id', orderIds).delete();
    await db('orders').whereIn('id', orderIds).delete();
  }
}

describe('PostgreSQL Order Creation & Persistence Integration (P4-T4)', () => {
  let mockAdapter: CourierAdapter;

  beforeAll(async () => {
    await db.migrate.latest();
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
    await db.destroy();
  });

  it('persists successful creation, returns 201 Created, and stores history in PostgreSQL', async () => {
    const mockCreateShipment = vi.fn().mockResolvedValue({
      response: {
        order_id: 'INT-TEST-1001',
        courier_partner: 'urbanebolt',
        courier_order_id: 'UB-INT-1001',
        tracking_number: 'AWB-INT-1001',
        status: 'CREATED'
      },
      raw_request: [{ manifestItem: 1 }],
      raw_response: { successResponse: [{ orderNumber: 'UB-INT-1001' }] }
    });

    mockAdapter = {
      courierPartner: 'urbanebolt',
      createShipment: mockCreateShipment,
      trackShipment: vi.fn(),
      cancelShipment: vi.fn()
    };

    const registry = createCourierRegistry([mockAdapter]);
    const orderService = createOrderService(
      createOrderRepository(db),
      createTrackingHistoryRepository(db),
      registry
    );

    const app = createApp({ orderService });

    const httpResponse = await request(app)
      .post('/api/v1/orders')
      .send(sampleRequest);

    expect(httpResponse.status).toBe(201);
    expect(httpResponse.body).toEqual({
      order_id: 'INT-TEST-1001',
      courier_partner: 'urbanebolt',
      courier_order_id: 'UB-INT-1001',
      tracking_number: 'AWB-INT-1001',
      status: 'CREATED'
    });

    // Verify orders database record
    const dbOrder = await db('orders').where('merchant_order_id', 'INT-TEST-1001').first();
    expect(dbOrder).toBeDefined();
    expect(dbOrder.status).toBe('CREATED');
    expect(dbOrder.courier_order_id).toBe('UB-INT-1001');
    expect(dbOrder.tracking_number).toBe('AWB-INT-1001');
    expect(dbOrder.courier_request_payload).toEqual([{ manifestItem: 1 }]);
    expect(dbOrder.courier_response_payload).toEqual({ successResponse: [{ orderNumber: 'UB-INT-1001' }] });

    // Verify tracking_history database record
    const dbHistory = await db('tracking_history').where('order_id', dbOrder.id);
    expect(dbHistory).toHaveLength(1);
    expect(dbHistory[0].status).toBe('CREATED');
    expect(dbHistory[0].raw_payload).toEqual({ successResponse: [{ orderNumber: 'UB-INT-1001' }] });
  });

  it('handles duplicate identical request idempotently without invoking courier adapter again', async () => {
    const mockCreateShipment = vi.fn().mockResolvedValue({
      response: {
        order_id: 'INT-TEST-1001',
        courier_partner: 'urbanebolt',
        courier_order_id: 'UB-INT-1001',
        tracking_number: 'AWB-INT-1001',
        status: 'CREATED'
      },
      raw_request: {},
      raw_response: {}
    });

    mockAdapter = {
      courierPartner: 'urbanebolt',
      createShipment: mockCreateShipment,
      trackShipment: vi.fn(),
      cancelShipment: vi.fn()
    };

    const registry = createCourierRegistry([mockAdapter]);
    const orderService = createOrderService(
      createOrderRepository(db),
      createTrackingHistoryRepository(db),
      registry
    );

    const app = createApp({ orderService });

    // Initial creation
    const res1 = await request(app).post('/api/v1/orders').send(sampleRequest);
    expect(res1.status).toBe(201);
    expect(mockCreateShipment).toHaveBeenCalledTimes(1);

    // Repeated identical request
    const res2 = await request(app).post('/api/v1/orders').send(sampleRequest);
    expect(res2.status).toBe(201);
    expect(res2.body).toEqual({
      order_id: 'INT-TEST-1001',
      courier_partner: 'urbanebolt',
      courier_order_id: 'UB-INT-1001',
      tracking_number: 'AWB-INT-1001',
      status: 'CREATED'
    });
    expect(mockCreateShipment).toHaveBeenCalledTimes(1);
  });

  it('returns 409 ORDER_ID_CONFLICT when reusing merchant_order_id with different payload', async () => {
    const mockCreateShipment = vi.fn().mockResolvedValue({
      response: {
        order_id: 'INT-TEST-1001',
        courier_partner: 'urbanebolt',
        courier_order_id: 'UB-INT-1001',
        tracking_number: 'AWB-INT-1001',
        status: 'CREATED'
      },
      raw_request: {},
      raw_response: {}
    });

    mockAdapter = {
      courierPartner: 'urbanebolt',
      createShipment: mockCreateShipment,
      trackShipment: vi.fn(),
      cancelShipment: vi.fn()
    };

    const registry = createCourierRegistry([mockAdapter]);
    const orderService = createOrderService(
      createOrderRepository(db),
      createTrackingHistoryRepository(db),
      registry
    );

    const app = createApp({ orderService });

    await request(app).post('/api/v1/orders').send(sampleRequest);

    // Modified payload
    const conflictingRequest = {
      ...sampleRequest,
      package: { description: 'Heavy Machinery', pieces: 10, weight: 50.0 }
    };

    const resConflict = await request(app).post('/api/v1/orders').send(conflictingRequest);
    expect(resConflict.status).toBe(409);
    expect(resConflict.body.error.code).toBe('ORDER_ID_CONFLICT');
  });

  it('returns 409 ORDER_IN_PROGRESS when attempting to create an order currently PENDING', async () => {
    mockAdapter = {
      courierPartner: 'urbanebolt',
      createShipment: vi.fn(),
      trackShipment: vi.fn(),
      cancelShipment: vi.fn()
    };

    const registry = createCourierRegistry([mockAdapter]);
    const orderService = createOrderService(
      createOrderRepository(db),
      createTrackingHistoryRepository(db),
      registry
    );

    const app = createApp({ orderService });

    // Manually insert a PENDING row
    await db('orders').insert({
      merchant_order_id: 'INT-TEST-1001',
      courier_partner: 'urbanebolt',
      status: 'PENDING',
      normalized_request: sampleRequest,
      is_deleted: false
    });

    const resPending = await request(app).post('/api/v1/orders').send(sampleRequest);
    expect(resPending.status).toBe(409);
    expect(resPending.body.error.code).toBe('ORDER_IN_PROGRESS');
  });

  it('persists a graceful FAILED state in PostgreSQL when courier rejects call', async () => {
    const providerError = new CourierProviderError({
      operation: 'create',
      kind: 'client',
      message: 'Address unserviceable by courier',
      retryable: false,
      rawRequestPayload: { payload: 'sent' },
      rawResponsePayload: { error: 'Address unserviceable' }
    });

    const mockCreateShipment = vi.fn().mockRejectedValue(providerError);

    mockAdapter = {
      courierPartner: 'urbanebolt',
      createShipment: mockCreateShipment,
      trackShipment: vi.fn(),
      cancelShipment: vi.fn()
    };

    const registry = createCourierRegistry([mockAdapter]);
    const orderService = createOrderService(
      createOrderRepository(db),
      createTrackingHistoryRepository(db),
      registry
    );

    const app = createApp({ orderService });

    const resFail = await request(app).post('/api/v1/orders').send(sampleRequest);
    expect(resFail.status).toBe(422);
    expect(resFail.body.error.code).toBe('COURIER_REJECTED');

    // Check PostgreSQL database persistence of failure
    const dbOrder = await db('orders').where('merchant_order_id', 'INT-TEST-1001').first();
    expect(dbOrder).toBeDefined();
    expect(dbOrder.status).toBe('FAILED');
    expect(dbOrder.failure_code).toBe('CLIENT');
    expect(dbOrder.failure_message).toBe('Address unserviceable by courier');
    expect(dbOrder.courier_request_payload).toEqual({ payload: 'sent' });
    expect(dbOrder.courier_response_payload).toEqual({ error: 'Address unserviceable' });

    // Check tracking_history persistence of failure event
    const dbHistory = await db('tracking_history').where('order_id', dbOrder.id);
    expect(dbHistory).toHaveLength(1);
    expect(dbHistory[0].status).toBe('FAILED');
  });

  it('handles re-submission of a stored failed order without invoking courier adapter', async () => {
    const providerError = new CourierProviderError({
      operation: 'create',
      kind: 'client',
      message: 'Service unavailable for pincode',
      retryable: false
    });

    const mockCreateShipment = vi.fn().mockRejectedValue(providerError);

    mockAdapter = {
      courierPartner: 'urbanebolt',
      createShipment: mockCreateShipment,
      trackShipment: vi.fn(),
      cancelShipment: vi.fn()
    };

    const registry = createCourierRegistry([mockAdapter]);
    const orderService = createOrderService(
      createOrderRepository(db),
      createTrackingHistoryRepository(db),
      registry
    );

    const app = createApp({ orderService });

    // Initial failed attempt
    const res1 = await request(app).post('/api/v1/orders').send(sampleRequest);
    expect(res1.status).toBe(422);
    expect(mockCreateShipment).toHaveBeenCalledTimes(1);

    // Re-submission of stored failed order
    const res2 = await request(app).post('/api/v1/orders').send(sampleRequest);
    expect(res2.status).toBe(422);
    expect(res2.body.error.code).toBe('COURIER_REJECTED');
    expect(mockCreateShipment).toHaveBeenCalledTimes(1);
  });
});
