import { resetDatabase, seedTestCampaign, testPool } from "@cisme/testkit";

const pool = testPool();
await resetDatabase(pool);
await seedTestCampaign(pool);
await pool.end();
console.log("test database reset and seeded");
