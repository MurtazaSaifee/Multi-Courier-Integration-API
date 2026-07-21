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
    async insertHistoryEvent(input: HistoryEventInput, trx?: Knex): Promise<TrackingHistoryRecord> {
      const q = (trx ?? database)<TrackingHistoryRecord>('tracking_history');
      const [event] = await q
        .insert({
          order_id: input.orderId,
          status: input.status,
          status_at: input.statusAt,
          raw_payload: toJsonb(input.rawPayload) as any
        })
        .returning('*');

      return event;
    }
  };
}
