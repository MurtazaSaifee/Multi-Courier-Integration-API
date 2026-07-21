import type { Knex } from 'knex';

type OrderRecord = {
  id: string;
  merchant_order_id: string;
  courier_partner: string;
  courier_order_id: string | null;
  tracking_number: string | null;
  status: string;
  normalized_request: unknown;
  courier_request_payload: unknown | null;
  courier_response_payload: unknown | null;
  failure_code: string | null;
  failure_message: string | null;
  is_deleted: boolean;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type PendingOrderInput = {
  merchantOrderId: string;
  courierPartner: string;
  normalizedRequest: unknown;
};

type CurrentStateUpdate = {
  status: string;
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
    async insertPendingOrder(input: PendingOrderInput): Promise<OrderRecord> {
      const [order] = await database<OrderRecord>('orders')
        .insert({
          merchant_order_id: input.merchantOrderId,
          courier_partner: input.courierPartner,
          status: 'PENDING',
          normalized_request: input.normalizedRequest,
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
      state: CurrentStateUpdate
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
        changes.courier_request_payload = state.courierRequestPayload;
      }
      if (state.courierResponsePayload !== undefined) {
        changes.courier_response_payload = state.courierResponsePayload;
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

      const [order] = await database<OrderRecord>('orders')
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
