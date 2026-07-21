import { db } from './knex.js';

async function checkDatabaseConnection(): Promise<void> {
  try {
    await db.raw('select 1');
    console.log(JSON.stringify({ operation: 'database_connection', status: 'ok' }));
  } finally {
    await db.destroy();
  }
}

void checkDatabaseConnection();
