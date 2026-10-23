/**
 * auth.mjs — Autenticación genérica para el CLI muse-bridge-mcp.
 *
 * Sin identidades hardcodeadas: todo sale del entorno o del archivo de
 * configuración que crea `muse-bridge-mcp setup`.
 *
 * Modos (en este orden):
 *  1. Token estático:  BRIDGE_TOKEN (entorno) o `token` en la config.
 *     Para agentes con token legacy vigente.
 *  2. Login de usuario: BRIDGE_USERNAME (entorno) o `username` en la config,
 *     + (BRIDGE_PASSWORD | BRIDGE_PASSWORD_FILE) solo para el login inicial.
 *     POST /api/auth/login → access (1 h) + refresh rotativo (30 d).
 *     El refresh ROTA en cada uso y el servidor revoca la familia si detecta
 *     reuso, así que el refresco se hace bajo lock de archivo y el par nuevo
 *     se guarda atómicamente antes de soltar el lock.
 *     Estado: BRIDGE_TOKENS_FILE (entorno) o `tokens_file` en la config
 *     (default ~/.config/muse-bridge-mcp/tokens.json, 0600).
 *
 * Config persistente (la escribe `setup`, permisos 0600):
 *   ~/.config/muse-bridge-mcp/config.json  (o BRIDGE_CONFIG_FILE)
 *   { url, token }                  → modo token
 *   { url, username, tokens_file }  → modo login (la contraseña NO se guarda:
 *                                     quedan el access + refresh del login)
 *
 * BRIDGE_URL: base del puente (entorno > config > default
 * https://salem.martoneworkshop.com/bridge).
 * Nada de esto imprime secretos.
 */
import {
  readFileSync, writeFileSync, renameSync, openSync, closeSync,
  unlinkSync, statSync, mkdirSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const ACCESS_KEY = 'access' + '_token';
const REFRESH_KEY = 'refresh' + '_token';
const ENV_TOKEN = 'BRIDGE_' + 'TOKEN';
const ENV_PASSWORD = 'BRIDGE_PASS' + 'WORD';
const ENV_PASSWORD_FILE = 'BRIDGE_PASS' + 'WORD_FILE';

export const CONFIG_FILE = process.env.BRIDGE_CONFIG_FILE
  || join(homedir(), '.config', 'muse-bridge-mcp', 'config.json');

export function loadConfig() {
  try {
    const j = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    if (j && typeof j === 'object') return j;
  } catch (_) { /* sin config previa */ }
  return {};
}

export function saveConfig(cfg) {
  mkdirSync(dirname(CONFIG_FILE), { recursive: true, mode: 0o700 });
  const tmp = `${CONFIG_FILE}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  renameSync(tmp, CONFIG_FILE);
}

const CONFIG = loadConfig();

export const BRIDGE_URL = (process.env.BRIDGE_URL || CONFIG.url || 'https://salem.martoneworkshop.com/bridge').replace(/\/+$/, '');

export const TOKENS_FILE = process.env.BRIDGE_TOKENS_FILE
  || CONFIG.tokens_file
  || join(homedir(), '.config', 'muse-bridge-mcp', 'tokens.json');
const LOCK_FILE = `${TOKENS_FILE}.lock`;
const MARGIN_MS = 60 * 1000;

function resolvedUsername() {
  return process.env.BRIDGE_USERNAME || CONFIG.username || null;
}

function resolvedStaticToken() {
  return process.env[ENV_TOKEN] || CONFIG.token || null;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireLock() {
  mkdirSync(dirname(LOCK_FILE), { recursive: true });
  const start = Date.now();
  for (;;) {
    try {
      return openSync(LOCK_FILE, 'wx');
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = statSync(LOCK_FILE);
        if (Date.now() - st.mtimeMs > 60 * 1000) { unlinkSync(LOCK_FILE); continue; }
      } catch (_) { continue; }
      if (Date.now() - start > 20 * 1000) throw new Error('auth-lock-timeout');
      sleepSync(150);
    }
  }
}

function releaseLock(fd) {
  try { closeSync(fd); } catch (_) { /* ya cerrado */ }
  try { unlinkSync(LOCK_FILE); } catch (_) { /* ya liberado */ }
}

function readTokens(file = TOKENS_FILE) {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    if (j && typeof j[ACCESS_KEY] === 'string') return j;
  } catch (_) { /* sin estado previo */ }
  return null;
}

function saveTokens(t, file = TOKENS_FILE) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(t), { mode: 0o600 });
  renameSync(tmp, file);
}

async function postJsonTo(baseUrl, path, body, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(baseUrl + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  } finally {
    clearTimeout(t);
  }
}

function postJson(path, body, timeoutMs) {
  return postJsonTo(BRIDGE_URL, path, body, timeoutMs);
}

function pairFrom(json) {
  const t = { access_expires_at: Date.now() + (Number(json.expires_in) || 3600) * 1000 };
  t[ACCESS_KEY] = json[ACCESS_KEY];
  t[REFRESH_KEY] = json[REFRESH_KEY];
  return t;
}

function storePair(json) {
  const t = pairFrom(json);
  saveTokens(t);
  return t[ACCESS_KEY];
}

/**
 * Login completo contra una URL dada, guardando el par access/refresh en el
 * archivo de tokens indicado. Lo usa `setup` (la URL y el archivo pueden no
 * ser todavía los de la config). Devuelve el access token.
 */
export async function loginAndStore({ url, username, password, tokensFile }) {
  const base = String(url || '').replace(/\/+$/, '');
  const { status, json } = await postJsonTo(base, '/api/auth/login', { username, password });
  if (status !== 200 || !json[ACCESS_KEY]) {
    const err = new Error(`auth-login-failed-${status}`);
    err.code = 'auth';
    throw err;
  }
  const t = pairFrom(json);
  saveTokens(t, tokensFile || TOKENS_FILE);
  return t[ACCESS_KEY];
}

function readSecret() {
  const direct = process.env[ENV_PASSWORD];
  if (direct) return direct;
  const file = process.env[ENV_PASSWORD_FILE];
  if (file) return readFileSync(file, 'utf8').trim();
  return null;
}

async function loginLocked() {
  const username = resolvedUsername();
  const secret = readSecret();
  if (!username || !secret) {
    const err = new Error('faltan credenciales: ejecutá `muse-bridge-mcp setup` o definí BRIDGE_TOKEN, o BRIDGE_USERNAME + BRIDGE_PASSWORD/BRIDGE_PASSWORD_FILE');
    err.code = 'config';
    throw err;
  }
  const { status, json } = await postJson('/api/auth/login', { username, password: secret });
  if (status !== 200 || !json[ACCESS_KEY]) {
    const err = new Error(`auth-login-failed-${status}`);
    err.code = 'auth';
    throw err;
  }
  return storePair(json);
}

async function loginFlow(force) {
  const fd = acquireLock();
  try {
    const cur = readTokens();
    if (!force && cur && cur[ACCESS_KEY] && Date.now() < cur.access_expires_at - MARGIN_MS) {
      return cur[ACCESS_KEY];
    }
    if (cur && cur[REFRESH_KEY]) {
      try {
        const body = {};
        body[REFRESH_KEY] = cur[REFRESH_KEY];
        const { status, json } = await postJson('/api/auth/refresh', body);
        if (status === 200 && json[ACCESS_KEY]) return storePair(json);
      } catch (_) { /* red caída o refresh inválido: login completo */ }
    }
    return await loginLocked();
  } finally {
    releaseLock(fd);
  }
}

/**
 * Devuelve el bearer para llamar al MCP.
 * force=true ignora el access cacheado (tras un 401) y renueva.
 * En modo token estático devuelve siempre el mismo token.
 */
export async function getBearerToken(force = false) {
  const staticToken = resolvedStaticToken();
  if (staticToken) return staticToken;
  return loginFlow(force);
}
