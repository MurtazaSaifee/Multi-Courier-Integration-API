import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('orders', (table) => {
    table.bigIncrements('id').primary();
    table.text('merchant_order_id').notNullable().unique();
    table.text('courier_partner').notNullable();
    table.text('courier_order_id');
    table.text('tracking_number');
    table.text('status').notNullable().defaultTo('PENDING');
    table.jsonb('normalized_request').notNullable();
    table.jsonb('courier_request_payload');
    table.jsonb('courier_response_payload');
    table.text('failure_code');
    table.text('failure_message');
    table.boolean('is_deleted').notNullable().defaultTo(false);
    table.timestamp('deleted_at', { useTz: true });
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.unique(['courier_partner', 'courier_order_id'], {
      indexName: 'orders_courier_order_unique'
    });
    table.unique(['courier_partner', 'tracking_number'], {
      indexName: 'orders_tracking_number_unique'
    });
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('orders');
}
