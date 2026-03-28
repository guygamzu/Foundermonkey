import knex, { Knex } from 'knex';

let db: Knex;

export function getDatabase(): Knex {
  if (!db) {
    db = knex({
      client: 'pg',
      connection: process.env.DATABASE_URL,
      pool: { min: 2, max: 20 },
      migrations: {
        directory: __dirname + '/../../migrations',
        extension: 'ts',
      },
    });
  }
  return db;
}

export async function runMigrations(): Promise<void> {
  const database = getDatabase();
  await database.migrate.latest();
}
