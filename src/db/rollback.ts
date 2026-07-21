import { db } from './knex.js';

async function rollbackDatabase(): Promise<void> {
  try {
    const [batch, migrations] = await db.migrate.rollback();
    console.log(JSON.stringify({ operation: 'rollback', batch, migrations }));
  } finally {
    await db.destroy();
  }
}

void rollbackDatabase();
