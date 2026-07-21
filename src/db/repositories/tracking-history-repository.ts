import type { Knex } from 'knex';

import type {
  NormalizedStatus,
  TrackingHistoryRecord
} from '../../domain/contracts.js';
import { toJsonb } from '../json.js';

type HistoryEventInput = {
  orderId: string;
  status: NormalizedStatus;
  statusAt: Date;
  rawPayload: unknown;
};

export function createTrackingHistoryRepository(database: Knex) {
  return {
    async insertHistoryEvent(input: HistoryEventInput, trx?: Knex): Promise<TrackingHistoryRecord | undefined> {
      const q = (trx ?? database)<TrackingHistoryRecord>('tracking_history');
      const [event] = await q
        .insert({
          order_id: input.orderId,
          status: input.status,
          status_at: input.statusAt,
          raw_payload: toJsonb(input.rawPayload) as any
        })
        .onConflict(['order_id', 'status', 'status_at'])
        .ignore()
        .returning('*');

      return event;
    },

    async insertHistoryEvents(inputs: HistoryEventInput[], trx?: Knex): Promise<TrackingHistoryRecord[]> {
      if (inputs.length === 0) {
        return [];
      }

      const rows = inputs.map((input) => ({
        order_id: input.orderId,
        status: input.status,
        status_at: input.statusAt,
        raw_payload: toJsonb(input.rawPayload) as any
      }));

      const q = (trx ?? database)<TrackingHistoryRecord>('tracking_history');
      return q
        .insert(rows)
        .onConflict(['order_id', 'status', 'status_at'])
        .ignore()
        .returning('*');
    }
  };
}
