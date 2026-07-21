import type { createOrderRepository } from '../db/repositories/order-repository.js';
import type { createTrackingHistoryRepository } from '../db/repositories/tracking-history-repository.js';
import {
  type CourierRegistry,
  courierRegistry
} from '../couriers/courier-registry.js';
import { CourierProviderError } from '../couriers/courier-adapter.js';
import type {
  CreateOrderRequest,
  CreateOrderResponse,
  OrderRecord
} from '../domain/contracts.js';
import {
  ApplicationError,
  OrderIdConflictError,
  OrderInProgressError
} from '../errors/application-error.js';

export type OrderRepository = ReturnType<typeof createOrderRepository>;
export type TrackingHistoryRepository = ReturnType<typeof createTrackingHistoryRepository>;

export type ReservationResult =
  | { status: 'reserved'; order: OrderRecord }
  | { status: 'existing'; order: OrderRecord; response?: CreateOrderResponse };

function canonicalize(val: unknown): unknown {
  if (val === null || typeof val !== 'object') {
    return val;
  }
  if (Array.isArray(val)) {
    return val.map(canonicalize);
  }
  const obj = val as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (obj[key] !== undefined) {
      result[key] = canonicalize(obj[key]);
    }
  }
  return result;
}

export function areRequestsEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}

export function buildCreateOrderResponse(order: OrderRecord): CreateOrderResponse | undefined {
  if (order.courier_order_id && order.tracking_number) {
    return {
      order_id: order.merchant_order_id,
      courier_partner: order.courier_partner,
      courier_order_id: order.courier_order_id,
      tracking_number: order.tracking_number,
      status: order.status
    };
  }
  return undefined;
}

export function createOrderService(
  orderRepository: OrderRepository,
  trackingHistoryRepository?: TrackingHistoryRepository,
  registry: CourierRegistry = courierRegistry
) {
  return {
    async reserveOrder(request: CreateOrderRequest): Promise<ReservationResult> {
      const existing = await orderRepository.findByMerchantOrderId(request.order_id);

      if (existing) {
        if (existing.status === 'PENDING') {
          throw new OrderInProgressError(request.order_id);
        }

        if (!areRequestsEqual(existing.normalized_request, request)) {
          throw new OrderIdConflictError(request.order_id);
        }

        return {
          status: 'existing',
          order: existing,
          response: buildCreateOrderResponse(existing)
        };
      }

      try {
        const order = await orderRepository.insertPendingOrder({
          merchantOrderId: request.order_id,
          courierPartner: request.courier_partner,
          normalizedRequest: request
        });

        return { status: 'reserved', order };
      } catch (error: any) {
        if (error?.code === '23505') {
          const concurrentExisting = await orderRepository.findByMerchantOrderId(request.order_id);
          if (concurrentExisting) {
            if (concurrentExisting.status === 'PENDING') {
              throw new OrderInProgressError(request.order_id);
            }

            if (!areRequestsEqual(concurrentExisting.normalized_request, request)) {
              throw new OrderIdConflictError(request.order_id);
            }

            return {
              status: 'existing',
              order: concurrentExisting,
              response: buildCreateOrderResponse(concurrentExisting)
            };
          }
        }
        throw error;
      }
    },

    async createOrder(request: CreateOrderRequest): Promise<CreateOrderResponse> {
      const reservation = await this.reserveOrder(request);

      if (reservation.status === 'existing') {
        if (reservation.response) {
          return reservation.response;
        }
        if (reservation.order.status === 'FAILED') {
          throw new ApplicationError(
            'COURIER_REJECTED',
            reservation.order.failure_message || 'Order creation previously failed'
          );
        }
        return {
          order_id: reservation.order.merchant_order_id,
          courier_partner: reservation.order.courier_partner,
          courier_order_id: reservation.order.courier_order_id ?? '',
          tracking_number: reservation.order.tracking_number ?? '',
          status: reservation.order.status
        };
      }

      const order = reservation.order;
      const adapter = registry.resolve(request.courier_partner);

      try {
        const result = await adapter.createShipment(request);

        await orderRepository.updateCurrentState(order.id, {
          status: result.response.status,
          courierOrderId: result.response.courier_order_id,
          trackingNumber: result.response.tracking_number,
          courierRequestPayload: result.raw_request,
          courierResponsePayload: result.raw_response
        });

        if (trackingHistoryRepository) {
          await trackingHistoryRepository.insertHistoryEvent({
            orderId: order.id,
            status: result.response.status,
            statusAt: new Date(),
            rawPayload: result.raw_response
          });
        }

        return result.response;
      } catch (error: any) {
        const failureCode = error instanceof CourierProviderError
          ? error.kind.toUpperCase()
          : error.name || 'COURIER_ERROR';

        const failureMessage = error.message || 'Failed to create shipment';

        const rawRequestPayload = error instanceof CourierProviderError
          ? error.rawRequestPayload
          : undefined;

        const rawResponsePayload = error instanceof CourierProviderError
          ? error.rawResponsePayload
          : undefined;

        await orderRepository.updateCurrentState(order.id, {
          status: 'FAILED',
          failureCode,
          failureMessage,
          ...(rawRequestPayload !== undefined ? { courierRequestPayload: rawRequestPayload } : {}),
          ...(rawResponsePayload !== undefined ? { courierResponsePayload: rawResponsePayload } : {})
        });

        if (trackingHistoryRepository) {
          await trackingHistoryRepository.insertHistoryEvent({
            orderId: order.id,
            status: 'FAILED',
            statusAt: new Date(),
            rawPayload: rawResponsePayload ?? { error: failureMessage }
          });
        }

        throw error;
      }
    }
  };
}
