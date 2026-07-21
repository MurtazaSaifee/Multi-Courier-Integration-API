import { db } from './knex.js';

async function migrateDatabase(): Promise<void> {
  try {
    const [batch, migrations] = await db.migrate.latest();
    console.log(JSON.stringify({ operation: 'migrate', batch, migrations }));
  } finally {
    await db.destroy();
  }
}

void migrateDatabase();
