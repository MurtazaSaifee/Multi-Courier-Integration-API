import { describe, expect, it, vi } from 'vitest';

import type { CourierAdapter } from '../src/couriers/courier-adapter.js';
import type { CourierRegistry } from '../src/couriers/courier-registry.js';
import type { createOrderRepository } from '../src/db/repositories/order-repository.js';
import type { createTrackingHistoryRepository } from '../src/db/repositories/tracking-history-repository.js';
import type {
  CancelOrderResponse,
  CourierCancelResult,
  OrderRecord
} from '../src/domain/contracts.js';
import { CourierProviderError } from '../src/couriers/courier-adapter.js';
import {
  CourierUnavailableError,
  OrderNotFoundError,
  ValidationError
} from '../src/errors/application-error.js';
import { createOrderService } from '../src/services/order-service.js';

import { createSampleOrderRequest } from './helpers/sample-order-request.js';

type OrderRepo = ReturnType<typeof createOrderRepository>;
type HistoryRepo = ReturnType<typeof createTrackingHistoryRepository>;

const sampleRequest = createSampleOrderRequest({ order_id: 'ORDER-CANCEL-1' });

const mockActiveOrder: OrderRecord = {
  id: '101',
  merchant_order_id: 'ORDER-CANCEL-1',
  courier_partner: 'urbanebolt',
  courier_order_id: 'UB-888',
  tracking_number: 'UB-AWB-98765',
  status: 'CREATED',
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

describe('Order Service Cancellation Flow (P6-T1)', () => {
  it('finds active order, invokes adapter with stored tracking number, updates current status to CANCELLED, inserts tracking history event, and returns normalized CancelOrderResponse', async () => {
    const mockOrderRepo: Partial<OrderRepo> = {
      findActiveOrderByMerchantOrderId: vi.fn().mockResolvedValue(mockActiveOrder),
      updateCurrentState: vi.fn().mockResolvedValue({
        ...mockActiveOrder,
        status: 'CANCELLED'
      })
    };

    const mockHistoryRepo: Partial<HistoryRepo> = {
      insertHistoryEvent: vi.fn().mockResolvedValue({
        id: '2',
        order_id: '101',
        status: 'CANCELLED',
        status_at: new Date(),
        raw_payload: { raw: 'cancel-response' }
      })
    };

    const cancelResult: CourierCancelResult = {
      response: {
        order_id: 'UB-888',
        courier_partner: 'urbanebolt',
        tracking_number: 'UB-AWB-98765',
        status: 'CANCELLED'
      },
      raw_response: { raw: 'cancel-response' }
    };

    const mockAdapter: Partial<CourierAdapter> = {
      courierPartner: 'urbanebolt',
      cancelShipment: vi.fn().mockResolvedValue(cancelResult)
    };

    const mockRegistry: Partial<CourierRegistry> = {
      resolve: vi.fn().mockReturnValue(mockAdapter)
    };

    const service = createOrderService(
      mockOrderRepo as OrderRepo,
      mockHistoryRepo as HistoryRepo,
      mockRegistry as CourierRegistry
    );

    const result = await service.cancelOrder('ORDER-CANCEL-1');

    expect(mockOrderRepo.findActiveOrderByMerchantOrderId).toHaveBeenCalledWith('ORDER-CANCEL-1');
    expect(mockRegistry.resolve).toHaveBeenCalledWith('urbanebolt');
    expect(mockAdapter.cancelShipment).toHaveBeenCalledWith({
      courier_order_id: 'UB-888',
      tracking_number: 'UB-AWB-98765'
    });
    expect(mockOrderRepo.updateCurrentState).toHaveBeenCalledWith(
      '101',
      {
        status: 'CANCELLED',
        courierResponsePayload: { raw: 'cancel-response' },
        failureRequestPayload: null,
        failureResponsePayload: null,
        failureCode: null,
        failureMessage: null
      },
      undefined
    );
    expect(mockHistoryRepo.insertHistoryEvent).toHaveBeenCalledWith(
      {
        orderId: '101',
        status: 'CANCELLED',
        statusAt: expect.any(Date),
        rawPayload: { raw: 'cancel-response' }
      },
      undefined
    );

    expect(result).toEqual({
      order_id: 'ORDER-CANCEL-1',
      courier_partner: 'urbanebolt',
      tracking_number: 'UB-AWB-98765',
      status: 'CANCELLED'
    });
  });

  it('treats an already-cancelled order as a successful no-op without calling courier adapter', async () => {
    const alreadyCancelledOrder: OrderRecord = {
      ...mockActiveOrder,
      status: 'CANCELLED'
    };

    const mockOrderRepo: Partial<OrderRepo> = {
      findActiveOrderByMerchantOrderId: vi.fn().mockResolvedValue(alreadyCancelledOrder),
      updateCurrentState: vi.fn()
    };

    const mockHistoryRepo: Partial<HistoryRepo> = {
      insertHistoryEvent: vi.fn()
    };

    const mockRegistry: Partial<CourierRegistry> = {
      resolve: vi.fn()
    };

    const service = createOrderService(
      mockOrderRepo as OrderRepo,
      mockHistoryRepo as HistoryRepo,
      mockRegistry as CourierRegistry
    );

    const result = await service.cancelOrder('ORDER-CANCEL-1');

    expect(result).toEqual({
      order_id: 'ORDER-CANCEL-1',
      courier_partner: 'urbanebolt',
      tracking_number: 'UB-AWB-98765',
      status: 'CANCELLED'
    });

    expect(mockRegistry.resolve).not.toHaveBeenCalled();
    expect(mockOrderRepo.updateCurrentState).not.toHaveBeenCalled();
    expect(mockHistoryRepo.insertHistoryEvent).not.toHaveBeenCalled();
  });

  it('throws OrderNotFoundError when requested order does not exist or is soft-deleted', async () => {
    const mockOrderRepo: Partial<OrderRepo> = {
      findActiveOrderByMerchantOrderId: vi.fn().mockResolvedValue(undefined)
    };

    const mockRegistry: Partial<CourierRegistry> = {
      resolve: vi.fn()
    };

    const service = createOrderService(
      mockOrderRepo as OrderRepo,
      undefined,
      mockRegistry as CourierRegistry
    );

    await expect(service.cancelOrder('NON_EXISTENT_ORDER')).rejects.toThrow(OrderNotFoundError);
    expect(mockRegistry.resolve).not.toHaveBeenCalled();
  });

  it('throws ValidationError when active order exists but has no tracking_number', async () => {
    const orderWithoutTracking: OrderRecord = {
      ...mockActiveOrder,
      tracking_number: null
    };

    const mockOrderRepo: Partial<OrderRepo> = {
      findActiveOrderByMerchantOrderId: vi.fn().mockResolvedValue(orderWithoutTracking)
    };

    const mockRegistry: Partial<CourierRegistry> = {
      resolve: vi.fn()
    };

    const service = createOrderService(
      mockOrderRepo as OrderRepo,
      undefined,
      mockRegistry as CourierRegistry
    );

    await expect(service.cancelOrder('ORDER-CANCEL-1')).rejects.toThrow(ValidationError);
    expect(mockRegistry.resolve).not.toHaveBeenCalled();
  });

  it('maps CourierProviderError from adapter to normalized ApplicationError', async () => {
    const mockOrderRepo: Partial<OrderRepo> = {
      findActiveOrderByMerchantOrderId: vi.fn().mockResolvedValue(mockActiveOrder),
      updateCurrentState: vi.fn().mockResolvedValue(mockActiveOrder)
    };

    const mockAdapter: Partial<CourierAdapter> = {
      courierPartner: 'urbanebolt',
      cancelShipment: vi.fn().mockRejectedValue(
        new CourierProviderError({
          operation: 'cancel',
          kind: 'server',
          message: 'Courier internal error during cancellation',
          retryable: true
        })
      )
    };

    const mockRegistry: Partial<CourierRegistry> = {
      resolve: vi.fn().mockReturnValue(mockAdapter)
    };

    const service = createOrderService(
      mockOrderRepo as OrderRepo,
      undefined,
      mockRegistry as CourierRegistry
    );

    await expect(service.cancelOrder('ORDER-CANCEL-1')).rejects.toThrow(CourierUnavailableError);
    expect(mockOrderRepo.updateCurrentState).toHaveBeenCalledWith(
      '101',
      {
        failureCode: 'SERVER',
        failureMessage: 'Courier internal error during cancellation',
        failureRequestPayload: null,
        failureResponsePayload: null
      },
      undefined
    );
  });
});
