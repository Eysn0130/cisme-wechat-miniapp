import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { setupFiles: ['tests/setup/database-target.ts'] } });
