import { expect } from 'vitest';
import { assertDisposableTarget, testPool } from '@cisme/testkit';

// Execute before integration files (and their cleanup hooks) are evaluated.
// This covers consumers constructing pg.Pool directly, not just resetDatabase.
if (expect.getState().testPath?.replaceAll('\\', '/').includes('/tests/integration/')) {
  const pool = testPool();
  try { await assertDisposableTarget(pool); } finally { await pool.end(); }
}
