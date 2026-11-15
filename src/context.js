import { join } from 'node:path';
import { Alpaca } from './alpaca.js';
import { makeAlerter } from './alert.js';
import { loadConfig } from './config.js';
import { Data } from './data.js';
import { Store } from './store.js';

export function makeCtx({ dir, env = process.env, now = () => new Date(), alert, store, warn: warnIn = (m) => console.error('warn: ' + m), fetchImpl = fetch } = {}) {
  const seen = new Set();
  const warn = (m) => { if (!seen.has(m)) { seen.add(m); warnIn(m); } };
  const loaded = loadConfig({ dir, env });
  const { cfg } = loaded;
  const clients = {};
  const keysFor = (a) => (a.keyEnv && env[a.keyEnv] && env[a.secretEnv] ? { key: env[a.keyEnv], secret: env[a.secretEnv] } : null);
  const broker = (name) => {
    const a = cfg.accounts[name];
    if (a.mode === 'dry') return null;
    if (!clients[name]) {
      const k = keysFor(a);
      if (!k) throw new Error(`account ${name}: ${a.keyEnv}/${a.secretEnv} not set (mode ${a.mode})`);
      clients[name] = new Alpaca({ ...k, mode: a.mode, feed: cfg.feed || 'sip', fetchImpl, warn });
    }
    return clients[name];
  };
  const firstKeyed = Object.values(cfg.accounts).map(keysFor).find(Boolean);
  const dataClient = firstKeyed ? new Alpaca({ ...firstKeyed, mode: 'paper', feed: cfg.feed || 'sip', fetchImpl, warn }) : null;
  return {
    ...loaded, env, now, warn, broker,
    store: store || new Store(loaded.dataDir),
    data: new Data({ alpaca: dataClient, fetchImpl, warn }),
    alert: alert || makeAlerter({ envFile: env.ALERT_ENV || cfg.alertEnvFile || join(loaded.dir, 'alert.env'), fetchImpl }),
    keysFor, fetchImpl,
  };
}
