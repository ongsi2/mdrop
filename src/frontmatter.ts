/**
 * Parse the deliberately small frontmatter subset that MDVIEW displays.
 *
 * This is not a YAML parser: only flat `key: value` entries and indented
 * `- value` continuations are accepted. Most importantly, a delimiter-looking
 * block is treated as ordinary Markdown unless it contains at least one valid
 * entry. That keeps horizontal-rule-heavy documents from losing their opening
 * paragraphs.
 */
export function splitFrontmatter(src: string): {
  meta: Record<string, string> | null;
  body: string;
} {
  const newline = '(?:\\r\\n?|\\n)';
  const block = new RegExp(
    `^\\uFEFF?---[ \\t]*${newline}([\\s\\S]*?)${newline}---[ \\t]*(?:${newline}|$)`,
  ).exec(src);
  if (!block) return { meta: null, body: src };

  const unquote = (value: string) => {
    const trimmed = value.trim();
    if (trimmed.length >= 2) {
      const first = trimmed[0];
      const last = trimmed[trimmed.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        return trimmed.slice(1, -1).trim();
      }
    }
    return trimmed;
  };

  /* A null prototype makes keys such as `__proto__` plain document data
     instead of invoking Object.prototype setters. */
  const meta = Object.create(null) as Record<string, string>;
  let key = '';

  for (const line of block[1].split(/\r\n?|\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;

    const item = /^\s+-\s+(.+)$/.exec(line);
    if (item && key) {
      const value = unquote(item[1]);
      meta[key] = meta[key] ? `${meta[key]}, ${value}` : value;
      continue;
    }

    /* Unicode letters need no special case here: reject only YAML syntax
       delimiters and blank starts, rather than trying to enumerate scripts. */
    const pair = /^([^:#\s][^:]*?)\s*:\s*(.*)$/u.exec(line);
    if (!pair) {
      key = '';
      continue;
    }

    key = pair[1].trim();
    if (!key) continue;
    meta[key] = unquote(pair[2]).replace(/^\[|\]$/g, '').trim();
  }

  if (!Object.keys(meta).length) return { meta: null, body: src };
  return { meta, body: src.slice(block[0].length) };
}
