import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import type { CourierAdapter } from '../src/couriers/courier-adapter.js';
import { createCourierRegistry } from '../src/couriers/courier-registry.js';
import { CourierProviderError } from '../src/couriers/courier-adapter.js';
import { db } from '../src/db/knex.js';
import { createOrderRepository } from '../src/db/repositories/order-repository.js';
import { createTrackingHistoryRepository } from '../src/db/repositories/tracking-history-repository.js';
import type { CourierCancelResult, CreateOrderRequest } from '../src/domain/contracts.js';
import { createOrderService } from '../src/services/order-service.js';

const sampleRequest: CreateOrderRequest = {
  order_id: 'CANCEL-INT-100',
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
    .where('merchant_order_id', 'like', 'CANCEL-INT-%');

  const orderIds = testOrders.map((o) => o.id);

  if (orderIds.length > 0) {
    await db('tracking_history').whereIn('order_id', orderIds).delete();
    await db('orders').whereIn('id', orderIds).delete();
  }
}

describe('PostgreSQL Order Cancellation Integration (P6-T2)', () => {
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
          courier_order_id: 'UB-INT-CANCEL-100',
          tracking_number: 'AWB-INT-CANCEL-100',
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

  it('cancels shipment successfully, updating order status in PostgreSQL and inserting a CANCELLED tracking history event', async () => {
    const app = createTestApp();

    // 1. Create order
    await request(app)
      .post('/api/v1/orders')
      .send(sampleRequest)
      .expect(201);

    // 2. Mock adapter cancellation response
    const cancelResult: CourierCancelResult = {
      response: {
        order_id: 'UB-INT-CANCEL-100',
        courier_partner: 'urbanebolt',
        tracking_number: 'AWB-INT-CANCEL-100',
        status: 'CANCELLED'
      },
      raw_response: { provider_message: 'Shipment cancelled successfully' }
    };
    (mockAdapter.cancelShipment as any).mockResolvedValueOnce(cancelResult);

    // 3. Post cancellation request
    const cancelRes = await request(app)
      .post(`/api/v1/orders/${sampleRequest.order_id}/cancel`)
      .expect(200);

    expect(cancelRes.body).toEqual({
      order_id: sampleRequest.order_id,
      courier_partner: 'urbanebolt',
      tracking_number: 'AWB-INT-CANCEL-100',
      status: 'CANCELLED'
    });

    // Verify DB updated
    const orderInDb = await db('orders').where('merchant_order_id', sampleRequest.order_id).first();
    expect(orderInDb.status).toBe('CANCELLED');
    expect(orderInDb.courier_response_payload).toEqual({ provider_message: 'Shipment cancelled successfully' });

    // Verify history event added
    const historyEvents = await db('tracking_history').where('order_id', orderInDb.id);
    const cancelEvents = historyEvents.filter((e) => e.status === 'CANCELLED');
    expect(cancelEvents.length).toBe(1);
    expect(cancelEvents[0].raw_payload).toEqual({ provider_message: 'Shipment cancelled successfully' });
  });

  it('handles repeated cancellation as a successful no-op without invoking courier adapter', async () => {
    const app = createTestApp();

    await request(app).post('/api/v1/orders').send(sampleRequest).expect(201);

    const cancelResult: CourierCancelResult = {
      response: {
        order_id: 'UB-INT-CANCEL-100',
        courier_partner: 'urbanebolt',
        tracking_number: 'AWB-INT-CANCEL-100',
        status: 'CANCELLED'
      },
      raw_response: { provider_message: 'Shipment cancelled' }
    };
    (mockAdapter.cancelShipment as any).mockResolvedValueOnce(cancelResult);

    // First cancel call
    await request(app)
      .post(`/api/v1/orders/${sampleRequest.order_id}/cancel`)
      .expect(200);

    expect(mockAdapter.cancelShipment).toHaveBeenCalledTimes(1);

    // Second cancel call (repeated)
    const repeatRes = await request(app)
      .post(`/api/v1/orders/${sampleRequest.order_id}/cancel`)
      .expect(200);

    expect(repeatRes.body.status).toBe('CANCELLED');
    expect(repeatRes.body.order_id).toBe(sampleRequest.order_id);
    // Adapter should still only have been called once
    expect(mockAdapter.cancelShipment).toHaveBeenCalledTimes(1);
  });

  it('returns 404 ORDER_NOT_FOUND when order does not exist or is soft-deleted', async () => {
    const app = createTestApp();

    await request(app).post('/api/v1/orders').send(sampleRequest).expect(201);

    // Soft delete the order
    await db('orders')
      .where('merchant_order_id', sampleRequest.order_id)
      .update({
        is_deleted: true,
        deleted_at: new Date()
      });

    const res = await request(app)
      .post(`/api/v1/orders/${sampleRequest.order_id}/cancel`)
      .expect(404);

    expect(res.body.error.code).toBe('ORDER_NOT_FOUND');
    expect(mockAdapter.cancelShipment).not.toHaveBeenCalled();
  });

  it('returns 422 COURIER_REJECTED when courier rejects cancellation request', async () => {
    const app = createTestApp();

    await request(app).post('/api/v1/orders').send(sampleRequest).expect(201);

    (mockAdapter.cancelShipment as any).mockRejectedValueOnce(
      new CourierProviderError({
        operation: 'cancel',
        kind: 'client',
        message: 'Cannot cancel shipment after pickup',
        retryable: false,
        rawRequestPayload: { awb: 'AWB-INT-CANCEL-100' },
        rawResponsePayload: { error: 'Already picked up' }
      })
    );

    const res = await request(app)
      .post(`/api/v1/orders/${sampleRequest.order_id}/cancel`)
      .expect(422);

    expect(res.body.error.code).toBe('COURIER_REJECTED');
    expect(res.body.error).not.toHaveProperty('rawResponsePayload');
    expect(JSON.stringify(res.body)).not.toContain('Already picked up');

    // Original status CREATED should be preserved while failure fields are saved
    const orderInDb = await db('orders').where('merchant_order_id', sampleRequest.order_id).first();
    expect(orderInDb.status).toBe('CREATED');
    expect(orderInDb.failure_code).toBe('CLIENT');
    expect(orderInDb.failure_message).toBe('Cannot cancel shipment after pickup');
    expect(orderInDb.courier_request_payload).toEqual({ test: 'req' });
    expect(orderInDb.courier_response_payload).toEqual({ test: 'res' });
    expect(orderInDb.failure_request_payload).toEqual({ awb: 'AWB-INT-CANCEL-100' });
    expect(orderInDb.failure_response_payload).toEqual({ error: 'Already picked up' });

    // Verify no tracking history was added for the failed attempt
    const historyInDb = await db('tracking_history').where('order_id', orderInDb.id);
    expect(historyInDb.filter((h) => h.status === 'FAILED')).toHaveLength(0);

    // Verify subsequent successful cancellation clears failure fields
    const successfulCancelResult: CourierCancelResult = {
      response: {
        order_id: 'UB-INT-CANCEL-100',
        courier_partner: 'urbanebolt',
        tracking_number: 'AWB-INT-CANCEL-100',
        status: 'CANCELLED'
      },
      raw_response: { provider_message: 'Cancelled on retry' }
    };
    (mockAdapter.cancelShipment as any).mockResolvedValueOnce(successfulCancelResult);

    await request(app)
      .post(`/api/v1/orders/${sampleRequest.order_id}/cancel`)
      .expect(200);

    const clearedOrderInDb = await db('orders').where('merchant_order_id', sampleRequest.order_id).first();
    expect(clearedOrderInDb.status).toBe('CANCELLED');
    expect(clearedOrderInDb.failure_code).toBeNull();
    expect(clearedOrderInDb.failure_message).toBeNull();
  });
});
