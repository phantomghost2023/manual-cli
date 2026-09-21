#!/usr/bin/env node
import path from 'node:path';
import { serveMcp } from '../src/mcp.js';

const rootIdx = process.argv.indexOf('--root');
const root = rootIdx !== -1 ? path.resolve(process.argv[rootIdx + 1]) : process.cwd();

serveMcp(root).then(() => process.exit(0)).catch((e) => {
  console.error('manual-mcp: fatal:', e);
  process.exit(2);
});
