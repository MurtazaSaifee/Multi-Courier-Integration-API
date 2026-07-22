import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CourierAdapter } from '../src/couriers/courier-adapter.js';
import { createCourierRegistry } from '../src/couriers/courier-registry.js';
import { CourierProviderError } from '../src/couriers/courier-adapter.js';
import { db } from '../src/db/knex.js';
import { createOrderRepository } from '../src/db/repositories/order-repository.js';
import { createTrackingHistoryRepository } from '../src/db/repositories/tracking-history-repository.js';
import type { CreateOrderRequest } from '../src/domain/contracts.js';
import { CourierRejectedError, CourierUnavailableError } from '../src/errors/application-error.js';
import { createOrderService } from '../src/services/order-service.js';

const sampleRequest: CreateOrderRequest = {
  order_id: 'FAIL-INT-300',
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
    description: 'Test Box',
    pieces: 1,
    weight: 2.0
  },
  payment: {
    mode: 'PREPAID'
  }
};

async function cleanupTestData(): Promise<void> {
  const testOrders = await db('orders')
    .select('id')
    .where('merchant_order_id', 'like', 'FAIL-INT-%');

  const orderIds = testOrders.map((o) => o.id);

  if (orderIds.length > 0) {
    await db('tracking_history').whereIn('order_id', orderIds).delete();
    await db('orders').whereIn('id', orderIds).delete();
  }
}

describe('Normalized Failures & Failure Persistence (P7-T3)', () => {
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

  it('persists raw provider request and response payloads on creation failure and keeps failed orders queryable via listFailedOrders', async () => {
    const mockAdapter: CourierAdapter = {
      courierPartner: 'urbanebolt',
      createShipment: vi.fn().mockRejectedValue(
        new CourierProviderError({
          operation: 'create',
          kind: 'client',
          message: 'Pincode not serviceable',
          retryable: false,
          rawRequestPayload: { shprPincode: '110001', consPincode: '400001' },
          rawResponsePayload: { error: 'Pincode 400001 not serviceable' }
        })
      ),
      trackShipment: vi.fn(),
      cancelShipment: vi.fn()
    };

    const registry = createCourierRegistry([mockAdapter]);
    const orderRepo = createOrderRepository(db);
    const historyRepo = createTrackingHistoryRepository(db);
    const service = createOrderService(orderRepo, historyRepo, registry, db);

    await expect(service.createOrder(sampleRequest)).rejects.toThrow(CourierRejectedError);

    // Verify DB record status is FAILED and raw payloads are stored internally
    const storedOrder = await orderRepo.findByMerchantOrderId(sampleRequest.order_id);
    expect(storedOrder).toBeDefined();
    expect(storedOrder?.status).toBe('FAILED');
    expect(storedOrder?.failure_code).toBe('CLIENT');
    expect(storedOrder?.failure_message).toBe('Pincode not serviceable');
    expect(storedOrder?.failure_request_payload).toEqual({ shprPincode: '110001', consPincode: '400001' });
    expect(storedOrder?.failure_response_payload).toEqual({ error: 'Pincode 400001 not serviceable' });

    // Verify failed order is queryable via listFailedOrders for reconciliation
    const failedOrders = await orderRepo.listFailedOrders();
    expect(failedOrders.some((o) => o.merchant_order_id === sampleRequest.order_id)).toBe(true);
  });

  it('never automatically creates a second shipment when a failed order request is retried publicly', async () => {
    const mockAdapter: CourierAdapter = {
      courierPartner: 'urbanebolt',
      createShipment: vi.fn().mockRejectedValueOnce(
        new CourierProviderError({
          operation: 'create',
          kind: 'server',
          message: 'Timeout during create',
          retryable: true
        })
      ),
      trackShipment: vi.fn(),
      cancelShipment: vi.fn()
    };

    const registry = createCourierRegistry([mockAdapter]);
    const orderRepo = createOrderRepository(db);
    const historyRepo = createTrackingHistoryRepository(db);
    const service = createOrderService(orderRepo, historyRepo, registry, db);

    // Initial creation fails
    await expect(service.createOrder(sampleRequest)).rejects.toThrow(CourierUnavailableError);
    expect(mockAdapter.createShipment).toHaveBeenCalledTimes(1);

    // Public retry with identical request: should throw stored failure without calling adapter again
    await expect(service.createOrder(sampleRequest)).rejects.toThrow(CourierUnavailableError);
    expect(mockAdapter.createShipment).toHaveBeenCalledTimes(1); // Still only 1 call to courier!
  });

  it('persists a plain-text provider response as JSON instead of turning it into an internal error', async () => {
    const request = { ...sampleRequest, order_id: 'FAIL-INT-TEXT-301' };
    const mockAdapter: CourierAdapter = {
      courierPartner: 'urbanebolt',
      createShipment: vi.fn().mockRejectedValue(
        new CourierProviderError({
          operation: 'create',
          kind: 'client',
          message: 'Courier returned a plain-text rejection',
          retryable: false,
          rawRequestPayload: { orderNumber: request.order_id },
          rawResponsePayload: 'Pincode not serviceable'
        })
      ),
      trackShipment: vi.fn(),
      cancelShipment: vi.fn()
    };

    const service = createOrderService(
      createOrderRepository(db),
      createTrackingHistoryRepository(db),
      createCourierRegistry([mockAdapter]),
      db
    );

    await expect(service.createOrder(request)).rejects.toThrow(CourierRejectedError);

    const storedOrder = await createOrderRepository(db).findByMerchantOrderId(request.order_id);
    expect(storedOrder?.status).toBe('FAILED');
    expect(storedOrder?.failure_response_payload).toBe('Pincode not serviceable');
  });
});
