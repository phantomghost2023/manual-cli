export function nowIso() {
  return new Date().toISOString();
}

// "30d", "12h", "45m", "600s" -> milliseconds
export function parseTtl(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d+)\s*(d|h|m|s)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] || 's').toLowerCase();
  const mult = { d: 86400e3, h: 3600e3, m: 60e3, s: 1e3 }[unit];
  return n * mult;
}

export function short(s, max = 150) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : t.slice(0, max - 1) + '…';
}

export function estimateTokens(s) {
  return Math.ceil(String(s).length / 4);
}
