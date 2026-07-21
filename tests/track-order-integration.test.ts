import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import type { CourierAdapter } from '../src/couriers/courier-adapter.js';
import { createCourierRegistry } from '../src/couriers/courier-registry.js';
import { CourierProviderError } from '../src/couriers/courier-adapter.js';
import { db } from '../src/db/knex.js';
import { createOrderRepository } from '../src/db/repositories/order-repository.js';
import { createTrackingHistoryRepository } from '../src/db/repositories/tracking-history-repository.js';
import type { CreateOrderRequest, CourierTrackResult } from '../src/domain/contracts.js';
import { createOrderService } from '../src/services/order-service.js';

const sampleRequest: CreateOrderRequest = {
  order_id: 'TRACK-INT-100',
  courier_partner: 'urbanebolt',
  service_type: 'express',
  sender: {
    name: 'Main Warehouse',
    phone: '+911111111111',
    street: '1 Warehouse Way',
    city: 'Delhi',
    state: 'Delhi',
    country: 'IN',
    postal_code: '110001'
  },
  recipient: {
    name: 'Bob Martin',
    phone: '+918888888888',
    street: '42 Tech Park',
    city: 'Bangalore',
    state: 'Karnataka',
    country: 'IN',
    postal_code: '560001'
  },
  package: {
    description: 'Hardware Tool',
    pieces: 1,
    weight: 3.0
  },
  payment: {
    mode: 'PREPAID'
  }
};

async function cleanupTestData(): Promise<void> {
  const testOrders = await db('orders')
    .select('id')
    .where('merchant_order_id', 'like', 'TRACK-INT-%');

  const orderIds = testOrders.map((o) => o.id);

  if (orderIds.length > 0) {
    await db('tracking_history').whereIn('order_id', orderIds).delete();
    await db('orders').whereIn('id', orderIds).delete();
  }
}

describe('PostgreSQL Order Tracking Integration (P5-T3)', () => {
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
      createShipment: vi.fn().mockResolvedValue({
        response: {
          order_id: sampleRequest.order_id,
          courier_partner: 'urbanebolt',
          courier_order_id: 'UB-INT-100',
          tracking_number: 'AWB-INT-100',
          status: 'CREATED'
        },
        raw_request: { test: 'req' },
        raw_response: { test: 'res' }
      }),
      trackShipment: vi.fn(),
      cancelShipment: vi.fn()
    };

    const registry = createCourierRegistry([mockAdapter]);
    const orderRepo = createOrderRepository(db);
    const historyRepo = createTrackingHistoryRepository(db);
    const service = createOrderService(orderRepo, historyRepo, registry, db);

    return createApp({ orderService: service });
  }

  it('tracks shipment progression with repeated polling, updating order status and appending history events in PostgreSQL', async () => {
    const app = createTestApp();

    // 1. Create order
    await request(app)
      .post('/api/v1/orders')
      .send(sampleRequest)
      .expect(201);

    // 2. First tracking call: CREATED status
    const trackResult1: CourierTrackResult = {
      response: {
        order_id: 'UB-INT-100',
        courier_partner: 'urbanebolt',
        tracking_number: 'AWB-INT-100',
        status: 'CREATED',
        status_updated_at: '2026-07-21T10:00:00.000Z',
        events: [
          {
            status: 'CREATED',
            status_at: '2026-07-21T10:00:00.000Z',
            description: 'Shipment created at origin'
          }
        ]
      },
      raw_response: { raw_step: 1 }
    };
    (mockAdapter.trackShipment as any).mockResolvedValueOnce(trackResult1);

    const res1 = await request(app)
      .get(`/api/v1/orders/${sampleRequest.order_id}/track`)
      .expect(200);

    expect(res1.body.status).toBe('CREATED');
    expect(res1.body.order_id).toBe(sampleRequest.order_id);

    // Verify DB state
    const orderRecord1 = await db('orders').where('merchant_order_id', sampleRequest.order_id).first();
    expect(orderRecord1.status).toBe('CREATED');
    expect(orderRecord1.courier_response_payload).toEqual({ raw_step: 1 });

    const historyRecords1 = await db('tracking_history').where('order_id', orderRecord1.id);
    // 2 events: 1 from creation + 1 from tracking
    expect(historyRecords1.length).toBeGreaterThanOrEqual(1);

    // 3. Second tracking call: IN_TRANSIT status
    const trackResult2: CourierTrackResult = {
      response: {
        order_id: 'UB-INT-100',
        courier_partner: 'urbanebolt',
        tracking_number: 'AWB-INT-100',
        status: 'IN_TRANSIT',
        status_updated_at: '2026-07-21T12:00:00.000Z',
        events: [
          {
            status: 'IN_TRANSIT',
            status_at: '2026-07-21T12:00:00.000Z',
            location: 'Hub Central',
            description: 'In transit to destination'
          }
        ]
      },
      raw_response: { raw_step: 2 }
    };
    (mockAdapter.trackShipment as any).mockResolvedValueOnce(trackResult2);

    const res2 = await request(app)
      .get(`/api/v1/orders/${sampleRequest.order_id}/track`)
      .expect(200);

    expect(res2.body.status).toBe('IN_TRANSIT');

    // Verify DB updated
    const orderRecord2 = await db('orders').where('merchant_order_id', sampleRequest.order_id).first();
    expect(orderRecord2.status).toBe('IN_TRANSIT');

    const historyRecords2 = await db('tracking_history').where('order_id', orderRecord2.id);
    const inTransitHistory = historyRecords2.filter((h) => h.status === 'IN_TRANSIT');
    expect(inTransitHistory.length).toBe(1);
    expect(inTransitHistory[0].raw_payload).toEqual({ raw_step: 2 });
  });

  it('handles unknown status from provider, updating order to UNKNOWN while preserving raw payload', async () => {
    const app = createTestApp();

    await request(app).post('/api/v1/orders').send(sampleRequest).expect(201);

    const unknownTrackResult: CourierTrackResult = {
      response: {
        order_id: 'UB-INT-100',
        courier_partner: 'urbanebolt',
        tracking_number: 'AWB-INT-100',
        status: 'UNKNOWN',
        status_updated_at: '2026-07-21T14:00:00.000Z',
        events: []
      },
      raw_response: { provider_code: 'CUSTOM_99', raw_desc: 'Custom provider state' }
    };
    (mockAdapter.trackShipment as any).mockResolvedValueOnce(unknownTrackResult);

    const res = await request(app)
      .get(`/api/v1/orders/${sampleRequest.order_id}/track`)
      .expect(200);

    expect(res.body.status).toBe('UNKNOWN');

    const orderInDb = await db('orders').where('merchant_order_id', sampleRequest.order_id).first();
    expect(orderInDb.status).toBe('UNKNOWN');
    expect(orderInDb.courier_response_payload).toEqual({
      provider_code: 'CUSTOM_99',
      raw_desc: 'Custom provider state'
    });
  });

  it('returns 503 COURIER_UNAVAILABLE when courier fails during tracking, preserving original order status in PostgreSQL', async () => {
    const app = createTestApp();

    await request(app).post('/api/v1/orders').send(sampleRequest).expect(201);

    (mockAdapter.trackShipment as any).mockRejectedValueOnce(
      new CourierProviderError({
        operation: 'track',
        kind: 'server',
        message: 'Courier server error during tracking',
        retryable: true
      })
    );

    const res = await request(app)
      .get(`/api/v1/orders/${sampleRequest.order_id}/track`)
      .expect(503);

    expect(res.body.error.code).toBe('COURIER_UNAVAILABLE');

    // Verify existing status CREATED is preserved
    const orderInDb = await db('orders').where('merchant_order_id', sampleRequest.order_id).first();
    expect(orderInDb.status).toBe('CREATED');
  });

  it('returns 404 ORDER_NOT_FOUND and does not invoke courier adapter when order is soft-deleted in PostgreSQL', async () => {
    const app = createTestApp();

    await request(app).post('/api/v1/orders').send(sampleRequest).expect(201);

    // Soft-delete the order in PostgreSQL
    await db('orders')
      .where('merchant_order_id', sampleRequest.order_id)
      .update({
        is_deleted: true,
        deleted_at: new Date()
      });

    const res = await request(app)
      .get(`/api/v1/orders/${sampleRequest.order_id}/track`)
      .expect(404);

    expect(res.body.error.code).toBe('ORDER_NOT_FOUND');
    expect(mockAdapter.trackShipment).not.toHaveBeenCalled();
  });
});
