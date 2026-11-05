// Settings: defaults < ~/.config/ux-walk/config.json < environment < command-line flags.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONFIG_DIR = process.env.CAP_UX_WALK_CONFIG_DIR || path.join(os.homedir(), '.config', 'ux-walk');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULTS = {
  url: 'https://onc4ll.com',
  outDir: '~/Movies/ux-walk',
  capture: 'window', // window | screen | cap (explicit passive target; Studio projects)
  screen: 'Capture screen 0', // ffmpeg device, only for capture=screen
  mic: '', // substring of the mic name; '' = system default
  fps: 15,
  callAudio: true, // also record the other side of a call (FaceTime, Zoom, Meet...) as a second track to tell callers from you
  callApp: 'auto', // that track is only the call app's sound: auto (the app using the mic), zoom, facetime, meet, slack, teams, arc, safari; 'system' = everything the Mac plays
  sections: true, // true: from the screen, plus a Claude pass on chapters over sectionsMinS; 'screen'; false
  sectionsMinS: 180,
  sectionsModel: 'haiku',
  windowSize: '1440,960',
  trace: true,
  transcriber: 'elevenlabs', // elevenlabs | assemblyai | descript | none (src/transcribe.mjs)
  elevenlabsKeychainItem: 'ux-walk-elevenlabs',
  assemblyaiKeychainItem: 'ux-walk-assemblyai',
  descriptKeychainItem: 'descript-mcp-token',
  project: '', // default project id (<configDir>/projects/<id>.json): its glossary, tracker, source folder and notes
  githubKeychainItem: 'ux-walk-github', // issue trackers (src/trackers/): GITHUB_TOKEN / LINEAR_API_KEY win
  linearKeychainItem: 'ux-walk-linear',
  language: 'en',
  glossary: '', // extra glossaries always used: names in ~/.config/ux-walk/glossaries/ or paths, comma-separated
  me: '', // your first name, used as the first speaker; default: your macOS account name
  speakers: '', // "Jackson,Clay": names in order of first appearance in the transcript
  askSpeakers: true, // ask who is talking before recording (the names the roll call is matched against)
  brief: false, // run "ux-walk brief" on each chapter after it is processed
  briefModel: 'sonnet',
  authFile: '~/.config/ux-walk/auth.json', // saved browser login
  briefNotes: '~/.config/ux-walk/brief-notes.md', // optional: product context added to the brief prompt
  // RPCs the verb guess gets wrong (regex strings): readRpcs are reads whatever their verbs say
  // (a background log), writeRpcs are writes with no write verb (a state transition).
  readRpcs: '',
  writeRpcs: '',
  // The app's repo: timelines say where each clicked test id is defined (src: path:line).
  sourceRoot: '',
  sourceGlobs: '', // "src/**,packages/ui/**"; default: every JS/TS/HTML-ish file
  sourceRef: '', // "origin/main": read that branch, not the checkout (a stale checkout misses new ids)
  screenNames: true, // fix transcript words that misspell a name shown on screen
  // { "org": "<css>", "viewAs": "<css>" }: page context logged with every page change.
  contextSelectors: {},
  // Wrapper test ids that name no feature: element names and src lines use the next real one instead.
  genericTestids: ['async-boundary'],
  // Network writes that are noise, not user actions.
  // Console noise from third-party scripts and the browser, not the app.
  ignoreConsole: 'fullstory\\.com|cdn-cgi|Cloudflare Turnstile|turnstile|OTS parsing error|^%c%d|No available adapters|Blocked script execution in .about:blank',
  ignoreWrites: 'fullstory|sentry|posthog|google-analytics|googletagmanager|segment\\.io|intercom|hotjar|cloudflareinsights|/auth/v1/|/api/auth/|/_vercel|/cdn-cgi/',
};

export const expand = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

export function loadConfig(flags = {}) {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {}
  const env = {};
  for (const k of Object.keys(DEFAULTS)) {
    const e = process.env['UXW_' + k.replace(/[A-Z]/g, (c) => '_' + c).toUpperCase()];
    if (e !== undefined) env[k] = e;
  }
  // Older env names from the shell version.
  if (process.env.MIC) env.mic ??= process.env.MIC;
  if (process.env.SCREEN) env.screen ??= process.env.SCREEN;
  const cfg = { ...DEFAULTS, ...file, ...env, ...flags };
  cfg.outDir = expand(cfg.outDir);
  cfg.authFile = expand(cfg.authFile);
  cfg.sourceRoot = expand(cfg.sourceRoot);
  cfg.configDir = CONFIG_DIR;
  if (typeof cfg.contextSelectors === 'string') { try { cfg.contextSelectors = JSON.parse(cfg.contextSelectors || '{}'); } catch { cfg.contextSelectors = {}; } }
  const bool = (v) => v !== false && v !== 'false' && v !== '0';
  cfg.trace = bool(cfg.trace);
  cfg.askSpeakers = bool(cfg.askSpeakers);
  cfg.callAudio = bool(cfg.callAudio);
  cfg.brief = cfg.brief === true || cfg.brief === 'true' || cfg.brief === '1';
  if (!cfg.me) {
    try { cfg.me = execFileSync('id', ['-F'], { encoding: 'utf8' }).trim().split(/\s+/)[0]; } catch { cfg.me = os.userInfo().username; }
  }
  return cfg;
}
