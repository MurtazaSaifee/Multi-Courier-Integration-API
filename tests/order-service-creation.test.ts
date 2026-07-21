import { describe, expect, it, vi } from 'vitest';

import type { CourierAdapter } from '../src/couriers/courier-adapter.js';
import type { CourierRegistry } from '../src/couriers/courier-registry.js';
import type { createOrderRepository } from '../src/db/repositories/order-repository.js';
import type { createTrackingHistoryRepository } from '../src/db/repositories/tracking-history-repository.js';
import type {
  CourierCreateResult,
  CreateOrderRequest,
  OrderRecord
} from '../src/domain/contracts.js';
import { CourierProviderError } from '../src/couriers/courier-adapter.js';
import { createOrderService } from '../src/services/order-service.js';

type OrderRepo = ReturnType<typeof createOrderRepository>;
type HistoryRepo = ReturnType<typeof createTrackingHistoryRepository>;

const sampleRequest: CreateOrderRequest = {
  order_id: 'ORDER-2002',
  courier_partner: 'urbanebolt',
  service_type: 'express',
  sender: {
    name: 'Sender Corp',
    phone: '+911111111111',
    street: '1 Warehouse Rd',
    city: 'Mumbai',
    state: 'Maharashtra',
    country: 'IN',
    postal_code: '400001'
  },
  recipient: {
    name: 'John Smith',
    phone: '+918888888888',
    street: '50 Main St',
    city: 'Delhi',
    state: 'Delhi',
    country: 'IN',
    postal_code: '110001'
  },
  package: {
    description: 'Books',
    pieces: 2,
    weight: 1.0
  },
  payment: {
    mode: 'PREPAID'
  }
};

describe('Order Service Create Order Flow (P4-T2)', () => {
  it('persists courier identifiers, raw payloads, status CREATED, and tracking history event on successful creation', async () => {
    const pendingRecord: OrderRecord = {
      id: '10',
      merchant_order_id: 'ORDER-2002',
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

    const mockOrderRepo: Partial<OrderRepo> = {
      findByMerchantOrderId: vi.fn().mockResolvedValue(undefined),
      insertPendingOrder: vi.fn().mockResolvedValue(pendingRecord),
      updateCurrentState: vi.fn().mockResolvedValue({
        ...pendingRecord,
        status: 'CREATED',
        courier_order_id: 'UB-2002',
        tracking_number: 'AWB-2002'
      })
    };

    const mockHistoryRepo: Partial<HistoryRepo> = {
      insertHistoryEvent: vi.fn().mockResolvedValue({
        id: '1',
        order_id: '10',
        status: 'CREATED',
        status_at: new Date(),
        raw_payload: { raw: 'response' }
      })
    };

    const courierResult: CourierCreateResult = {
      response: {
        order_id: 'ORDER-2002',
        courier_partner: 'urbanebolt',
        courier_order_id: 'UB-2002',
        tracking_number: 'AWB-2002',
        status: 'CREATED'
      },
      raw_request: [{ payload: 'raw_req' }],
      raw_response: { success: true }
    };

    const mockAdapter: Partial<CourierAdapter> = {
      courierPartner: 'urbanebolt',
      createShipment: vi.fn().mockResolvedValue(courierResult)
    };

    const mockRegistry: Partial<CourierRegistry> = {
      resolve: vi.fn().mockReturnValue(mockAdapter as CourierAdapter)
    };

    const service = createOrderService(
      mockOrderRepo as OrderRepo,
      mockHistoryRepo as HistoryRepo,
      mockRegistry as CourierRegistry
    );

    const response = await service.createOrder(sampleRequest);

    expect(response).toEqual({
      order_id: 'ORDER-2002',
      courier_partner: 'urbanebolt',
      courier_order_id: 'UB-2002',
      tracking_number: 'AWB-2002',
      status: 'CREATED'
    });

    expect(mockOrderRepo.updateCurrentState).toHaveBeenCalledWith('10', {
      status: 'CREATED',
      courierOrderId: 'UB-2002',
      trackingNumber: 'AWB-2002',
      courierRequestPayload: [{ payload: 'raw_req' }],
      courierResponsePayload: { success: true }
    });

    expect(mockHistoryRepo.insertHistoryEvent).toHaveBeenCalledWith({
      orderId: '10',
      status: 'CREATED',
      statusAt: expect.any(Date),
      rawPayload: { success: true }
    });
  });

  it('persists a graceful FAILED state and tracking history when courier call fails', async () => {
    const pendingRecord: OrderRecord = {
      id: '10',
      merchant_order_id: 'ORDER-2002',
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

    const mockOrderRepo: Partial<OrderRepo> = {
      findByMerchantOrderId: vi.fn().mockResolvedValue(undefined),
      insertPendingOrder: vi.fn().mockResolvedValue(pendingRecord),
      updateCurrentState: vi.fn().mockResolvedValue({
        ...pendingRecord,
        status: 'FAILED',
        failure_code: 'CLIENT',
        failure_message: 'Invalid pincode'
      })
    };

    const mockHistoryRepo: Partial<HistoryRepo> = {
      insertHistoryEvent: vi.fn().mockResolvedValue({
        id: '2',
        order_id: '10',
        status: 'FAILED',
        status_at: new Date(),
        raw_payload: { error: 'Invalid pincode' }
      })
    };

    const providerError = new CourierProviderError({
      operation: 'create',
      kind: 'client',
      message: 'Invalid pincode',
      retryable: false,
      rawRequestPayload: { sent: 'data' },
      rawResponsePayload: { errorResponse: [{ message: 'Invalid pincode' }] }
    });

    const mockAdapter: Partial<CourierAdapter> = {
      courierPartner: 'urbanebolt',
      createShipment: vi.fn().mockRejectedValue(providerError)
    };

    const mockRegistry: Partial<CourierRegistry> = {
      resolve: vi.fn().mockReturnValue(mockAdapter as CourierAdapter)
    };

    const service = createOrderService(
      mockOrderRepo as OrderRepo,
      mockHistoryRepo as HistoryRepo,
      mockRegistry as CourierRegistry
    );

    await expect(service.createOrder(sampleRequest)).rejects.toThrow(CourierProviderError);

    expect(mockOrderRepo.updateCurrentState).toHaveBeenCalledWith('10', {
      status: 'FAILED',
      failureCode: 'CLIENT',
      failureMessage: 'Invalid pincode',
      courierRequestPayload: { sent: 'data' },
      courierResponsePayload: { errorResponse: [{ message: 'Invalid pincode' }] }
    });

    expect(mockHistoryRepo.insertHistoryEvent).toHaveBeenCalledWith({
      orderId: '10',
      status: 'FAILED',
      statusAt: expect.any(Date),
      rawPayload: { errorResponse: [{ message: 'Invalid pincode' }] }
    });
  });

  it('returns stored response directly for an already completed order without calling courier', async () => {
    const completedRecord: OrderRecord = {
      id: '10',
      merchant_order_id: 'ORDER-2002',
      courier_partner: 'urbanebolt',
      courier_order_id: 'UB-2002',
      tracking_number: 'AWB-2002',
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

    const mockOrderRepo: Partial<OrderRepo> = {
      findByMerchantOrderId: vi.fn().mockResolvedValue(completedRecord)
    };

    const mockAdapter: Partial<CourierAdapter> = {
      courierPartner: 'urbanebolt',
      createShipment: vi.fn()
    };

    const mockRegistry: Partial<CourierRegistry> = {
      resolve: vi.fn().mockReturnValue(mockAdapter as CourierAdapter)
    };

    const service = createOrderService(
      mockOrderRepo as OrderRepo,
      undefined,
      mockRegistry as CourierRegistry
    );

    const response = await service.createOrder(sampleRequest);

    expect(response).toEqual({
      order_id: 'ORDER-2002',
      courier_partner: 'urbanebolt',
      courier_order_id: 'UB-2002',
      tracking_number: 'AWB-2002',
      status: 'CREATED'
    });

    expect(mockAdapter.createShipment).not.toHaveBeenCalled();
  });
});
