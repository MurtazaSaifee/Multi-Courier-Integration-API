import type { Knex } from 'knex';

type TrackingHistoryRecord = {
  id: string;
  order_id: string;
  status: string;
  status_at: Date;
  raw_payload: unknown;
};

type HistoryEventInput = {
  orderId: string;
  status: string;
  statusAt: Date;
  rawPayload: unknown;
};

export function createTrackingHistoryRepository(database: Knex) {
  return {
    async insertHistoryEvent(input: HistoryEventInput): Promise<TrackingHistoryRecord> {
      const [event] = await database<TrackingHistoryRecord>('tracking_history')
        .insert({
          order_id: input.orderId,
          status: input.status,
          status_at: input.statusAt,
          raw_payload: input.rawPayload
        })
        .returning('*');

      return event;
    }
  };
}
