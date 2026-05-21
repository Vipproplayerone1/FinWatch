import { Pool } from "pg";

declare global {
  // eslint-disable-next-line no-var
  var __pgPool: Pool | undefined;
}

function build(): Pool {
  return new Pool({
    host:     process.env.POSTGRES_HOST     ?? "postgres",
    port:     Number(process.env.POSTGRES_PORT ?? 5432),
    user:     process.env.POSTGRES_USER     ?? "finwatch",
    password: process.env.POSTGRES_PASSWORD ?? "",
    database: process.env.POSTGRES_DB       ?? "finwatch",
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

export const pg: Pool = global.__pgPool ?? build();
if (process.env.NODE_ENV !== "production") {
  global.__pgPool = pg;
}
