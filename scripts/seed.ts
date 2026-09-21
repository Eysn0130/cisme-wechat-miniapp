import pg from "pg";
import { assertDisposableTarget } from "@cisme/testkit";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("EXPLICIT_DATABASE_URL_REQUIRED");
const pool = new pg.Pool({ connectionString });
await assertDisposableTarget(pool);
await pool.query(`
  INSERT INTO eligibility_campaign
    (code, qualifying_milestone, capacity, reward_points, starts_at, ends_at, active)
  VALUES ('care-d7-story-r0', 'D7', 50, 300, '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', true)
  ON CONFLICT (code) DO NOTHING
`);
await pool.query(`
  INSERT INTO principal_role(principal_id, role)
  VALUES ('admin-reviewer','reviewer'), ('admin-lead','review_lead'), ('admin-auditor','auditor')
  ON CONFLICT DO NOTHING
`);
await pool.end();
console.log("seeded campaign and review principals");
