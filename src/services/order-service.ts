import type { Knex } from 'knex';

import type { createOrderRepository } from '../db/repositories/order-repository.js';
import type { createTrackingHistoryRepository } from '../db/repositories/tracking-history-repository.js';
import {
  type CourierRegistry,
  courierRegistry
} from '../couriers/courier-registry.js';
import { CourierProviderError } from '../couriers/courier-adapter.js';
import type {
  CourierTrackResult,
  CreateOrderRequest,
  CreateOrderResponse,
  OrderRecord,
  TrackOrderResponse
} from '../domain/contracts.js';
import {
  ApplicationError,
  CourierAuthFailedError,
  CourierRejectedError,
  CourierUnavailableError,
  mapCourierProviderError,
  OrderIdConflictError,
  OrderInProgressError,
  OrderNotFoundError,
  ValidationError
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
  registry: CourierRegistry = courierRegistry,
  db?: Knex
) {
  const withTransaction = async <T>(fn: (trx?: Knex) => Promise<T>): Promise<T> => {
    if (db) {
      return db.transaction((trx) => fn(trx));
    }
    return fn(undefined);
  };

  return {
    async reserveOrder(request: CreateOrderRequest): Promise<ReservationResult> {
      const existing = await orderRepository.findByMerchantOrderId(request.order_id);

      if (existing) {
        if (!areRequestsEqual(existing.normalized_request, request)) {
          throw new OrderIdConflictError(request.order_id);
        }

        if (existing.status === 'PENDING') {
          throw new OrderInProgressError(request.order_id);
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
            if (!areRequestsEqual(concurrentExisting.normalized_request, request)) {
              throw new OrderIdConflictError(request.order_id);
            }

            if (concurrentExisting.status === 'PENDING') {
              throw new OrderInProgressError(request.order_id);
            }

            return {
              status: 'existing',
              order: concurrentExisting,
              response: buildCreateOrderResponse(concurrentExisting)
            };
          }
          throw new OrderInProgressError(request.order_id);
        }
        throw error;
      }
    },

    async createOrder(request: CreateOrderRequest): Promise<CreateOrderResponse> {
      const adapter = registry.resolve(request.courier_partner);
      const reservation = await this.reserveOrder(request);

      if (reservation.status === 'existing') {
        if (reservation.response) {
          return reservation.response;
        }
        if (reservation.order.status === 'FAILED') {
          const failureCode = (reservation.order.failure_code || '').toUpperCase();

          switch (failureCode) {
            case 'AUTHENTICATION':
            case 'COURIER_AUTH_FAILED':
              throw new CourierAuthFailedError();
            case 'SERVER':
            case 'TIMEOUT':
            case 'NETWORK':
            case 'COURIER_UNAVAILABLE':
              throw new CourierUnavailableError();
            case 'CLIENT':
            case 'COURIER_REJECTED':
            default:
              throw new CourierRejectedError();
          }
        }
        const response = buildCreateOrderResponse(reservation.order);
        if (response) {
          return response;
        }
        throw new ApplicationError('INTERNAL_ERROR', 'Order response could not be constructed');
      }

      const order = reservation.order;

      try {
        const result = await adapter.createShipment(request);

        await withTransaction(async (trx) => {
          await orderRepository.updateCurrentState(
            order.id,
            {
              status: result.response.status,
              courierOrderId: result.response.courier_order_id,
              trackingNumber: result.response.tracking_number,
              courierRequestPayload: result.raw_request,
              courierResponsePayload: result.raw_response
            },
            trx
          );

          if (trackingHistoryRepository) {
            await trackingHistoryRepository.insertHistoryEvent(
              {
                orderId: order.id,
                status: result.response.status,
                statusAt: new Date(),
                rawPayload: result.raw_response
              },
              trx
            );
          }
        });

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

        await withTransaction(async (trx) => {
          await orderRepository.updateCurrentState(
            order.id,
            {
              status: 'FAILED',
              failureCode,
              failureMessage,
              ...(rawRequestPayload !== undefined ? { courierRequestPayload: rawRequestPayload } : {}),
              ...(rawResponsePayload !== undefined ? { courierResponsePayload: rawResponsePayload } : {})
            },
            trx
          );

          if (trackingHistoryRepository) {
            await trackingHistoryRepository.insertHistoryEvent(
              {
                orderId: order.id,
                status: 'FAILED',
                statusAt: new Date(),
                rawPayload: rawResponsePayload ?? { error: failureMessage }
              },
              trx
            );
          }
        });

        if (error instanceof CourierProviderError) {
          throw mapCourierProviderError(error);
        }

        throw error;
      }
    },

    async trackOrder(merchantOrderId: string): Promise<TrackOrderResponse> {
      const order = await orderRepository.findActiveOrderByMerchantOrderId(merchantOrderId);
      if (!order) {
        throw new OrderNotFoundError(merchantOrderId);
      }

      if (!order.tracking_number) {
        throw new ValidationError([
          {
            field: 'tracking_number',
            message: `Order '${merchantOrderId}' does not have a tracking number to track`
          }
        ]);
      }

      const adapter = registry.resolve(order.courier_partner);
      let trackResult: CourierTrackResult;

      try {
        trackResult = await adapter.trackShipment({
          courier_order_id: order.courier_order_id,
          tracking_number: order.tracking_number
        });
      } catch (error: any) {
        if (error instanceof CourierProviderError) {
          throw mapCourierProviderError(error);
        }
        throw error;
      }

      await withTransaction(async (trx) => {
        await orderRepository.updateCurrentState(
          order.id,
          {
            status: trackResult.response.status,
            courierResponsePayload: trackResult.raw_response
          },
          trx
        );

        if (trackingHistoryRepository) {
          const eventsToPersist = trackResult.response.events.length > 0
            ? trackResult.response.events
            : [{
                status: trackResult.response.status,
                status_at: trackResult.response.status_updated_at
              }];

          for (const evt of eventsToPersist) {
            try {
              await trackingHistoryRepository.insertHistoryEvent(
                {
                  orderId: order.id,
                  status: evt.status,
                  statusAt: new Date(evt.status_at),
                  rawPayload: trackResult.raw_response
                },
                trx
              );
            } catch (err: any) {
              if (err?.code !== '23505') {
                throw err;
              }
            }
          }
        }
      });

      return {
        ...trackResult.response,
        order_id: order.merchant_order_id
      };
    }
  };
}
