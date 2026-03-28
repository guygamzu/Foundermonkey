import knex, { Knex } from 'knex';

let db: Knex;

export function getDatabase(): Knex {
  if (!db) {
    const isProduction = process.env.NODE_ENV === 'production';
    db = knex({
      client: 'pg',
      connection: {
        connectionString: process.env.DATABASE_URL,
        ssl: isProduction ? { rejectUnauthorized: false } : false,
      },
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
