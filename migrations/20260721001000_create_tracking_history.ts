import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('tracking_history', (table) => {
    table.bigIncrements('id').primary();
    table.bigInteger('order_id').notNullable();
    table.text('status').notNullable();
    table.timestamp('status_at', { useTz: true }).notNullable();
    table.jsonb('raw_payload').notNullable();

    table
      .foreign('order_id', 'tracking_history_order_id_foreign')
      .references('id')
      .inTable('orders')
      .onDelete('RESTRICT');
    table.unique(['order_id', 'status', 'status_at'], {
      indexName: 'tracking_history_event_unique'
    });
    table.index(['order_id', 'status_at'], 'tracking_history_order_status_at_index');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('tracking_history');
}
