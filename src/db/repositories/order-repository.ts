import type { Knex } from 'knex';

import type {
  CreateOrderRequest,
  NormalizedStatus,
  OrderRecord
} from '../../domain/contracts.js';
import { toJsonb } from '../json.js';

type PendingOrderInput = {
  merchantOrderId: string;
  courierPartner: string;
  normalizedRequest: CreateOrderRequest;
};

type CurrentStateUpdate = {
  status: NormalizedStatus;
  courierOrderId?: string | null;
  trackingNumber?: string | null;
  courierRequestPayload?: unknown | null;
  courierResponsePayload?: unknown | null;
  failureCode?: string | null;
  failureMessage?: string | null;
  isDeleted?: boolean;
  deletedAt?: Date | null;
};

function activeOrders(database: Knex) {
  return database<OrderRecord>('orders')
    .where('is_deleted', false)
    .whereNull('deleted_at');
}

export function createOrderRepository(database: Knex) {
  return {
    async insertPendingOrder(input: PendingOrderInput, trx?: Knex): Promise<OrderRecord> {
      const q = (trx ?? database)<OrderRecord>('orders');
      const [order] = await q
        .insert({
          merchant_order_id: input.merchantOrderId,
          courier_partner: input.courierPartner,
          status: 'PENDING',
          normalized_request: toJsonb(input.normalizedRequest) as any,
          is_deleted: false
        })
        .returning('*');

      return order;
    },

    async findByMerchantOrderId(merchantOrderId: string): Promise<OrderRecord | undefined> {
      return database<OrderRecord>('orders')
        .where('merchant_order_id', merchantOrderId)
        .first();
    },

    async findActiveOrderByMerchantOrderId(
      merchantOrderId: string
    ): Promise<OrderRecord | undefined> {
      return activeOrders(database)
        .where('merchant_order_id', merchantOrderId)
        .first();
    },

    async findActiveOrders(): Promise<OrderRecord[]> {
      return activeOrders(database).orderBy('created_at', 'asc');
    },

    async updateCurrentState(
      orderId: string | number,
      state: CurrentStateUpdate,
      trx?: Knex
    ): Promise<OrderRecord | undefined> {
      const changes: Record<string, unknown> = {
        status: state.status,
        updated_at: database.fn.now()
      };

      if (state.courierOrderId !== undefined) {
        changes.courier_order_id = state.courierOrderId;
      }
      if (state.trackingNumber !== undefined) {
        changes.tracking_number = state.trackingNumber;
      }
      if (state.courierRequestPayload !== undefined) {
        changes.courier_request_payload = toJsonb(state.courierRequestPayload);
      }
      if (state.courierResponsePayload !== undefined) {
        changes.courier_response_payload = toJsonb(state.courierResponsePayload);
      }
      if (state.failureCode !== undefined) {
        changes.failure_code = state.failureCode;
      }
      if (state.failureMessage !== undefined) {
        changes.failure_message = state.failureMessage;
      }
      if (state.isDeleted !== undefined) {
        changes.is_deleted = state.isDeleted;
      }
      if (state.deletedAt !== undefined) {
        changes.deleted_at = state.deletedAt;
      }

      const q = (trx ?? database)<OrderRecord>('orders');
      const [order] = await q
        .where('id', orderId)
        .update(changes)
        .returning('*');

      return order;
    },

    async listFailedOrders(limit?: number): Promise<OrderRecord[]> {
      const query = activeOrders(database)
        .where('status', 'FAILED')
        .orderBy('updated_at', 'asc');

      if (limit !== undefined) {
        query.limit(limit);
      }

      return query;
    }
  };
}
