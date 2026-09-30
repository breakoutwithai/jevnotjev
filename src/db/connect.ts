// Postgres connections from a libpq connection string (key=value pairs or a postgres:// URL).
// int8 is read as bigint; numeric stays a string, so no stored number passes through a JS float.

import postgres from "postgres";

export type Db = postgres.Sql<{ bigint: bigint }>;
/** Anything that runs a query: a pool, a reserved connection or a transaction. */
export type Query = postgres.ISql<{ bigint: bigint }>;

export interface ConnectionSettings {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  ssl?: "require" | "allow" | "prefer" | "verify-full" | boolean;
  connect_timeout?: number;
}

type SslMode = NonNullable<ConnectionSettings["ssl"]>;

function sslMode(value: string): SslMode {
  switch (value) {
    case "disable":
      return false;
    case "allow":
    case "prefer":
    case "require":
    case "verify-full":
      return value;
    default:
      throw new Error(`sslmode ${value} is not supported`);
  }
}

function integer(key: string, value: string): number {
  if (!/^[0-9]+$/.test(value)) throw new Error(`connection keyword ${key} must be an integer`);
  return Number(value);
}

/** libpq key=value pairs: values may be single-quoted; a backslash escapes the next character. */
function keywordPairs(conninfo: string): [string, string][] {
  const pairs: [string, string][] = [];
  let i = 0;
  const skipSpace = (): void => {
    while (i < conninfo.length && /\s/.test(conninfo[i] ?? "")) i++;
  };
  while (true) {
    skipSpace();
    if (i >= conninfo.length) return pairs;
    let key = "";
    while (i < conninfo.length && !/[\s=]/.test(conninfo[i] ?? "")) key += conninfo[i++];
    skipSpace();
    if (conninfo[i] !== "=") throw new Error(`missing "=" after "${key}" in connection string`);
    i++;
    skipSpace();
    let value = "";
    if (conninfo[i] === "'") {
      i++;
      while (i < conninfo.length && conninfo[i] !== "'") {
        if (conninfo[i] === "\\") i++;
        value += conninfo[i++] ?? "";
      }
      if (conninfo[i] !== "'") throw new Error("unterminated quoted value in connection string");
      i++;
    } else {
      while (i < conninfo.length && !/\s/.test(conninfo[i] ?? "")) {
        if (conninfo[i] === "\\") i++;
        value += conninfo[i++] ?? "";
      }
    }
    pairs.push([key, value]);
  }
}

/**
 * Settings from a libpq connection string. A later keyword wins, as in libpq. No value is ever echoed.
 * The secret is never read from the string: postgres.js takes it from the PGPASSWORD environment variable.
 */
export function parseConninfo(conninfo: string): ConnectionSettings {
  if (/^postgres(ql)?:\/\//.test(conninfo)) {
    const url = new URL(conninfo);
    const settings: ConnectionSettings = {};
    const host = url.searchParams.get("host") ?? decodeURIComponent(url.hostname);
    if (host) settings.host = host;
    if (url.port) settings.port = integer("port", url.port);
    const database = decodeURIComponent(url.pathname.slice(1));
    if (database) settings.database = database;
    if (url.username) settings.user = decodeURIComponent(url.username);
    if (/^postgres(ql)?:\/\/[^/@]*:[^/@]*@/.test(conninfo)) {
      throw new Error("put the secret in PGPASSWORD, not in the connection string");
    }
    const ssl = url.searchParams.get("sslmode");
    if (ssl) settings.ssl = sslMode(ssl);
    return settings;
  }
  const settings: ConnectionSettings = {};
  for (const [key, value] of keywordPairs(conninfo)) {
    switch (key) {
      case "host":
        settings.host = value;
        break;
      case "port":
        settings.port = integer(key, value);
        break;
      case "dbname":
        settings.database = value;
        break;
      case "user":
        settings.user = value;
        break;
      case "sslmode":
        settings.ssl = sslMode(value);
        break;
      case "connect_timeout":
        settings.connect_timeout = integer(key, value);
        break;
      default:
        throw new Error(`connection keyword ${key} is not supported`);
    }
  }
  return settings;
}

export interface ConnectOptions {
  /** Pool size; 1 pins every query to one session (SET ROLE, temp tables). */
  max?: number;
  database?: string;
  /** Called with every query's parameters (tests use it to see what is sent). */
  debug?: (connection: number, query: string, parameters: readonly unknown[]) => void;
}

/** A connection pool for a libpq connection string. Notices are not printed. */
export function connect(conninfo: string, options: ConnectOptions = {}): Db {
  const settings = parseConninfo(conninfo);
  return postgres({
    ...settings,
    ...(options.database === undefined ? {} : { database: options.database }),
    ...(options.max === undefined ? {} : { max: options.max }),
    ...(options.debug === undefined ? {} : { debug: options.debug }),
    types: { bigint: postgres.BigInt },
    onnotice: () => undefined,
  });
}
