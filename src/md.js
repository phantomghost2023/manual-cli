// Frontmatter / body splitting for claim files.

export function splitFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { fm: null, body: text };
  return { fm: m[1], body: m[2] ?? '' };
}

// Returns { intro, sections: Map(lowercased heading -> text) }.
export function splitSections(body) {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const sections = new Map();
  let heading = null;
  const buf = [];
  const intro = [];
  for (const line of lines) {
    const h = line.match(/^##\s+(.*?)\s*$/);
    if (h) {
      const text = buf.join('\n').trim();
      if (heading) sections.set(heading, text);
      else if (text) intro.push(text);
      heading = h[1].toLowerCase();
      buf.length = 0;
    } else {
      buf.push(line);
    }
  }
  if (heading) sections.set(heading, buf.join('\n').trim());
  else if (buf.join('\n').trim()) intro.push(buf.join('\n').trim());
  return { intro: intro.join('\n').trim(), sections };
}
