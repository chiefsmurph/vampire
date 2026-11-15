#!/usr/bin/env node
// Public-repo guard (pre-push hook + CI). Scans tracked files and exits 1 on any finding:
//  - private tickers (matched by sha256 of each UPPERCASE token; the list itself lives in guard-hashes.txt)
//  - a moving-average length configured as the private value
//  - private/absolute paths, keys, tokens, .env / pem / data / log files, files over 1 MB
//  - optional extra plaintext terms from $PRIVATE_DIR/guard-denylist.txt (one per line, case-insensitive)
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SELF = new Set(['scripts/guard.mjs', 'scripts/guard-hashes.txt']);
const BAD_PATHS = [/(^|\/)\.env(\.|$)/, /\.env$/, /\.pem$/, /\.key$/, /(^|\/)data\//, /(^|\/)logs?\//, /\.jsonl$/, /(^|\/)KILL$/, /(^|\/)vampire-private\//];
const CONTENT = [
  ['ma-config', /\b(?:ma|maLength|ma_length|ma_len|sma|smaLength)["']?\s*[:=]\s*2[5]0\b/i],
  ['ma-flag', /--ma\s+2[5]0\b/],
  ['private-path', /(?:\/Users\/\w+|\/root\/(?!\.)\w[\w.-]*|\/home\/\w+)/],
  ['alpaca-key', /\b(?:PK|AK|CK)[A-Z0-9]{18}\b/],
  ['key-assignment', /(?:KEY|SECRET|TOKEN|PASSWORD)\w*\s*[:=]\s*["']?[A-Za-z0-9+/_-]{20,}["']?/],
  ['private-key-block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['bearer-token', /Bearer\s+[A-Za-z0-9._-]{24,}/],
];

export function loadHashes(file = join(HERE, 'guard-hashes.txt')) {
  return new Set(readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter((l) => /^[0-9a-f]{64}$/.test(l)));
}
const sha = (s) => createHash('sha256').update(s).digest('hex');

export function scan(root, files, { hashes = loadHashes(), extraTerms = [] } = {}) {
  const findings = [];
  for (const f of files) {
    if (SELF.has(f)) continue;
    const full = join(root, f);
    if (!existsSync(full)) continue;
    for (const re of BAD_PATHS) if (re.test(f)) findings.push({ file: f, rule: 'forbidden-path', detail: re.source });
    const st = statSync(full);
    if (st.size > 1024 * 1024) findings.push({ file: f, rule: 'too-large', detail: `${st.size} bytes` });
    if (st.size > 1024 * 1024) continue;
    const text = readFileSync(full, 'utf8');
    if (text.includes('\u0000')) continue;
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      for (const tok of line.match(/\b[A-Z]{2,6}\b/g) || []) if (hashes.has(sha(tok))) findings.push({ file: f, line: i + 1, rule: 'private-ticker', detail: '(hashed denylist hit)' });
      for (const [rule, re] of CONTENT) if (re.test(line)) findings.push({ file: f, line: i + 1, rule, detail: line.trim().slice(0, 60) });
      for (const t of extraTerms) if (new RegExp(`(?<![A-Za-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`, 'i').test(line)) findings.push({ file: f, line: i + 1, rule: 'denylist-term', detail: t });
    });
  }
  return findings;
}

function gitFiles(root) {
  return execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(HERE, '..');
  const priv = process.env.PRIVATE_DIR || resolve(root, '..', 'vampire-private');
  const dl = join(priv, 'guard-denylist.txt');
  const extra = existsSync(dl) ? readFileSync(dl, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')) : [];
  const findings = scan(root, gitFiles(root), { extraTerms: extra });
  if (findings.length) {
    console.error('public-guard: BLOCKED');
    for (const x of findings) console.error(`  ${x.file}${x.line ? ':' + x.line : ''}  [${x.rule}] ${x.detail}`);
    process.exit(1);
  }
  console.log(`public-guard: clean (${gitFiles(root).length} files${extra.length ? ', +' + extra.length + ' private terms' : ''})`);
}
