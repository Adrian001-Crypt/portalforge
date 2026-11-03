#!/usr/bin/env node
// Thin launcher: runs the TypeScript CLI through tsx (installed in the monorepo).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const r = spawnSync(process.execPath, ['--import', 'tsx', join(here, '..', 'src', 'main.ts'), ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? 1);
