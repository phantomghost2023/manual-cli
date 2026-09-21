import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { nowIso } from './util.js';

// state.json (gitignored by convention) holds verify stamps and trust history.

const STATES = new Set(['fresh', 'stale', 'broken', 'blocked', 'unknown']);

export class State {
  constructor(root) {
    this.path = path.join(root, '.manual', 'state.json');
    this.salt = null;
    this.data = { version: 1, stamps: {}, history: [] };
    if (fs.existsSync(this.path)) {
      try { this.data = JSON.parse(fs.readFileSync(this.path, 'utf8')); } catch { /* reset */ }
    }
    this.salt = this.data.salt || randomBytes(16).toString('hex');
    this.data.salt = this.salt;
  }

  stamp(id) {
    return this.data.stamps[id] || null;
  }

  set(id, patch) {
    const prev = this.stamp(id);
    const next = {
      id,
      state: 'unknown',
      tier: prev?.tier || 'bronze',
      verified_at: nowIso(),
      ...prev,
      ...patch,
    };
    if (!STATES.has(next.state)) next.state = 'unknown';
    this.data.stamps[id] = next;
    return next;
  }

  history(entries = 20) {
    return this.data.history.slice(-entries);
  }

  pushHistory(entry) {
    this.data.history.push(entry);
    if (this.data.history.length > 500) this.data.history = this.data.history.slice(-500);
  }

  save() {
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    fs.writeFileSync(this.path, JSON.stringify(this.data, null, 2) + '\n');
  }
}

export const TIER_DROP = { gold: 'silver', silver: 'bronze', bronze: 'bronze', ghost: 'unknown' };
