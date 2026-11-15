import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** PRIVATE_DIR env > ../vampire-private (when it holds a config.json) > examples/ */
export function resolvePrivateDir(env = process.env) {
  if (env.PRIVATE_DIR) return resolve(env.PRIVATE_DIR);
  const sibling = resolve(ROOT, '..', 'vampire-private');
  return existsSync(join(sibling, 'config.json')) ? sibling : join(ROOT, 'examples');
}

export function loadEnvFile(file, into = process.env) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && into[m[1]] === undefined) into[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

export function validateConfig(cfg) {
  const err = (m) => { throw new Error(`config: ${m}`); };
  if (!Array.isArray(cfg.legs) || !cfg.legs.length) err('legs[] required');
  const wsum = cfg.legs.reduce((s, l) => s + l.weight, 0);
  if (Math.abs(wsum - 1) > 1e-9) err(`leg weights must sum to 1 (got ${wsum})`);
  for (const l of cfg.legs) for (const k of ['name', 'signal', 'night', 'weight']) if (l[k] == null) err(`leg ${l.name || '?'} missing ${k}`);
  if (!Number.isInteger(cfg.maLength) || cfg.maLength < 2) err('maLength must be an integer >= 2');
  if (!cfg.variants || !Object.keys(cfg.variants).length) err('variants required');
  if (!cfg.accounts || !Object.keys(cfg.accounts).length) err('accounts required');
  for (const [n, a] of Object.entries(cfg.accounts)) {
    if (!cfg.variants[a.variant]) err(`account ${n}: unknown variant ${a.variant}`);
    if (!['dry', 'paper', 'live'].includes(a.mode)) err(`account ${n}: mode must be dry|paper|live`);
    if (a.mode !== 'dry' && !(a.keyEnv && a.secretEnv)) err(`account ${n}: keyEnv/secretEnv required`);
  }
  return cfg;
}

export function loadConfig({ dir = resolvePrivateDir(), env = process.env } = {}) {
  const file = [join(dir, 'config.json'), join(ROOT, 'examples', 'config.json')].find(existsSync);
  const cfg = validateConfig(JSON.parse(readFileSync(file, 'utf8')));
  loadEnvFile(join(dir, '.env'), env);
  const isExample = dir === join(ROOT, 'examples') || file.startsWith(join(ROOT, 'examples'));
  const dataDir = isExample ? join(ROOT, 'data') : join(dir, 'data');
  return {
    cfg: { maxTargetPct: 1.05, dayNotional: 1, dryEquity: 100000, ...cfg },
    dir, file, dataDir, isExample,
    killFile: resolve(dir, cfg.killSwitchFile || 'KILL'),
  };
}

/** Explicit mode per account; live additionally needs confirmLive in config AND VAMPIRE_CONFIRM_LIVE=yes (or --confirm-live). */
export function assertModeAllowed(acct, { env = process.env, confirmLiveFlag = false } = {}) {
  if (acct.mode === 'live' && !(acct.confirmLive === true && (confirmLiveFlag || env.VAMPIRE_CONFIRM_LIVE === 'yes'))) {
    throw new Error('live mode requires confirmLive:true in the account config AND VAMPIRE_CONFIRM_LIVE=yes (or --confirm-live)');
  }
}
