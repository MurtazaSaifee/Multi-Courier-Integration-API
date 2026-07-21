import { describe, expect, it, vi } from 'vitest';

import type { createOrderRepository } from '../src/db/repositories/order-repository.js';
import type { CreateOrderRequest, OrderRecord } from '../src/domain/contracts.js';
import {
  OrderIdConflictError,
  OrderInProgressError
} from '../src/errors/application-error.js';
import {
  areRequestsEqual,
  buildCreateOrderResponse,
  createOrderService
} from '../src/services/order-service.js';

import { createSampleOrderRequest } from './helpers/sample-order-request.js';

type OrderRepo = ReturnType<typeof createOrderRepository>;

const sampleRequest = createSampleOrderRequest({ order_id: 'ORDER-1001' });

describe('Order Service Reservation and Idempotency Flow', () => {
  it('reserves a new order by inserting a PENDING record', async () => {
    const pendingRecord: OrderRecord = {
      id: '1',
      merchant_order_id: 'ORDER-1001',
      courier_partner: 'urbanebolt',
      courier_order_id: null,
      tracking_number: null,
      status: 'PENDING',
      normalized_request: sampleRequest,
      courier_request_payload: null,
      courier_response_payload: null,
      failure_code: null,
      failure_message: null,
      is_deleted: false,
      deleted_at: null,
      created_at: new Date(),
      updated_at: new Date()
    };

    const mockRepo: Partial<OrderRepo> = {
      findByMerchantOrderId: vi.fn().mockResolvedValue(undefined),
      insertPendingOrder: vi.fn().mockResolvedValue(pendingRecord)
    };

    const service = createOrderService(mockRepo as OrderRepo);
    const result = await service.reserveOrder(sampleRequest);

    expect(mockRepo.findByMerchantOrderId).toHaveBeenCalledWith('ORDER-1001');
    expect(mockRepo.insertPendingOrder).toHaveBeenCalledWith({
      merchantOrderId: 'ORDER-1001',
      courierPartner: 'urbanebolt',
      normalizedRequest: sampleRequest
    });
    expect(result).toEqual({
      status: 'reserved',
      order: pendingRecord
    });
  });

  it('throws OrderInProgressError if a second request arrives while status is PENDING', async () => {
    const pendingRecord: OrderRecord = {
      id: '1',
      merchant_order_id: 'ORDER-1001',
      courier_partner: 'urbanebolt',
      courier_order_id: null,
      tracking_number: null,
      status: 'PENDING',
      normalized_request: sampleRequest,
      courier_request_payload: null,
      courier_response_payload: null,
      failure_code: null,
      failure_message: null,
      is_deleted: false,
      deleted_at: null,
      created_at: new Date(),
      updated_at: new Date()
    };

    const mockRepo: Partial<OrderRepo> = {
      findByMerchantOrderId: vi.fn().mockResolvedValue(pendingRecord)
    };

    const service = createOrderService(mockRepo as OrderRepo);

    await expect(service.reserveOrder(sampleRequest)).rejects.toThrow(OrderInProgressError);
    await expect(service.reserveOrder(sampleRequest)).rejects.toMatchObject({
      code: 'ORDER_IN_PROGRESS',
      statusCode: 409
    });
  });

  it('returns the existing result for an identical merchant_order_id when already completed', async () => {
    const completedRecord: OrderRecord = {
      id: '1',
      merchant_order_id: 'ORDER-1001',
      courier_partner: 'urbanebolt',
      courier_order_id: 'UB-999',
      tracking_number: 'AWB-888',
      status: 'CREATED',
      normalized_request: sampleRequest,
      courier_request_payload: {},
      courier_response_payload: {},
      failure_code: null,
      failure_message: null,
      is_deleted: false,
      deleted_at: null,
      created_at: new Date(),
      updated_at: new Date()
    };

    const mockRepo: Partial<OrderRepo> = {
      findByMerchantOrderId: vi.fn().mockResolvedValue(completedRecord)
    };

    const service = createOrderService(mockRepo as OrderRepo);
    const result = await service.reserveOrder(sampleRequest);

    expect(result).toEqual({
      status: 'existing',
      order: completedRecord,
      response: {
        order_id: 'ORDER-1001',
        courier_partner: 'urbanebolt',
        courier_order_id: 'UB-999',
        tracking_number: 'AWB-888',
        status: 'CREATED'
      }
    });
  });

  it('throws OrderIdConflictError if an existing order has different request parameters', async () => {
    const completedRecord: OrderRecord = {
      id: '1',
      merchant_order_id: 'ORDER-1001',
      courier_partner: 'urbanebolt',
      courier_order_id: 'UB-999',
      tracking_number: 'AWB-888',
      status: 'CREATED',
      normalized_request: sampleRequest,
      courier_request_payload: {},
      courier_response_payload: {},
      failure_code: null,
      failure_message: null,
      is_deleted: false,
      deleted_at: null,
      created_at: new Date(),
      updated_at: new Date()
    };

    const conflictingRequest: CreateOrderRequest = {
      ...sampleRequest,
      package: {
        description: 'Different Item',
        pieces: 2,
        weight: 10
      }
    };

    const mockRepo: Partial<OrderRepo> = {
      findByMerchantOrderId: vi.fn().mockResolvedValue(completedRecord)
    };

    const service = createOrderService(mockRepo as OrderRepo);

    await expect(service.reserveOrder(conflictingRequest)).rejects.toThrow(OrderIdConflictError);
    await expect(service.reserveOrder(conflictingRequest)).rejects.toMatchObject({
      code: 'ORDER_ID_CONFLICT',
      statusCode: 409
    });
  });

  it('handles unique constraint violation during race conditions and checks idempotency', async () => {
    const pendingRecord: OrderRecord = {
      id: '1',
      merchant_order_id: 'ORDER-1001',
      courier_partner: 'urbanebolt',
      courier_order_id: null,
      tracking_number: null,
      status: 'PENDING',
      normalized_request: sampleRequest,
      courier_request_payload: null,
      courier_response_payload: null,
      failure_code: null,
      failure_message: null,
      is_deleted: false,
      deleted_at: null,
      created_at: new Date(),
      updated_at: new Date()
    };

    const dbError = new Error('duplicate key value violates unique constraint') as any;
    dbError.code = '23505';

    const mockRepo: Partial<OrderRepo> = {
      // First call (check before insert) returns undefined.
      // Second call (check after unique error) returns the inserted pending record.
      findByMerchantOrderId: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(pendingRecord),
      insertPendingOrder: vi.fn().mockRejectedValue(dbError)
    };

    const service = createOrderService(mockRepo as OrderRepo);

    await expect(service.reserveOrder(sampleRequest)).rejects.toThrow(OrderInProgressError);
  });

  it('throws OrderInProgressError if 23505 occurs and concurrent lookup returns undefined', async () => {
    const dbError = new Error('duplicate key value violates unique constraint') as any;
    dbError.code = '23505';

    const mockRepo: Partial<OrderRepo> = {
      findByMerchantOrderId: vi.fn().mockResolvedValue(undefined),
      insertPendingOrder: vi.fn().mockRejectedValue(dbError)
    };

    const service = createOrderService(mockRepo as OrderRepo);

    await expect(service.reserveOrder(sampleRequest)).rejects.toThrow(OrderInProgressError);
  });

  it('correctly assesses deep equality of request objects regardless of key order', () => {
    const req1 = {
      a: 1,
      b: { x: 'hello', y: [1, 2, 3] },
      c: undefined
    };
    const req2 = {
      b: { y: [1, 2, 3], x: 'hello' },
      a: 1
    };
    const req3 = {
      a: 1,
      b: { x: 'world', y: [1, 2, 3] }
    };

    expect(areRequestsEqual(req1, req2)).toBe(true);
    expect(areRequestsEqual(req1, req3)).toBe(false);
  });
});
