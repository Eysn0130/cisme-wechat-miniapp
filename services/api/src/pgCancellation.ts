import pg from "pg";
import type { EventEmitter } from "node:events";
import type { Socket } from "node:net";

/** Internal adapter deliberately pinned to root-lock pg 8.23.0. pg's public
 * Client.cancel sends before TLS negotiation, so it is not used for mTLS.
 * No SQL, password or backend secret is logged. One short-lived cancellation
 * transport per cancelled lease, not another connection pool or DB session.
 * Channel closure is NOT proof of cancellation: callers must still drain the
 * original query and preserve unknown COMMIT outcomes. */
interface DriverConnection extends EventEmitter {
  stream: Socket;
  connect(port: number | string, host?: string): void;
  requestSsl(): void;
  cancel(processID: number, secretKey: number | Buffer): void;
}
interface DriverClient extends pg.PoolClient {
  _getActiveQuery(): unknown;
  processID: number;
  secretKey: number | Buffer;
  host: string;
  port: number;
  ssl: pg.ClientConfig["ssl"];
  sslNegotiation?: string;
  connection: DriverConnection;
}

export async function requestPgCancellation(client: pg.PoolClient, timeoutMs = 1_000): Promise<void> {
  const target = client as DriverClient;
  const active = target._getActiveQuery?.();
  if (!active) return; // Nothing in flight; the budget prevents new statements.
  if (!Number.isInteger(target.processID) || target.secretKey == null) return;
  // Reuse the locked driver's own TLS negotiation and CancelRequest encoder.
  // In particular keep the original non-enumerable mTLS key and CA validation.
  const carrier = new pg.Client({ host: target.host, port: target.port, ssl: target.ssl,
    sslnegotiation: target.sslNegotiation } as pg.ClientConfig) as unknown as DriverClient;
  const channel = carrier.connection;
  await new Promise<void>(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      channel.stream.destroy();
      resolve();
    };
    const timer = setTimeout(finish, Math.max(1, Math.min(1_000, timeoutMs)));
    const send = () => {
      // A completed query must not allow a delayed cancellation to hit another
      // operation. The lease also waits for this channel before ROLLBACK/reuse.
      if (target._getActiveQuery() !== active) { finish(); return; }
      try { channel.cancel(target.processID, target.secretKey); } catch { finish(); }
    };
    channel.on("error", finish);
    channel.on("errorMessage", finish);
    channel.once("end", finish);
    channel.once("connect", () => {
      if (!target.ssl) send();
      else if (target.sslNegotiation !== "direct") channel.requestSsl();
    });
    channel.once("sslconnect", send);
    try {
      if (target.host.startsWith("/")) channel.connect(`${target.host}/.s.PGSQL.${target.port}`);
      else channel.connect(target.port, target.host);
    } catch { finish(); }
  });
}
