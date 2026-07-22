import { describe, expect, it, vi } from 'vitest';

import type { CourierAdapter } from '../src/couriers/courier-adapter.js';
import type { CourierRegistry } from '../src/couriers/courier-registry.js';
import type { CreateOrderRequest } from '../src/domain/contracts.js';
import {
  CourierRejectedError,
  CourierUnavailableError,
  ValidationError
} from '../src/errors/application-error.js';
import {
  createOrderService,
  processWithConcurrency
} from '../src/services/order-service.js';

const sampleOrder = (id: string, courier = 'urbanebolt'): CreateOrderRequest => ({
  order_id: id,
  courier_partner: courier,
  service_type: 'express',
  sender: {
    name: 'Sender Enterprise',
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
    description: 'Electronics',
    pieces: 1,
    weight: 2.5
  },
  payment: {
    mode: 'prepaid'
  }
});

describe('processWithConcurrency helper', () => {
  it('executes tasks with bounded concurrency and preserves output order', async () => {
    const items = [10, 20, 30, 40, 50];
    let activeWorkers = 0;
    let maxActiveWorkers = 0;

    const results = await processWithConcurrency(items, 2, async (item) => {
      activeWorkers++;
      maxActiveWorkers = Math.max(maxActiveWorkers, activeWorkers);

      // Short delay
      await new Promise((resolve) => setTimeout(resolve, 10));

      activeWorkers--;
      return item * 2;
    });

    expect(maxActiveWorkers).toBeLessThanOrEqual(2);
    expect(results).toEqual([20, 40, 60, 80, 100]);
  });

  it('returns empty array when items list is empty', async () => {
    const results = await processWithConcurrency([], 5, async (x) => x);
    expect(results).toEqual([]);
  });
});

describe('Order Service Bulk Processing (P8-T2)', () => {
  it('processes mixed courier orders concurrently and isolates individual failures', async () => {
    const mockOrderRepo: any = {
      findByMerchantOrderId: vi.fn().mockResolvedValue(null),
      insertPendingOrder: vi.fn().mockImplementation(async (params) => ({
        id: 'db-' + params.merchantOrderId,
        merchant_order_id: params.merchantOrderId,
        courier_partner: params.courierPartner,
        courier_order_id: null,
        tracking_number: null,
        status: 'PENDING',
        normalized_request: params.normalizedRequest,
        courier_request_payload: null,
        courier_response_payload: null,
        failure_code: null,
        failure_message: null,
        is_deleted: false,
        deleted_at: null,
        created_at: new Date(),
        updated_at: new Date()
      })),
      updateCurrentState: vi.fn().mockResolvedValue({})
    };

    const mockUrbaneboltAdapter: CourierAdapter = {
      name: 'urbanebolt',
      createShipment: vi.fn().mockImplementation(async (req) => {
        if (req.order_id === 'BULK-FAIL-REJECTED') {
          throw new CourierRejectedError('Address not serviceable');
        }
        return {
          response: {
            order_id: req.order_id,
            courier_partner: 'urbanebolt',
            courier_order_id: 'UB-' + req.order_id,
            tracking_number: 'AWB-' + req.order_id,
            status: 'CREATED'
          },
          raw_request: { req },
          raw_response: { status: 'Success' }
        };
      }),
      trackShipment: vi.fn(),
      cancelShipment: vi.fn()
    };

    const mockDelhiveryAdapter: CourierAdapter = {
      name: 'delhivery',
      createShipment: vi.fn().mockImplementation(async (req) => {
        if (req.order_id === 'BULK-FAIL-UNAVAILABLE') {
          throw new CourierUnavailableError('Delhivery API timeout');
        }
        return {
          response: {
            order_id: req.order_id,
            courier_partner: 'delhivery',
            courier_order_id: 'DEL-' + req.order_id,
            tracking_number: 'DELAWB-' + req.order_id,
            status: 'CREATED'
          },
          raw_request: { req },
          raw_response: { status: 'Success' }
        };
      }),
      trackShipment: vi.fn(),
      cancelShipment: vi.fn()
    };

    const mockRegistry: CourierRegistry = {
      resolve: (name: string) => {
        if (name === 'urbanebolt') return mockUrbaneboltAdapter;
        if (name === 'delhivery') return mockDelhiveryAdapter;
        throw new Error(`Unknown courier: ${name}`);
      },
      getSupportedCouriers: () => ['urbanebolt', 'delhivery']
    };

    const service = createOrderService(mockOrderRepo, undefined, mockRegistry);

    const batch = [
      sampleOrder('BULK-1', 'urbanebolt'),
      sampleOrder('BULK-FAIL-REJECTED', 'urbanebolt'),
      sampleOrder('BULK-2', 'delhivery'),
      sampleOrder('BULK-FAIL-UNAVAILABLE', 'delhivery')
    ];

    const response = await service.createBulkOrders(batch, 'req-bulk-test', 2);

    expect(response.results).toHaveLength(4);

    // Item 0: Success with UrbaneBolt
    expect(response.results[0]).toEqual({
      order_id: 'BULK-1',
      success: true,
      result: {
        order_id: 'BULK-1',
        courier_partner: 'urbanebolt',
        courier_order_id: 'UB-BULK-1',
        tracking_number: 'AWB-BULK-1',
        status: 'CREATED'
      }
    });

    // Item 1: Failure isolated to BULK-FAIL-REJECTED
    expect(response.results[1].success).toBe(false);
    if (!response.results[1].success) {
      expect(response.results[1].order_id).toBe('BULK-FAIL-REJECTED');
      expect(response.results[1].error.code).toBe('COURIER_REJECTED');
      expect(response.results[1].error.request_id).toBe('req-bulk-test');
    }

    // Item 2: Success with Delhivery (mixed courier in same batch)
    expect(response.results[2]).toEqual({
      order_id: 'BULK-2',
      success: true,
      result: {
        order_id: 'BULK-2',
        courier_partner: 'delhivery',
        courier_order_id: 'DEL-BULK-2',
        tracking_number: 'DELAWB-BULK-2',
        status: 'CREATED'
      }
    });

    // Item 3: Failure isolated to BULK-FAIL-UNAVAILABLE
    expect(response.results[3].success).toBe(false);
    if (!response.results[3].success) {
      expect(response.results[3].order_id).toBe('BULK-FAIL-UNAVAILABLE');
      expect(response.results[3].error.code).toBe('COURIER_UNAVAILABLE');
    }
  });

  it('aborts whole batch if request payload fails batch-level validation', async () => {
    const mockOrderRepo: any = {};
    const service = createOrderService(mockOrderRepo);

    await expect(service.createBulkOrders({ not: 'an array' }, 'req-fail')).rejects.toThrow(
      ValidationError
    );
  });

  it('logs the courier partner for an invalid item when the input provides one', async () => {
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const service = createOrderService({}, undefined, {
      resolve: vi.fn(),
      getSupportedCouriers: () => ['urbanebolt']
    });

    try {
      const response = await service.createBulkOrders([{
        order_id: 'BULK-INVALID-LOG',
        courier_partner: 'urbanebolt',
        service_type: 'NDD'
      }], 'req-invalid-log');

      expect(response.results[0].success).toBe(false);
      const logEntry = JSON.parse(String(logSpy.mock.calls[0][0]));
      expect(logEntry).toMatchObject({
        request_id: 'req-invalid-log',
        order_id: 'BULK-INVALID-LOG',
        courier_partner: 'urbanebolt',
        error_code: 'VALIDATION_ERROR'
      });
    } finally {
      logSpy.mockRestore();
    }
  });
});
