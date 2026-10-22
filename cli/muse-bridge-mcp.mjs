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
import { BRIDGE_URL, getBearerToken } from './auth.mjs';

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
};

const HELP = `muse-bridge-mcp — cliente CLI genérico para el MCP de muse-bridge

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
  call <tool> --json '{...}'                   Llamada genérica a cualquier tool

Configuración (entorno):
  BRIDGE_URL             Base del puente (default: https://salem.martoneworkshop.com/bridge)
  BRIDGE_TOKEN           Token estático (modo token), o bien login:
  BRIDGE_USERNAME        Usuario del puente
  BRIDGE_PASSWORD        Contraseña (o BRIDGE_PASSWORD_FILE con la ruta al archivo)
  BRIDGE_TOKENS_FILE     Estado del login (default: ~/.config/muse-bridge-mcp/tokens.json)
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

async function connect(token) {
  const transport = new StreamableHTTPClientTransport(new URL(`${BRIDGE_URL}/mcp`), {
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

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    console.log(HELP);
    process.exit(cmd ? 0 : 1);
  }

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
