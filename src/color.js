const on = process.stdout.isTTY && !process.env.NO_COLOR;

const wrap = (code) => (s) => (on ? `\x1b[${code}m${s}\x1b[0m` : String(s));

export const c = {
  green: wrap('32'),
  red: wrap('31'),
  amber: wrap('33'),
  yellow: wrap('33'),
  grey: wrap('90'),
  cyan: wrap('36'),
  magenta: wrap('35'),
  bold: wrap('1'),
};
