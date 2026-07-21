import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import type { CourierAdapter } from '../src/couriers/courier-adapter.js';
import { CourierProviderError } from '../src/couriers/courier-adapter.js';
import { createCourierRegistry } from '../src/couriers/courier-registry.js';
import { db } from '../src/db/knex.js';
import { createOrderRepository } from '../src/db/repositories/order-repository.js';
import { createTrackingHistoryRepository } from '../src/db/repositories/tracking-history-repository.js';
import type { CreateOrderRequest } from '../src/domain/contracts.js';
import { createOrderService } from '../src/services/order-service.js';

const sampleOrder = (id: string, courier = 'urbanebolt'): CreateOrderRequest => ({
  order_id: id,
  courier_partner: courier,
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
});

async function cleanupTestData(): Promise<void> {
  const testOrders = await db('orders')
    .select('id')
    .where('merchant_order_id', 'like', 'INT-BULK-%');

  const orderIds = testOrders.map((o) => o.id);

  if (orderIds.length > 0) {
    await db('tracking_history').whereIn('order_id', orderIds).delete();
    await db('orders').whereIn('id', orderIds).delete();
  }
}

describe('Full Bulk Order Processing Integration (P8-T4)', () => {
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

  it('processes a full batch of 100 orders concurrently and persists all 100 in PostgreSQL', async () => {
    const mockUrbaneboltAdapter: CourierAdapter = {
      courierPartner: 'urbanebolt',
      createShipment: vi.fn().mockImplementation(async (req: CreateOrderRequest) => ({
        response: {
          order_id: req.order_id,
          courier_partner: 'urbanebolt',
          courier_order_id: 'UB-' + req.order_id,
          tracking_number: 'AWB-' + req.order_id,
          status: 'CREATED'
        },
        raw_request: { req },
        raw_response: { status: 'Success' }
      })),
      trackShipment: vi.fn(),
      cancelShipment: vi.fn()
    };

    const registry = createCourierRegistry([mockUrbaneboltAdapter]);
    const orderService = createOrderService(
      createOrderRepository(db),
      createTrackingHistoryRepository(db),
      registry
    );

    const app = createApp({ orderService });

    const batch = Array.from({ length: 100 }, (_, index) =>
      sampleOrder(`INT-BULK-100-${index + 1}`)
    );

    const httpResponse = await request(app)
      .post('/api/v1/orders/bulk')
      .send(batch);

    expect(httpResponse.status).toBe(200);
    expect(httpResponse.body.results).toHaveLength(100);
    expect(httpResponse.body.results.every((r: any) => r.success)).toBe(true);

    // Verify 100 orders exist in PostgreSQL
    const dbOrders = await db('orders')
      .where('merchant_order_id', 'like', 'INT-BULK-100-%');
    expect(dbOrders).toHaveLength(100);
  });

  it('handles mixed couriers in the same bulk request', async () => {
    const mockUrbaneboltAdapter: CourierAdapter = {
      courierPartner: 'urbanebolt',
      createShipment: vi.fn().mockImplementation(async (req: CreateOrderRequest) => ({
        response: {
          order_id: req.order_id,
          courier_partner: 'urbanebolt',
          courier_order_id: 'UB-' + req.order_id,
          tracking_number: 'AWB-' + req.order_id,
          status: 'CREATED'
        },
        raw_request: {},
        raw_response: {}
      })),
      trackShipment: vi.fn(),
      cancelShipment: vi.fn()
    };

    const mockDelhiveryAdapter: CourierAdapter = {
      courierPartner: 'delhivery',
      createShipment: vi.fn().mockImplementation(async (req: CreateOrderRequest) => ({
        response: {
          order_id: req.order_id,
          courier_partner: 'delhivery',
          courier_order_id: 'DEL-' + req.order_id,
          tracking_number: 'DELAWB-' + req.order_id,
          status: 'CREATED'
        },
        raw_request: {},
        raw_response: {}
      })),
      trackShipment: vi.fn(),
      cancelShipment: vi.fn()
    };

    const registry = createCourierRegistry([mockUrbaneboltAdapter, mockDelhiveryAdapter]);
    const orderService = createOrderService(
      createOrderRepository(db),
      createTrackingHistoryRepository(db),
      registry
    );

    const app = createApp({ orderService });

    const batch = [
      sampleOrder('INT-BULK-MIXED-1', 'urbanebolt'),
      sampleOrder('INT-BULK-MIXED-2', 'delhivery')
    ];

    const httpResponse = await request(app)
      .post('/api/v1/orders/bulk')
      .send(batch);

    expect(httpResponse.status).toBe(200);
    expect(httpResponse.body.results).toHaveLength(2);
    expect(httpResponse.body.results[0].result.courier_partner).toBe('urbanebolt');
    expect(httpResponse.body.results[1].result.courier_partner).toBe('delhivery');
  });

  it('handles partial success when individual orders fail during courier call or validation', async () => {
    const mockAdapter: CourierAdapter = {
      courierPartner: 'urbanebolt',
      createShipment: vi.fn().mockImplementation(async (req: CreateOrderRequest) => {
        if (req.order_id === 'INT-BULK-PARTIAL-FAIL') {
          throw new CourierProviderError({
            operation: 'create',
            kind: 'client',
            message: 'Unserviceable pincode',
            retryable: false
          });
        }
        return {
          response: {
            order_id: req.order_id,
            courier_partner: 'urbanebolt',
            courier_order_id: 'UB-' + req.order_id,
            tracking_number: 'AWB-' + req.order_id,
            status: 'CREATED'
          },
          raw_request: {},
          raw_response: {}
        };
      }),
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

    const batch = [
      sampleOrder('INT-BULK-PARTIAL-1'),
      sampleOrder('INT-BULK-PARTIAL-FAIL'),
      {
        order_id: 'INT-BULK-PARTIAL-INVALID',
        courier_partner: 'urbanebolt',
        // invalid item missing required fields
        service_type: 'express'
      }
    ];

    const httpResponse = await request(app)
      .post('/api/v1/orders/bulk')
      .send(batch);

    expect(httpResponse.status).toBe(200);
    expect(httpResponse.body.results).toHaveLength(3);

    // Item 0: Success
    expect(httpResponse.body.results[0].success).toBe(true);

    // Item 1: Courier rejection failure
    expect(httpResponse.body.results[1].success).toBe(false);
    expect(httpResponse.body.results[1].error.code).toBe('COURIER_REJECTED');

    // Item 2: Validation failure
    expect(httpResponse.body.results[2].success).toBe(false);
    expect(httpResponse.body.results[2].error.code).toBe('VALIDATION_ERROR');
  });

  it('handles duplicate order_ids in the same batch idempotently', async () => {
    const mockAdapter: CourierAdapter = {
      courierPartner: 'urbanebolt',
      createShipment: vi.fn().mockImplementation(async (req: CreateOrderRequest) => ({
        response: {
          order_id: req.order_id,
          courier_partner: 'urbanebolt',
          courier_order_id: 'UB-' + req.order_id,
          tracking_number: 'AWB-' + req.order_id,
          status: 'CREATED'
        },
        raw_request: {},
        raw_response: {}
      })),
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

    const orderObj = sampleOrder('INT-BULK-DUP-1');
    const batch = [orderObj, orderObj]; // duplicate in same payload

    const httpResponse = await request(app)
      .post('/api/v1/orders/bulk')
      .send(batch);

    expect(httpResponse.status).toBe(200);
    expect(httpResponse.body.results).toHaveLength(2);

    // The first item succeeds or returns existing
    const firstSuccess = httpResponse.body.results.some((r: any) => r.success);
    expect(firstSuccess).toBe(true);
  });

  it('returns failure for conflicting order_id reused with different request payload', async () => {
    const mockAdapter: CourierAdapter = {
      courierPartner: 'urbanebolt',
      createShipment: vi.fn().mockResolvedValue({
        response: {
          order_id: 'INT-BULK-CONFLICT-1',
          courier_partner: 'urbanebolt',
          courier_order_id: 'UB-CONFLICT',
          tracking_number: 'AWB-CONFLICT',
          status: 'CREATED'
        },
        raw_request: {},
        raw_response: {}
      }),
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

    // Initial single creation
    await request(app).post('/api/v1/orders').send(sampleOrder('INT-BULK-CONFLICT-1'));

    // Bulk request with conflicting payload for same order_id
    const conflictingOrder = {
      ...sampleOrder('INT-BULK-CONFLICT-1'),
      package: { description: 'Different Package', pieces: 99, weight: 100 }
    };

    const httpResponse = await request(app)
      .post('/api/v1/orders/bulk')
      .send([conflictingOrder]);

    expect(httpResponse.status).toBe(200);
    expect(httpResponse.body.results[0].success).toBe(false);
    expect(httpResponse.body.results[0].error.code).toBe('ORDER_ID_CONFLICT');
  });

  it('rejects batch exceeding 100 orders with HTTP 400 VALIDATION_ERROR', async () => {
    const app = createApp();

    const oversizedBatch = Array.from({ length: 101 }, (_, i) =>
      sampleOrder(`INT-BULK-OVERSIZED-${i}`)
    );

    const httpResponse = await request(app)
      .post('/api/v1/orders/bulk')
      .send(oversizedBatch);

    expect(httpResponse.status).toBe(400);
    expect(httpResponse.body.error.code).toBe('VALIDATION_ERROR');
    expect(httpResponse.body.error.details).toEqual([
      { field: 'request', message: 'Bulk request cannot exceed 100 orders' }
    ]);
  });

  it('handles repeated identical bulk submissions idempotently without re-calling courier', async () => {
    const mockCreateShipment = vi.fn().mockImplementation(async (req: CreateOrderRequest) => ({
      response: {
        order_id: req.order_id,
        courier_partner: 'urbanebolt',
        courier_order_id: 'UB-' + req.order_id,
        tracking_number: 'AWB-' + req.order_id,
        status: 'CREATED'
      },
      raw_request: {},
      raw_response: {}
    }));

    const mockAdapter: CourierAdapter = {
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

    const batch = [
      sampleOrder('INT-BULK-REPEAT-1'),
      sampleOrder('INT-BULK-REPEAT-2')
    ];

    // First submission
    const res1 = await request(app).post('/api/v1/orders/bulk').send(batch);
    expect(res1.status).toBe(200);
    expect(mockCreateShipment).toHaveBeenCalledTimes(2);

    // Repeated submission of identical batch
    const res2 = await request(app).post('/api/v1/orders/bulk').send(batch);
    expect(res2.status).toBe(200);
    expect(res2.body).toEqual(res1.body);

    // Courier adapter was NOT called again!
    expect(mockCreateShipment).toHaveBeenCalledTimes(2);
  });
});
