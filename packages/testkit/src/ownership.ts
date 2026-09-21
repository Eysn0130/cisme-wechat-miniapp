import type pg from "pg";

/** A URL is a destination, not permission to destroy it. Only the disposable
 * launcher issues this short-lived capability, bound to its actual instance. */
export function resetCapability(env: NodeJS.ProcessEnv) {
  const url = env.TEST_DATABASE_URL;
  if (!url) throw new Error("EXPLICIT_TEST_DATABASE_URL_REQUIRED");
  const parsed = new URL(url);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) ||
      parsed.hostname !== "127.0.0.1" || !parsed.port || parsed.port === "55432" ||
      parsed.search || parsed.hash) throw new Error("DISPOSABLE_TEST_ENDPOINT_REQUIRED");
  const runId = env.CISME_TEST_RUN_ID;
  const token = env.CISME_TEST_RESET_TOKEN;
  if (!runId || !/^[a-f0-9]{24}$/.test(runId) || !token || !/^[a-f0-9]{64}$/.test(token) ||
      env.CISME_TEST_OWNED_URL !== url || env.CISME_TEST_RESET_AUTHORIZED !== "disposable-only")
    throw new Error("DISPOSABLE_TEST_OWNERSHIP_REQUIRED");
  if (parsed.pathname !== `/cisme_test_${runId}` || parsed.username !== `runner_${runId}`)
    throw new Error("DISPOSABLE_TEST_TARGET_MISMATCH");
  return { runId, token, database: parsed.pathname.slice(1), role: parsed.username };
}

export async function assertDisposableTarget(client: Pick<pg.PoolClient, "query">,
  env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const expected = resetCapability(env);
  const result = await client.query(`SELECT current_database() AS database, current_user AS role,
    run_id, token, purpose, reset_authorized,
    instance_started_at = pg_postmaster_start_time() AS same_instance,
    server_address = inet_server_addr()::text AND server_port = inet_server_port() AS same_endpoint
    FROM cisme_test_control.ownership`);
  const row = result.rows[0];
  if (result.rows.length !== 1 || !row || row.database !== expected.database || row.role !== expected.role ||
      row.run_id !== expected.runId || row.token !== expected.token || row.purpose !== "disposable-synthetic" ||
      row.reset_authorized !== true || row.same_instance !== true || row.same_endpoint !== true)
    throw new Error("DISPOSABLE_TEST_TARGET_MISMATCH");
}
