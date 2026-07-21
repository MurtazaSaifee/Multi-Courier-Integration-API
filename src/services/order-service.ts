import type { createOrderRepository } from '../db/repositories/order-repository.js';
import type {
  CreateOrderRequest,
  CreateOrderResponse,
  OrderRecord
} from '../domain/contracts.js';
import {
  OrderIdConflictError,
  OrderInProgressError
} from '../errors/application-error.js';

export type OrderRepository = ReturnType<typeof createOrderRepository>;

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

export function createOrderService(orderRepository: OrderRepository) {
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
    }
  };
}
