// API keys for plugins (transcribers, issue trackers): the environment variable first, else the login Keychain
// item named in config (stored by `ux-walk setup` or the app's Settings). A provider here is any object
// with { name, env, keychainItem(cfg) }.
import { execFileSync } from 'node:child_process';

const user = () => process.env.USER || '';

export function keyFor(provider, cfg, { setup = 'ux-walk setup' } = {}) {
  if (provider.env && process.env[provider.env]) return process.env[provider.env];
  const item = provider.keychainItem(cfg);
  try {
    const v = execFileSync('security', ['find-generic-password', '-a', user(), '-s', item, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (v) return v;
  } catch {}
  throw new Error(`no ${provider.name} key: run "${setup}" or the app's Settings (Keychain item "${item}")${provider.env ? `, or set ${provider.env}` : ''}`);
}

// Presence only: without -w, security does not return the secret.
export function keyPresent(provider, cfg) {
  if (provider.env && process.env[provider.env]) return true;
  try { execFileSync('security', ['find-generic-password', '-a', user(), '-s', provider.keychainItem(cfg)], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

export function storeKey(provider, cfg, secret) {
  const item = provider.keychainItem(cfg);
  execFileSync('security', ['add-generic-password', '-U', '-a', user(), '-s', item, '-w', secret]);
  return item;
}
