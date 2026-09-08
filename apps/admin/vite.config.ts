import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(import.meta.dirname),
  build: { outDir: resolve(import.meta.dirname, "../../dist/admin"), emptyOutDir: true },
  server: { port: 4173 }
});
