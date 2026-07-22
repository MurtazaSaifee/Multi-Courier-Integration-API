import { describe, expect, it, vi } from 'vitest';

import type { CourierAdapter } from '../src/couriers/courier-adapter.js';
import type { CourierRegistry } from '../src/couriers/courier-registry.js';
import type { createOrderRepository } from '../src/db/repositories/order-repository.js';
import type { createTrackingHistoryRepository } from '../src/db/repositories/tracking-history-repository.js';
import type {
  CourierTrackResult,
  OrderRecord,
  TrackOrderResponse
} from '../src/domain/contracts.js';
import { CourierProviderError } from '../src/couriers/courier-adapter.js';
import {
  OrderNotFoundError,
  ValidationError,
  CourierUnavailableError
} from '../src/errors/application-error.js';
import { createOrderService } from '../src/services/order-service.js';

import { createSampleOrderRequest } from './helpers/sample-order-request.js';

type OrderRepo = ReturnType<typeof createOrderRepository>;
type HistoryRepo = ReturnType<typeof createTrackingHistoryRepository>;

const sampleRequest = createSampleOrderRequest({ order_id: 'ORDER-TRACK-1' });

const mockOrder: OrderRecord = {
  id: '100',
  merchant_order_id: 'ORDER-TRACK-1',
  courier_partner: 'urbanebolt',
  courier_order_id: 'UB-999',
  tracking_number: 'UB-AWB-12345',
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

describe('Order Service Tracking Flow (P5-T1)', () => {
  it('finds active order, invokes adapter with stored tracking number, updates current order state, inserts tracking history event, and returns normalized TrackOrderResponse', async () => {
    const mockOrderRepo: Partial<OrderRepo> = {
      findActiveOrderByMerchantOrderId: vi.fn().mockResolvedValue(mockOrder),
      updateCurrentState: vi.fn().mockResolvedValue({
        ...mockOrder,
        status: 'IN_TRANSIT'
      })
    };

    const mockHistoryRepo: Partial<HistoryRepo> = {
      insertHistoryEvents: vi.fn().mockResolvedValue([
        {
          id: '1',
          order_id: '100',
          status: 'IN_TRANSIT',
          status_at: new Date(),
          raw_payload: { status: 'IN_TRANSIT' }
        }
      ])
    };

    const trackResult: CourierTrackResult = {
      response: {
        order_id: 'UB-999',
        courier_partner: 'urbanebolt',
        tracking_number: 'UB-AWB-12345',
        status: 'IN_TRANSIT',
        status_updated_at: '2026-07-21T10:00:00.000Z',
        events: [
          {
            status: 'IN_TRANSIT',
            status_at: '2026-07-21T10:00:00.000Z',
            location: 'Mumbai Hub',
            description: 'In transit to destination'
          }
        ]
      },
      raw_response: { raw: 'data' }
    };

    const mockAdapter: Partial<CourierAdapter> = {
      courierPartner: 'urbanebolt',
      trackShipment: vi.fn().mockResolvedValue(trackResult)
    };

    const mockRegistry: Partial<CourierRegistry> = {
      resolve: vi.fn().mockReturnValue(mockAdapter)
    };

    const service = createOrderService(
      mockOrderRepo as OrderRepo,
      mockHistoryRepo as HistoryRepo,
      mockRegistry as CourierRegistry
    );

    const result = await service.trackOrder('ORDER-TRACK-1');

    expect(mockOrderRepo.findActiveOrderByMerchantOrderId).toHaveBeenCalledWith('ORDER-TRACK-1');
    expect(mockRegistry.resolve).toHaveBeenCalledWith('urbanebolt');
    expect(mockAdapter.trackShipment).toHaveBeenCalledWith({
      courier_order_id: 'UB-999',
      tracking_number: 'UB-AWB-12345'
    });
    expect(mockOrderRepo.updateCurrentState).toHaveBeenCalledWith(
      '100',
      {
        status: 'IN_TRANSIT',
        courierResponsePayload: { raw: 'data' },
        failureRequestPayload: null,
        failureResponsePayload: null,
        failureCode: null,
        failureMessage: null
      },
      undefined
    );
    expect(mockHistoryRepo.insertHistoryEvents).toHaveBeenCalledWith(
      [
        {
          orderId: '100',
          status: 'IN_TRANSIT',
          statusAt: new Date('2026-07-21T10:00:00.000Z'),
          rawPayload: { raw: 'data' }
        }
      ],
      undefined
    );

    expect(result).toEqual({
      order_id: 'ORDER-TRACK-1',
      courier_partner: 'urbanebolt',
      tracking_number: 'UB-AWB-12345',
      status: 'IN_TRANSIT',
      status_updated_at: '2026-07-21T10:00:00.000Z',
      events: [
        {
          status: 'IN_TRANSIT',
          status_at: '2026-07-21T10:00:00.000Z',
          location: 'Mumbai Hub',
          description: 'In transit to destination'
        }
      ]
    });
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

    await expect(service.trackOrder('NON_EXISTENT_ORDER')).rejects.toThrow(OrderNotFoundError);
    expect(mockRegistry.resolve).not.toHaveBeenCalled();
  });

  it('throws ValidationError when active order exists but has no tracking_number', async () => {
    const orderWithoutTracking: OrderRecord = {
      ...mockOrder,
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

    await expect(service.trackOrder('ORDER-TRACK-1')).rejects.toThrow(ValidationError);
    expect(mockRegistry.resolve).not.toHaveBeenCalled();
  });

  it('handles duplicate history event gracefully without failing tracking operation', async () => {
    const mockOrderRepo: Partial<OrderRepo> = {
      findActiveOrderByMerchantOrderId: vi.fn().mockResolvedValue(mockOrder),
      updateCurrentState: vi.fn().mockResolvedValue(mockOrder)
    };

    const mockHistoryRepo: Partial<HistoryRepo> = {
      insertHistoryEvents: vi.fn().mockResolvedValue([])
    };

    const trackResult: CourierTrackResult = {
      response: {
        order_id: 'UB-999',
        courier_partner: 'urbanebolt',
        tracking_number: 'UB-AWB-12345',
        status: 'CREATED',
        status_updated_at: '2026-07-21T10:00:00.000Z',
        events: []
      },
      raw_response: { raw: 'data' }
    };

    const mockAdapter: Partial<CourierAdapter> = {
      courierPartner: 'urbanebolt',
      trackShipment: vi.fn().mockResolvedValue(trackResult)
    };

    const mockRegistry: Partial<CourierRegistry> = {
      resolve: vi.fn().mockReturnValue(mockAdapter)
    };

    const service = createOrderService(
      mockOrderRepo as OrderRepo,
      mockHistoryRepo as HistoryRepo,
      mockRegistry as CourierRegistry
    );

    const result = await service.trackOrder('ORDER-TRACK-1');
    expect(result.status).toBe('CREATED');
  });

  it('maps CourierProviderError from adapter to normalized ApplicationError', async () => {
    const mockOrderRepo: Partial<OrderRepo> = {
      findActiveOrderByMerchantOrderId: vi.fn().mockResolvedValue(mockOrder),
      updateCurrentState: vi.fn().mockResolvedValue(mockOrder)
    };

    const mockAdapter: Partial<CourierAdapter> = {
      courierPartner: 'urbanebolt',
      trackShipment: vi.fn().mockRejectedValue(
        new CourierProviderError({
          operation: 'track',
          kind: 'server',
          message: 'Courier internal error',
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

    await expect(service.trackOrder('ORDER-TRACK-1')).rejects.toThrow(CourierUnavailableError);
    expect(mockOrderRepo.updateCurrentState).toHaveBeenCalledWith(
      '100',
      {
        failureCode: 'SERVER',
        failureMessage: 'Courier internal error',
        failureRequestPayload: null,
        failureResponsePayload: null
      },
      undefined
    );
  });
});
