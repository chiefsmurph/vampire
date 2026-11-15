import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export class Store {
  constructor(dir) { this.dir = dir; mkdirSync(dir, { recursive: true }); }
  path(name) { return join(this.dir, name); }
  appendJsonl(name, obj) { appendFileSync(this.path(name), JSON.stringify(obj) + '\n'); }
  readJsonl(name) {
    const p = this.path(name);
    if (!existsSync(p)) return [];
    return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }
  readJson(name, def = null) { try { return JSON.parse(readFileSync(this.path(name), 'utf8')); } catch { return def; } }
  writeJson(name, obj) { const p = this.path(name), t = p + '.tmp'; writeFileSync(t, JSON.stringify(obj, null, 2)); renameSync(t, p); }
}
