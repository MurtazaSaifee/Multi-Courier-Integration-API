import path from 'node:path';

import knex, { type Knex } from 'knex';

import { config } from '../config.js';

const migrationsDirectory = path.resolve(process.cwd(), 'migrations');

export const databaseConfig: Knex.Config = {
  client: 'pg',
  connection: config.databaseUrl,
  pool: {
    min: 0,
    max: 10
  },
  migrations: {
    directory: migrationsDirectory,
    extension: 'ts',
    loadExtensions: ['.ts']
  }
};

export const db = knex(databaseConfig);
