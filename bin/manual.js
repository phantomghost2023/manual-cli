#!/usr/bin/env node
import { main } from '../src/cli.js';
import { serveMcp } from '../src/mcp.js';
import path from 'node:path';

const argv = process.argv.slice(2);

if (argv[0] === 'mcp') {
  const rootIdx = argv.indexOf('--root');
  const root = rootIdx !== -1 ? path.resolve(argv[rootIdx + 1]) : process.cwd();
  serveMcp(root)
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('manual-mcp: fatal:', e);
      process.exit(2);
    });
} else {
  main(argv)
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('manual: fatal:', err && err.stack ? err.stack : err);
      process.exit(2);
    });
}
