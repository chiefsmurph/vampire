// Email alerts, same pattern as the trading-backup lib.sh send_alert: ai-notify first, PingPigeon API second.
// Settings come from an env file (ALERT_ENV, else <PRIVATE_DIR>/alert.env): AI_NOTIFY_URL/TOKEN, PP_URL/TOKEN.
// Tokens go in headers, never on a command line. Never throws: an alert failure must not mask the real failure.
import { existsSync, readFileSync } from 'node:fs';

export function readAlertEnv(file) {
  const out = {};
  if (!file || !existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

export function makeAlerter({ envFile = process.env.ALERT_ENV, fetchImpl = fetch, log = console.error } = {}) {
  return async function sendAlert(subject, body) {
    const e = { ...readAlertEnv(envFile), ...Object.fromEntries(['AI_NOTIFY_URL', 'AI_NOTIFY_TOKEN', 'PP_URL', 'PP_TOKEN'].filter((k) => process.env[k]).map((k) => [k, process.env[k]])) };
    const attempts = [];
    if (e.AI_NOTIFY_URL && e.AI_NOTIFY_TOKEN) attempts.push(['ai-notify', e.AI_NOTIFY_URL, { 'x-token': e.AI_NOTIFY_TOKEN }]);
    if (e.PP_URL && e.PP_TOKEN) attempts.push(['pingpigeon', e.PP_URL, { Authorization: `Bearer ${e.PP_TOKEN}` }]);
    for (const [name, url, headers] of attempts) {
      try {
        const res = await fetchImpl(url, { method: 'POST', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ subject, body }).toString(), signal: AbortSignal.timeout(30000) });
        const t = await res.text();
        if (t.includes('"ok":true')) return { sent: true, via: name };
        log(`alert via ${name} failed: ${t.slice(0, 160)}`);
      } catch (err) { log(`alert via ${name} errored: ${err.message}`); }
    }
    log(`ALERT NOT SENT: ${subject}\n${body}`);
    return { sent: false };
  };
}
