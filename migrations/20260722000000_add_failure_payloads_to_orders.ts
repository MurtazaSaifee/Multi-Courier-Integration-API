import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('orders', (table) => {
    table.jsonb('failure_request_payload');
    table.jsonb('failure_response_payload');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('orders', (table) => {
    table.dropColumn('failure_request_payload');
    table.dropColumn('failure_response_payload');
  });
}
