import { defineConfig } from 'vitest/config';

// One in-memory MongoDB replica set per file; first run downloads mongod (~100 MB, cached).
export default defineConfig({ test: { environment: 'node', testTimeout: 30_000, hookTimeout: 180_000, fileParallelism: false } });
