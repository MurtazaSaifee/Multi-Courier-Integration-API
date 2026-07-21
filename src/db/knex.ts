import path from 'node:path';

import knex, { type Knex } from 'knex';

import { config } from '../config.js';

const migrationsDirectory = path.resolve(process.cwd(), 'migrations');

const parsedUrl = new URL(config.databaseUrl);

export const databaseConfig: Knex.Config = {
  client: 'pg',
  connection: {
    host: parsedUrl.hostname,
    port: Number(parsedUrl.port || 5432),
    user: parsedUrl.username,
    password: String(parsedUrl.password),
    database: parsedUrl.pathname.replace(/^\//, '')
  },
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
