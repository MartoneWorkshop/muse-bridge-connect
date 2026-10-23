#!/usr/bin/env node
/**
 * muse-bridge-mcp — CLI genérico para el MCP remoto de muse-bridge.
 *
 * Sirve para CUALQUIER agente: la identidad sale de la configuración
 * (variables de entorno), nunca del código. Ver README.md.
 *
 * Uso: muse-bridge-mcp <subcomando> [flags]
 * Salida: JSON por stdout. Errores por stderr.
 * Códigos de salida: 0 ok · 1 uso/config · 2 conexión/auth · 3 error de la tool.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  BRIDGE_URL, getBearerToken, loadConfig, saveConfig,
  CONFIG_FILE, TOKENS_FILE, loginAndStore,
} from './auth.mjs';

const NUMERIC = new Set(['since_id', 'limit', 'output_message_id', 'from_message_id', 'to_message_id', 'since']);
const BOOLEAN = new Set(['include_offline', 'include_archived']);

// flag CLI → campo del esquema de la tool
const COMMANDS = {
  'list-agents':   { tool: 'bridge_list_agents',   flags: { 'include-offline': 'include_offline' } },
  'list-channels': { tool: 'bridge_list_channels', flags: { 'project': 'project_id', 'include-archived': 'include_archived' } },
  'read-messages': { tool: 'bridge_read_messages', flags: { 'channel': 'channel_id', 'since-id': 'since_id', 'limit': 'limit' } },
  'send-message':  { tool: 'bridge_send_message',  flags: { 'channel': 'channel_id', 'text': 'text', 'to': 'to', 'type': 'type', 'task-id': 'task_id', 'status': 'status', 'idempotency-key': 'idempotency_key' } },
  'list-tasks':    { tool: 'bridge_list_tasks',    flags: { 'channel': 'channel_id', 'status': 'status', 'assignee': 'assignee', 'limit': 'limit' } },
  'get-task':      { tool: 'bridge_get_task',      flags: { 'task': 'task_id', 'task-id': 'task_id' } },
  'create-task':   { tool: 'bridge_create_task',   flags: { 'channel': 'channel_id', 'assignee': 'assignee', 'text': 'text', 'task-id': 'task_id', 'idempotency-key': 'idempotency_key' } },
  'update-task':   { tool: 'bridge_update_task',   flags: { 'task': 'task_id', 'task-id': 'task_id', 'status': 'status', 'output-message-id': 'output_message_id', 'result-text': 'result_text' } },
  'get-digest':    { tool: 'bridge_get_digest',    flags: { 'channel': 'channel_id', 'from-id': 'from_message_id', 'to-id': 'to_message_id', 'since': 'since', 'limit': 'limit' } },
  'list-deliveries': { tool: 'bridge_list_deliveries', flags: { 'status': 'status', 'limit': 'limit' } },
};

const HELP = `muse-bridge-mcp — cliente CLI genérico para el MCP de muse-bridge

Instalación y configuración:
  install                              Instala el CLI global (npm) y lanza el asistente
  setup [--url U] [--token T | --username U --password P | --password-file F]
                                       Asistente: pide los datos, inicia sesión,
                                       verifica la conexión y guarda la config
                                       (sin variables de entorno después)

Subcomandos (uno por tool del servidor):
  tools                                        Lista las tools del servidor
  list-agents   [--include-offline]            Agentes y perfiles
  list-channels [--project ID] [--include-archived]
  read-messages --channel ID [--since-id N] [--limit N]
  send-message  --channel ID --text "..." [--to A] [--type message|task_result|ping]
                [--task-id ID] [--status done|error] [--idempotency-key K]
  list-tasks    [--channel ID] [--status S] [--assignee A] [--limit N]
  get-task      --task ID
  create-task   --channel ID --assignee A --text "..." [--task-id ID] [--idempotency-key K]
  update-task   --task ID --status running|completed|failed|cancelled
                [--output-message-id N] [--result-text "..."]
  get-digest    --channel ID [--from-id N] [--to-id N] [--since TS] [--limit N]
  list-deliveries [--status pending|installed|dismissed] [--limit N]
  call <tool> --json '{...}'                   Llamada genérica a cualquier tool

Configuración:
  Archivo (lo crea setup): ~/.config/muse-bridge-mcp/config.json
    { url, token }  o  { url, username, tokens_file } — la contraseña no se guarda.
  Entorno (pisa al archivo): BRIDGE_URL, BRIDGE_TOKEN, BRIDGE_USERNAME,
    BRIDGE_PASSWORD / BRIDGE_PASSWORD_FILE, BRIDGE_TOKENS_FILE, BRIDGE_CONFIG_FILE
`;

function fail(code, msg) {
  console.error(`error: ${msg}`);
  process.exit(code);
}

function parseFlags(argv, spec) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (!raw.startsWith('--')) fail(1, `argumento inesperado: ${raw}`);
    let key = raw.slice(2);
    let value;
    const eq = key.indexOf('=');
    if (eq >= 0) { value = key.slice(eq + 1); key = key.slice(0, eq); }
    const field = spec.flags[key];
    if (!field) fail(1, `flag desconocida: --${key}`);
    if (BOOLEAN.has(field)) {
      args[field] = value === undefined ? true : value !== 'false';
      continue;
    }
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined) fail(1, `la flag --${key} necesita un valor`);
    }
    args[field] = NUMERIC.has(field) ? Number(value) : value;
    if (NUMERIC.has(field) && Number.isNaN(args[field])) fail(1, `la flag --${key} espera un número`);
  }
  return args;
}

async function connect(token, baseUrl = BRIDGE_URL) {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'muse-bridge-mcp', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

async function withClient(fn) {
  let token = await getBearerToken(false);
  try {
    const client = await connect(token);
    try { return await fn(client); } finally { await client.close().catch(() => {}); }
  } catch (e) {
    const msg = String(e && e.message || e);
    if (!/401|unauthorized/i.test(msg)) throw e;
    token = await getBearerToken(true); // renueva y reintenta una vez
    const client = await connect(token);
    try { return await fn(client); } finally { await client.close().catch(() => {}); }
  }
}

function printResult(result) {
  // El servidor devuelve los datos en structuredContent y un resumen
  // humano en content[].text: se prioriza el dato estructurado.
  if (result?.structuredContent !== undefined) {
    console.log(JSON.stringify(result.structuredContent, null, 2));
    if (result?.isError) process.exit(3);
    return;
  }
  const items = Array.isArray(result?.content) ? result.content : [];
  for (const item of items) {
    if (item.type === 'text' && typeof item.text === 'string') {
      try { console.log(JSON.stringify(JSON.parse(item.text), null, 2)); }
      catch { console.log(item.text); }
    } else {
      console.log(JSON.stringify(item, null, 2));
    }
  }
  if (result?.isError) process.exit(3);
}

// ---------- setup / install ----------

function parseSetupFlags(argv) {
  const out = {};
  const takesValue = new Set(['url', 'token', 'username', 'password', 'password-file', 'tokens-file']);
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (!raw.startsWith('--')) fail(1, `argumento inesperado: ${raw}`);
    let key = raw.slice(2);
    let value;
    const eq = key.indexOf('=');
    if (eq >= 0) { value = key.slice(eq + 1); key = key.slice(0, eq); }
    if (key === 'non-interactive' || key === 'yes') { out.nonInteractive = true; continue; }
    if (!takesValue.has(key)) fail(1, `flag desconocida para setup/install: --${key}`);
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined) fail(1, `la flag --${key} necesita un valor`);
    }
    out[key] = value;
  }
  return out;
}

// Lector de líneas propio (buffer + cola): readline descarta las líneas que
// llegan juntas por un pipe antes de registrar la siguiente pregunta; este
// lector las conserva en orden. Sirve igual para TTY y para pipe.
const lineQueue = [];
const lineWaiters = [];
let lineReaderStarted = false;
let stdinEnded = false;

function ensureLineReader() {
  if (lineReaderStarted) return;
  lineReaderStarted = true;
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (lineWaiters.length) lineWaiters.shift()(line);
      else lineQueue.push(line);
    }
  });
  process.stdin.on('end', () => {
    if (buf.length) {
      const line = buf.replace(/\r$/, '');
      buf = '';
      if (lineWaiters.length) lineWaiters.shift()(line);
      else lineQueue.push(line);
    }
    stdinEnded = true;
    while (lineWaiters.length) lineWaiters.shift()('');
  });
  process.stdin.resume();
}

function nextLine() {
  ensureLineReader();
  if (lineQueue.length) return Promise.resolve(lineQueue.shift());
  if (stdinEnded) return Promise.resolve('');
  return new Promise((resolve) => lineWaiters.push(resolve));
}

function closePrompts() {
  try { process.stdin.pause(); } catch (_) { /* noop */ }
}

async function askLine(question) {
  process.stdout.write(question);
  return (await nextLine()).trim();
}

function askHidden(question) {
  if (!process.stdin.isTTY) return askLine(question);
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let val = '';
    const onData = (ch) => {
      if (ch === '\n' || ch === '\r' || ch === '\u0004') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(val);
      } else if (ch === '\u0003') {
        process.stdout.write('\n');
        process.exit(130);
      } else if (ch === '\u007f' || ch === '\b') {
        val = val.slice(0, -1);
      } else {
        val += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function verifyConnection(token, url) {
  const client = await connect(token, url);
  try {
    const tools = await client.listTools();
    return tools.tools.map((t) => t.name);
  } finally {
    await client.close().catch(() => {});
  }
}

async function runSetup(argv) {
  try {
    return await runSetupFlow(argv);
  } finally {
    closePrompts();
  }
}

async function runSetupFlow(argv) {
  const flags = parseSetupFlags(argv);
  const interactive = !flags.nonInteractive && (process.stdin.isTTY || !flags.token && !flags.username);
  const prev = loadConfig();

  let url = flags.url || prev.url || BRIDGE_URL;
  if (interactive && !flags.url) {
    const a = await askLine(`URL del puente [${url}]: `);
    if (a) url = a.replace(/\/+$/, '');
  }

  let mode = null;
  if (flags.token) mode = 'token';
  else if (flags.username) mode = 'login';
  else if (interactive) {
    const a = await askLine('¿Cómo se autentica tu agente? [1] usuario y contraseña  [2] token legacy: ');
    mode = a === '2' ? 'token' : 'login';
  } else {
    fail(1, 'setup no interactivo: pasá --token T o --username U (--password P | --password-file F)');
  }

  const tokensFile = flags['tokens-file'] || prev.tokens_file
    || join(homedir(), '.config', 'muse-bridge-mcp', 'tokens.json');
  const cfg = { url };

  if (mode === 'token') {
    const token = flags.token || (await askHidden('Token legacy del agente: '));
    if (!token) fail(1, 'token vacío');
    const names = await verifyConnection(token, url);
    cfg.token = token;
    saveConfig(cfg);
    console.log(`✓ Conexión verificada contra ${url} (${names.length} tools).`);
  } else {
    const username = flags.username || (await askLine('Usuario del puente: '));
    if (!username) fail(1, 'usuario vacío');
    let password = flags.password;
    if (!password && flags['password-file']) password = readFileSync(flags['password-file'], 'utf8').trim();
    if (!password && interactive) password = await askHidden('Contraseña: ');
    if (!password) fail(1, 'falta la contraseña (--password o --password-file)');
    const access = await loginAndStore({ url, username, password, tokensFile });
    const names = await verifyConnection(access, url);
    cfg.username = username;
    if (tokensFile !== join(homedir(), '.config', 'muse-bridge-mcp', 'tokens.json')) cfg.tokens_file = tokensFile;
    saveConfig(cfg);
    console.log(`✓ Sesión iniciada como ${username} en ${url} (${names.length} tools).`);
  }

  console.log(`✓ Configuración guardada en ${CONFIG_FILE} (sin variables de entorno).`);
  console.log('Probá: muse-bridge-mcp list-agents');
}

async function runInstall(argv) {
  try {
    execFileSync('npm', ['--version'], { stdio: 'ignore' });
  } catch {
    fail(1, 'no se encontró npm: instalá Node.js >= 18 (incluye npm) y reintentá');
  }
  console.log('Instalando muse-bridge-mcp globalmente (npm install -g github:MartoneWorkshop/muse-bridge-connect)…');
  try {
    execFileSync('npm', ['install', '-g', 'github:MartoneWorkshop/muse-bridge-connect'], { stdio: 'inherit' });
    console.log('✓ CLI instalado: queda disponible el comando `muse-bridge-mcp`.');
  } catch {
    console.error('aviso: la instalación global falló (¿permisos?). Podés reintentar con:');
    console.error('  npm install -g github:MartoneWorkshop/muse-bridge-connect');
    console.error('Sigo con la configuración: la config es la misma y el CLI la lee igual.');
  }
  await runSetup(argv);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    console.log(HELP);
    process.exit(cmd ? 0 : 1);
  }

  if (cmd === 'setup') { await runSetup(rest); return; }
  if (cmd === 'install') { await runInstall(rest); return; }

  if (cmd === 'tools') {
    const tools = await withClient((c) => c.listTools());
    console.log(JSON.stringify(tools.tools.map((t) => t.name), null, 2));
    return;
  }

  if (cmd === 'call') {
    const toolName = rest[0];
    if (!toolName) fail(1, 'uso: call <tool> --json \'{...}\'');
    let args = {};
    const j = rest.indexOf('--json');
    if (j >= 0 && rest[j + 1]) { try { args = JSON.parse(rest[j + 1]); } catch { fail(1, '--json no es JSON válido'); } }
    const result = await withClient((c) => c.callTool({ name: toolName, arguments: args }));
    printResult(result);
    return;
  }

  const spec = COMMANDS[cmd];
  if (!spec) fail(1, `subcomando desconocido: ${cmd} (ver --help)`);
  const args = parseFlags(rest, spec);
  const result = await withClient((c) => c.callTool({ name: spec.tool, arguments: args }));
  printResult(result);
}

main().catch((e) => {
  if (e && e.code === 'config') fail(1, e.message);
  if (e && e.code === 'auth') fail(2, e.message);
  fail(2, String(e && e.message || e));
});
