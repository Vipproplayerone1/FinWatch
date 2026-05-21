import { createClient, type ClickHouseClient } from "@clickhouse/client";

declare global {
  // eslint-disable-next-line no-var
  var __chClient: ClickHouseClient | undefined;
}

function build(): ClickHouseClient {
  const host = process.env.CLICKHOUSE_HOST ?? "clickhouse";
  const port = process.env.CLICKHOUSE_PORT ?? "8123";
  return createClient({
    url: `http://${host}:${port}`,
    username: process.env.CLICKHOUSE_USER ?? "default",
    password: process.env.CLICKHOUSE_PASSWORD ?? "",
    database: process.env.CLICKHOUSE_DATABASE ?? "finwatch",
    request_timeout: 5_000,
    clickhouse_settings: {
      output_format_json_quote_64bit_integers: 0,
    },
  });
}

export const ch: ClickHouseClient = global.__chClient ?? build();
if (process.env.NODE_ENV !== "production") {
  global.__chClient = ch;
}

export async function query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  const rs = await ch.query({ query: sql, format: "JSONEachRow" });
  return (await rs.json()) as T[];
}
