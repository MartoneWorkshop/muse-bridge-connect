#!/usr/bin/env node
/**
 * inagate-bridge-executor — Ejecutor del lado del usuario (kit inagate-bridge-connect) v1.
 *
 * Corre EN LA COMPUTADORA DEL USUARIO, con SUS credenciales y SU runtime/cuota.
 * Implementa el diseño «Ejecutor del lado del usuario v1» (INAGATE):
 *
 *  Ciclo por agente servido:
 *   1. GET /api/poller/governance — interruptor F-10; si está apagado, espera.
 *   2. GET /api/action-requests?status=approved — tickets aprobados (claim/update).
 *   3. Reintenta reportes locales pendientes de aprobación (estado local).
 *   4. GET /api/tasks?assignee=<agente>&status=pending (+ running cuyo claim fue
 *      aprobado y aplicado por el servidor: se adoptan y se ejecutan).
 *   5. Validación de gobernanza local (espejo R1–R4 del runner de referencia).
 *   6. Reclamo gobernado vía MCP `bridge_claim_task` (con action_request_id si
 *      hay ticket aprobado). approval_required / autonomy_denied => NO ejecuta.
 *   7. Ejecución del runtime local con el prompt por stdin y timeout.
 *   8. Reporte gobernado (PATCH /api/tasks/:id en modo `direct`, o mensaje
 *      `task_result` en modo `task_result_message`) con read-back de verificación.
 *   9. Telemetría best-effort a /api/reports y /api/prompts (un 403 se omite).
 *
 * Seguridad: ningún secreto vive en el repo. La URL y la credencial salen de la
 * config/auth del kit (`cli/auth.mjs`: token legacy o sesión login), o de una
 * credencial por agente declarada en la config del ejecutor (archivo de config
 * del kit con `token`, o archivo de token 0600). Ver executor/README.md.
 *
 * Uso:
 *   node executor/inagate-bridge-executor.mjs [--config <executor.json>]
 *                                           [--dry-run] [--once]
 */
import {
  readFileSync, writeFileSync, renameSync, mkdirSync, existsSync,
  appendFileSync, openSync, closeSync, unlinkSync, statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// SDK MCP (ya es dependencia del kit): import normal y, si el paquete se corre
// desde el repo sin `npm install` en la raíz, fallback a la copia de cli/.
// ---------------------------------------------------------------------------
async function importSdk(rel) {
  try {
    return await import(`@modelcontextprotocol/sdk/${rel}`);
  } catch (firstErr) {
    const fallback = join(HERE, '..', 'cli', 'node_modules', '@modelcontextprotocol', 'sdk', rel);
    if (existsSync(fallback)) return import(pathToFileURL(fallback).href);
    throw firstErr;
  }
}
const { Client } = await importSdk('client/index.js');
const { StreamableHTTPClientTransport } = await importSdk('client/streamableHttp.js');

// Auth del kit: NO se duplica. Resuelve URL base + bearer (token legacy o login).
const auth = await import(pathToFileURL(join(HERE, '..', 'cli', 'auth.mjs')).href);
const KIT_BRIDGE_URL = auth.BRIDGE_URL;

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
function expandHome(p) {
  if (!p || typeof p !== 'string') return p;
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  return p;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
function truncate(s, n) {
  const str = String(s ?? '');
  return str.length > n ? str.slice(0, n) : str;
}

// ---------------------------------------------------------------------------
// Argumentos y configuración
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { config: null, dryRun: false, once: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--once') out.once = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--config') {
      out.config = argv[++i];
      if (!out.config) throw new Error('--config necesita una ruta');
    } else if (a.startsWith('--config=')) out.config = a.slice('--config='.length);
    else throw new Error(`argumento desconocido: ${a}`);
  }
  return out;
}

const HELP = `inagate-bridge-executor — ejecutor local de tareas de INAGATE (lado del usuario)

Uso:
  node executor/inagate-bridge-executor.mjs [--config <ruta>] [--dry-run] [--once]

  --config <ruta>  Config del ejecutor (default: $BRIDGE_EXECUTOR_CONFIG o
                   ~/.config/inagate-bridge-mcp/executor.json)
  --dry-run        Lista y muestra qué reclamaría/ejecutaría, sin reclamar
                   ni ejecutar ni reportar.
  --once           Un solo ciclo y salir (útil para timers/cron y pruebas).

La URL del puente y la credencial por defecto salen de la config del kit
(cli/auth.mjs: ~/.config/inagate-bridge-mcp/config.json o entorno BRIDGE_*).
Ver executor/README.md y executor/executor.example.json.`;

const DEFAULT_EXECUTOR_CONFIG = join(homedir(), '.config', 'inagate-bridge-mcp', 'executor.json');

function loadExecutorConfig(args) {
  const path = expandHome(args.config || process.env.BRIDGE_EXECUTOR_CONFIG || DEFAULT_EXECUTOR_CONFIG);
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`no se pudo leer la config del ejecutor en ${path} (${e.code || e.message}). Ver executor/executor.example.json.`);
  }
  const cfg = {
    configPath: path,
    agents: Array.isArray(raw.agents) ? raw.agents.map((s) => String(s).trim()).filter(Boolean) : [],
    runtime_command: typeof raw.runtime_command === 'string' ? raw.runtime_command : null,
    runtime_args: Array.isArray(raw.runtime_args) ? raw.runtime_args.map(String) : [],
    poll_interval_ms: Number(raw.poll_interval_ms) > 0 ? Number(raw.poll_interval_ms) : 60000,
    transition_mode: raw.transition_mode === 'task_result_message' ? 'task_result_message' : 'direct',
    claim_mode: typeof raw.claim_mode === 'string' ? raw.claim_mode : 'approved',
    allowed_requesters: Array.isArray(raw.allowed_requesters)
      ? raw.allowed_requesters.map((s) => String(s).trim().toLowerCase()).filter(Boolean)
      : [],
    log_dir: expandHome(raw.log_dir || '~/.local/state/inagate-bridge-executor/logs'),
    timeout_ms: Number(raw.timeout_ms) > 0 ? Number(raw.timeout_ms) : 1800000,
    presence_updates: raw.presence_updates === true,
    max_consecutive_errors: Number(raw.max_consecutive_errors) > 0 ? Number(raw.max_consecutive_errors) : 5,
    credentials: (raw.credentials && typeof raw.credentials === 'object') ? raw.credentials : {},
    state_file: raw.state_file ? expandHome(raw.state_file) : null,
    lock_dir: raw.lock_dir ? expandHome(raw.lock_dir) : null,
  };
  if (cfg.agents.length === 0) {
    throw new Error('la config del ejecutor no declara "agents" (lista de agentes propios a servir).');
  }
  return cfg;
}

// ---------------------------------------------------------------------------
// Credenciales por agente
//  - Sin entrada en `credentials`: credencial compartida del kit (auth.mjs).
//  - credentials[agente].config_file: otro config.json del kit ({url, token}).
//  - credentials[agente].token_file: archivo 0600 con el token legacy del agente.
// ---------------------------------------------------------------------------
const staticTokenCache = new Map();
function resolveAgentAuthBase(cfg, agentId) {
  const cred = cfg.credentials[agentId];
  if (cred && typeof cred === 'object') {
    if (cred.config_file) {
      const file = expandHome(cred.config_file);
      const j = JSON.parse(readFileSync(file, 'utf8'));
      return { url: (j.url || KIT_BRIDGE_URL).replace(/\/+$/, ''), mode: 'file', file, fileJson: j };
    }
    if (cred.token_file) {
      return { url: KIT_BRIDGE_URL, mode: 'token_file', file: expandHome(cred.token_file) };
    }
  }
  return { url: KIT_BRIDGE_URL, mode: 'kit' };
}
async function getAgentToken(cfg, agentId, force = false) {
  const base = resolveAgentAuthBase(cfg, agentId);
  if (base.mode === 'kit') return auth.getBearerToken(force);
  if (staticTokenCache.has(agentId) && !force) return staticTokenCache.get(agentId);
  let token = null;
  if (base.mode === 'file') {
    if (typeof base.fileJson.token === 'string' && base.fileJson.token) token = base.fileJson.token;
    else throw new Error(`la credencial por agente de '${agentId}' (${base.file}) no trae "token": en v1 las credenciales por agente usan token legacy; la sesión login compartida se configura sin entrada en "credentials".`);
  } else {
    token = readFileSync(base.file, 'utf8').trim();
    if (!token) throw new Error(`archivo de token vacío para '${agentId}': ${base.file}`);
  }
  staticTokenCache.set(agentId, token);
  return token;
}
function agentUrl(cfg, agentId) {
  return resolveAgentAuthBase(cfg, agentId).url;
}

// ---------------------------------------------------------------------------
// Logger (consola + executor.log)
// ---------------------------------------------------------------------------
class Logger {
  constructor(logDir) {
    this.logDir = logDir;
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    this.file = join(logDir, 'executor.log');
  }
  line(level, agent, taskId, msg) {
    const parts = [`[${nowIso()}]`, `[${level}]`];
    if (agent) parts.push(`[@${agent}]`);
    if (taskId) parts.push(`[task ${taskId}]`);
    const text = `${parts.join(' ')} ${msg}`;
    console.log(text);
    try { appendFileSync(this.file, text + '\n', 'utf8'); } catch (_) { /* el log nunca rompe el ciclo */ }
  }
  info(a, t, m) { this.line('info', a, t, m); }
  warn(a, t, m) { this.line('warn', a, t, m); }
  error(a, t, m) { this.line('error', a, t, m); }
}

// ---------------------------------------------------------------------------
// Estado local anti-re-reclamo / reportes pendientes
// ---------------------------------------------------------------------------
class LocalState {
  constructor(file) {
    this.file = file;
    this.data = { tasks: {} };
    try {
      const j = JSON.parse(readFileSync(file, 'utf8'));
      if (j && typeof j === 'object' && j.tasks) this.data = j;
    } catch (_) { /* estado nuevo */ }
  }
  get(taskId) { return this.data.tasks[taskId] || null; }
  set(taskId, entry) {
    this.data.tasks[taskId] = { ...entry, updatedAt: Date.now() };
    this.save();
  }
  del(taskId) { delete this.data.tasks[taskId]; this.save(); }
  entriesFor(agentId, stage) {
    return Object.entries(this.data.tasks)
      .filter(([, e]) => e && e.agent === agentId && (!stage || e.stage === stage))
      .map(([taskId, e]) => ({ taskId, ...e }));
  }
  save() {
    // Poda: entradas 'done' de más de 24 h fuera; tope blando de 500.
    const cutoff = Date.now() - 24 * 3600 * 1000;
    for (const [k, e] of Object.entries(this.data.tasks)) {
      if (e && e.stage === 'done' && e.updatedAt < cutoff) delete this.data.tasks[k];
    }
    const keys = Object.keys(this.data.tasks);
    if (keys.length > 500) {
      keys.sort((a, b) => (this.data.tasks[a].updatedAt || 0) - (this.data.tasks[b].updatedAt || 0));
      for (const k of keys.slice(0, keys.length - 500)) delete this.data.tasks[k];
    }
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (_) { /* best-effort */ }
  }
}

// ---------------------------------------------------------------------------
// Lockfile por agente (instancia única)
// ---------------------------------------------------------------------------
function acquireLock(lockFile, logger, agentId) {
  mkdirSync(dirname(lockFile), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockFile, 'wx');
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return { acquired: true };
    } catch (e) {
      if (e.code !== 'EEXIST') return { acquired: false, reason: e.code || 'lock_error' };
      let pid = null;
      try { pid = Number(readFileSync(lockFile, 'utf8').trim()); } catch (_) { /* ilegible */ }
      let alive = false;
      if (pid) { try { process.kill(pid, 0); alive = true; } catch (_) { alive = false; } }
      if (alive) return { acquired: false, reason: 'alive', pid };
      try {
        const st = statSync(lockFile);
        if (Date.now() - st.mtimeMs < 5000 && attempt === 0) { continue; }
        unlinkSync(lockFile);
        logger.warn(agentId, null, `lockfile huérfano de PID ${pid || '?'} recuperado.`);
      } catch (_) { return { acquired: false, reason: 'stale_unremovable' }; }
    }
  }
  return { acquired: false, reason: 'contention' };
}
function releaseLock(lockFile) {
  try {
    if (Number(readFileSync(lockFile, 'utf8').trim()) === process.pid) unlinkSync(lockFile);
  } catch (_) { /* ya liberado */ }
}

// ---------------------------------------------------------------------------
// HTTP gobernado (REST del puente) con la credencial del agente
// ---------------------------------------------------------------------------
async function apiFetch(cfg, agentId, method, path, body, { timeoutMs = 20000 } = {}) {
  const base = agentUrl(cfg, agentId);
  const doCall = async (force) => {
    const token = await getAgentToken(cfg, agentId, force);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(base + path, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      const json = await res.json().catch(() => ({}));
      return { status: res.status, json };
    } finally { clearTimeout(t); }
  };
  let r = await doCall(false);
  if (r.status === 401) r = await doCall(true); // renueva sesión login del kit una vez
  return r;
}

// ---------------------------------------------------------------------------
// Gobernanza local (espejo R1–R4 del runner de referencia)
// ---------------------------------------------------------------------------
function validateGovernance(task, agentId, allowedSet) {
  if (!task || typeof task !== 'object') return { valid: false, reason: 'invalid_task_payload' };
  const agent = agentId.toLowerCase();
  const requester = String(task.requester_agent || '').trim().toLowerCase();
  const assignee = String(task.assignee_agent || '').trim().toLowerCase();
  const status = String(task.status || '').trim().toLowerCase();
  // R1: prohibida la auto-asignación (el solicitante no puede ser el propio agente)
  if (requester === agent) return { valid: false, reason: 'self_assignment_forbidden', details: `solicitante '${task.requester_agent}' es el propio agente` };
  // R1: lista blanca de solicitantes (config local o gobernanza del servidor)
  if (allowedSet && allowedSet.size > 0 && !allowedSet.has(requester)) {
    return { valid: false, reason: 'unauthorized_requester', details: `solicitante '${task.requester_agent}' no autorizado (permitidos: ${[...allowedSet].join(', ')})` };
  }
  // Asignación estricta: solo tareas asignadas a ESTE agente
  if (assignee !== agent) return { valid: false, reason: 'assignee_mismatch', details: `asignado '${task.assignee_agent}' ≠ '${agentId}'` };
  // R2: solo 'pending' (o 'running' si ya fue reclamada en este flujo)
  if (status !== 'pending' && !(task._alreadyRunning && status === 'running')) {
    return { valid: false, reason: 'status_not_pending', details: `estado '${task.status}' ≠ 'pending'` };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Reclamo MCP bridge_claim_task (mismo contrato que tools/agy-runner/claim.mjs)
// ---------------------------------------------------------------------------
async function claimViaMcp(cfg, agentId, taskId, actionRequestId) {
  const base = agentUrl(cfg, agentId);
  const token = await getAgentToken(cfg, agentId, false);
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'inagate-bridge-executor', version: '1.0.0' }, { capabilities: {} });
  try {
    await client.connect(transport);
    const args = { task_id: taskId };
    if (actionRequestId) args.action_request_id = actionRequestId;
    const res = await client.callTool({ name: 'bridge_claim_task', arguments: args });
    const sc = res.structuredContent || {};
    if (res.isError) {
      const code = sc.error || sc.code || 'claim_failed';
      const text = res.content?.[0]?.text || code;
      if (code === 'approval_required') return { ok: false, approvalRequired: true, requestId: sc.request_id || null, code, error: text };
      if (code === 'conflict' || sc.status === 'conflict') return { ok: false, conflict: true, code: 'conflict', error: text };
      if (code === 'autonomy_denied') return { ok: false, blocked: true, code, error: text };
      return { ok: false, code, error: text };
    }
    return { ok: true, task: sc.task || null };
  } catch (err) {
    const msg = String(err && err.message || err);
    if (msg.includes('approval_required')) return { ok: false, approvalRequired: true, requestId: null, code: 'approval_required', error: msg };
    if (msg.includes('autonomy_denied')) return { ok: false, blocked: true, code: 'autonomy_denied', error: msg };
    return { ok: false, code: 'mcp_connection_error', error: msg };
  } finally {
    try { await client.close(); } catch (_) { /* noop */ }
    try { await transport.close(); } catch (_) { /* noop */ }
  }
}

// ---------------------------------------------------------------------------
// Prompt y ejecución del runtime local
// ---------------------------------------------------------------------------
function buildPrompt(task, text) {
  const requester = task.requester_agent || 'desconocido';
  let prompt = `[TAREA ASIGNADA POR @${requester} EN MUSE-BRIDGE - ID: ${task.id}]\nInstrucción formal de ejecución:\n${text || 'Sin descripción'}`;
  if (task.external_ref && typeof task.external_ref === 'object') {
    const ext = task.external_ref;
    prompt += `\n\n[CONTEXTO DE REFERENCIA EXTERNA]\n${JSON.stringify(ext)}`;
  }
  return prompt;
}

function runRuntime(cfg, prompt, taskLogFile) {
  return new Promise((resolvePromise) => {
    const env = { ...process.env };
    delete env.BRIDGE_TOKEN; delete env.BRIDGE_DELEGATED_TOKEN; // la credencial del puente no se filtra al runtime
    let child;
    try {
      child = spawn(cfg.runtime_command, cfg.runtime_args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      return resolvePromise({ success: false, exitCode: 1, stdout: '', stderr: `spawn: ${err.message}`, timedOut: false });
    }
    let stdout = ''; let stderr = ''; let timedOut = false;
    const cap = (s) => (s.length > 1000000 ? s.slice(0, 1000000) : s);
    child.stdout.on('data', (d) => { stdout = cap(stdout + d.toString()); });
    child.stderr.on('data', (d) => { stderr = cap(stderr + d.toString()); });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch (_) { /* noop */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) { /* noop */ } }, 5000).unref();
    }, cfg.timeout_ms);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolvePromise({ success: false, exitCode: 1, stdout, stderr: stderr + `\n[spawn error] ${err.message}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        appendFileSync(taskLogFile, `\n=== SALIDA STDOUT ===\n${stdout}\n=== SALIDA STDERR ===\n${stderr}\n=== FIN (exit=${code}${timedOut ? ', timeout' : ''}) ===\n`, 'utf8');
      } catch (_) { /* noop */ }
      resolvePromise({ success: code === 0 && !timedOut, exitCode: code ?? 1, stdout, stderr, timedOut });
    });
    child.stdin.on('error', () => { /* el runtime pudo cerrar stdin */ });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Transición gobernada + read-back
// ---------------------------------------------------------------------------
async function transitionTask(cfg, agentId, task, finalStatus, resultText, actionRequestId) {
  if (cfg.transition_mode === 'task_result_message') {
    const r = await apiFetch(cfg, agentId, 'POST', '/api/messages', {
      to: task.requester_agent || 'all',
      type: 'task_result',
      channel: task.channel_id || 'general',
      task_id: task.id,
      status: finalStatus === 'completed' ? 'done' : 'error',
      text: resultText,
    });
    if (r.status === 200 || r.status === 201) return { ok: true, mode: 'task_result_message' };
    const code = r.json?.code || 'http_error';
    if (code === 'approval_required') return { ok: false, approvalRequired: true, requestId: r.json?.request_id || null, code, error: r.json?.error || '' };
    if (code === 'autonomy_denied') return { ok: false, blocked: true, code, error: r.json?.error || '' };
    return { ok: false, code, status: r.status, error: r.json?.error || `HTTP ${r.status}` };
  }
  // Modo direct: PATCH /api/tasks/:id
  const body = { status: finalStatus };
  if (actionRequestId) body.action_request_id = actionRequestId;
  const r = await apiFetch(cfg, agentId, 'PATCH', `/api/tasks/${encodeURIComponent(task.id)}`, body);
  if (r.status === 200) return { ok: true, mode: 'direct', task: r.json?.task || null };
  const code = r.json?.code || (r.status === 403 ? 'forbidden' : 'http_error');
  if (code === 'approval_required') return { ok: false, approvalRequired: true, requestId: r.json?.request_id || null, code, error: r.json?.error || '' };
  if (code === 'autonomy_denied') return { ok: false, blocked: true, code, error: r.json?.error || '' };
  return { ok: false, code, status: r.status, error: r.json?.error || `HTTP ${r.status}` };
}

async function readBackTask(cfg, agentId, taskId) {
  const r = await apiFetch(cfg, agentId, 'GET', `/api/tasks/${encodeURIComponent(taskId)}`);
  if (r.status === 200) return r.json?.task || null;
  return null;
}

// Telemetría gobernada: si el puente la rechaza (403), se omite sin fallar.
async function emitTelemetry(cfg, logger, agentId, task, prompt, execRes, finalStatus) {
  const summary = truncate(execRes.stdout || execRes.stderr || '', 1000);
  try {
    const r = await apiFetch(cfg, agentId, 'POST', '/api/reports', {
      title: `Informe de ejecución: ${truncate(task.id, 60)}`,
      kind: 'dictamen',
      verdict: execRes.success ? 'apto' : 'no_apto',
      status: 'vigente',
      author_type: 'trusted_agent',
      author_agent_id: agentId,
      task_id: task.id,
      instruction_text: truncate(prompt, 4000),
      observations_text: `Ejecución local mediante inagate-bridge-executor (runtime del usuario).`,
      proposal_text: 'Ejecución directa en el equipo del usuario.',
      implementation_text: truncate(execRes.stdout || execRes.stderr || 'Sin salida.', 5000),
      file: {
        filename: `informe_${task.id}.md`,
        content: `# Informe de ejecución ${task.id}\n\n## Salida\n\n\`\`\`\n${truncate(execRes.stdout || execRes.stderr || '', 3000)}\n\`\`\`\n`,
        mime: 'text/markdown',
      },
    });
    if (r.status === 403) logger.info(agentId, task.id, 'telemetría /api/reports omitida (403 del puente).');
    else if (r.status >= 400) logger.warn(agentId, task.id, `telemetría /api/reports respondió ${r.status}; se omite.`);
  } catch (e) { logger.warn(agentId, task.id, `telemetría /api/reports omitida (${e.message}).`); }
  try {
    const r = await apiFetch(cfg, agentId, 'POST', '/api/prompts', {
      from_kind: 'agent',
      from_agent_id: task.requester_agent || agentId,
      to_kind: 'agent',
      to_agent_id: agentId,
      task_id: task.id,
      prompt_type: 'ejecucion',
      prompt_text: prompt,
      request_excerpt: truncate(prompt, 200),
      result_status: execRes.success ? 'ok' : 'error',
      result_summary: summary.slice(0, 500),
    });
    if (r.status === 403) logger.info(agentId, task.id, 'telemetría /api/prompts omitida (403 del puente).');
    else if (r.status >= 400) logger.warn(agentId, task.id, `telemetría /api/prompts respondió ${r.status}; se omite.`);
  } catch (e) { logger.warn(agentId, task.id, `telemetría /api/prompts omitida (${e.message}).`); }
}

// ---------------------------------------------------------------------------
// Texto de la tarea (las tareas guardan el texto en su mensaje de origen)
// ---------------------------------------------------------------------------
async function fetchTaskText(cfg, agentId, task) {
  if (typeof task.text === 'string' && task.text) return task.text;
  if (task.output_message && typeof task.output_message.text === 'string') return task.output_message.text;
  if (task.message_id) {
    try {
      const r = await apiFetch(cfg, agentId, 'GET', `/api/channels/${encodeURIComponent(task.channel_id || 'general')}/messages?limit=200`);
      const msgs = r.json?.messages || r.json?.data || [];
      const m = Array.isArray(msgs) ? msgs.find((x) => Number(x.id) === Number(task.message_id)) : null;
      if (m && typeof m.text === 'string') return m.text;
    } catch (_) { /* fallback abajo */ }
  }
  return '';
}

// ---------------------------------------------------------------------------
// Ejecución + reporte de una tarea ya reclamada (status running)
// ---------------------------------------------------------------------------
async function executeAndReport(ctx, agentId, task, updateTickets) {
  const { cfg, logger, state } = ctx;
  const taskLogFile = join(cfg.log_dir, `${task.id}.log`);
  const text = await fetchTaskText(cfg, agentId, task);
  const prompt = buildPrompt({ ...task, text: text || task.text }, text);
  try {
    writeFileSync(taskLogFile, `=== EJECUTOR LOCAL: tarea ${task.id} (${nowIso()}) ===\nPROMPT:\n${prompt}\n`, 'utf8');
  } catch (_) { /* noop */ }
  logger.info(agentId, task.id, `ejecutando runtime local (${cfg.runtime_command})…`);
  const execRes = await runRuntime(cfg, prompt, taskLogFile);
  const finalStatus = execRes.success ? 'completed' : 'failed';
  const resultText = execRes.success
    ? `[executor] Tarea completada con éxito.\nBitácora local: ${taskLogFile}\nSalida:\n${truncate(execRes.stdout, 1000)}`
    : `[executor] Tarea falló (exit ${execRes.exitCode}${execRes.timedOut ? ', timeout' : ''}).\nBitácora local: ${taskLogFile}\nErrores:\n${truncate(execRes.stderr || execRes.stdout, 1000)}`;
  logger.info(agentId, task.id, `runtime terminó exit=${execRes.exitCode} → reporte '${finalStatus}' (modo ${cfg.transition_mode}).`);

  const ticket = updateTickets.get(`${task.id}:${finalStatus}`) || updateTickets.get(task.id) || null;
  const tr = await transitionTask(cfg, agentId, task, finalStatus, resultText, ticket);
  if (tr.approvalRequired) {
    state.set(task.id, { agent: agentId, stage: 'report_pending', finalStatus, resultText, requestId: tr.requestId || ticket || null });
    logger.info(agentId, task.id, `reporte en doctrina consultar: aprobación requerida (solicitud ${tr.requestId || 'registrada'}). No se fuerza el cierre; se reintenta cuando el ticket esté aprobado.`);
    return { reported: false, pendingApproval: true };
  }
  if (tr.blocked) {
    state.set(task.id, { agent: agentId, stage: 'report_pending', finalStatus, resultText, requestId: ticket || null, blocked: true });
    logger.warn(agentId, task.id, `reporte bloqueado por gobernanza (autonomy_denied). Queda pendiente sin reintentos en bucle.`);
    return { reported: false, blocked: true };
  }
  if (!tr.ok) {
    state.set(task.id, { agent: agentId, stage: 'report_pending', finalStatus, resultText, requestId: ticket || null });
    logger.error(agentId, task.id, `falló la transición a '${finalStatus}': ${tr.code || ''} ${tr.error || ''}`.trim());
    return { reported: false, error: true };
  }
  // Read-back obligatorio: la tarea debe quedar en el estado esperado.
  const back = await readBackTask(cfg, agentId, task.id);
  if (!back || back.status !== finalStatus) {
    state.set(task.id, { agent: agentId, stage: 'report_pending', finalStatus, resultText, requestId: ticket || null });
    logger.error(agentId, task.id, `read-back NO confirma '${finalStatus}' (estado actual: ${back ? back.status : 'sin lectura'}). Posible closure_not_persisted; no se reintenta en bucle.`);
    return { reported: false, error: true };
  }
  state.set(task.id, { agent: agentId, stage: 'done', finalStatus });
  logger.info(agentId, task.id, `reporte confirmado por read-back: estado '${back.status}'.`);
  await emitTelemetry(cfg, logger, agentId, task, prompt, execRes, finalStatus);
  return { reported: true };
}

// ---------------------------------------------------------------------------
// Ciclo por agente
// ---------------------------------------------------------------------------
async function processAgent(ctx, agentId, { dryRun }) {
  const { cfg, logger, state } = ctx;
  const lockFile = join(cfg.lock_dir || cfg.log_dir, `executor-${agentId}.lock`);
  const lock = acquireLock(lockFile, logger, agentId);
  if (!lock.acquired) {
    logger.info(agentId, null, `otra instancia sirve a este agente (lock: ${lock.reason}${lock.pid ? `, PID ${lock.pid}` : ''}); ciclo omitido.`);
    return { errors: 0 };
  }
  let errors = 0;
  try {
    // 1) Interruptor de gobernanza del poller (F-10)
    let govEnabled = true;
    let govAllowed = null;
    try {
      const g = await apiFetch(cfg, agentId, 'GET', '/api/poller/governance');
      if (g.status === 200 && g.json && g.json.ok) {
        govEnabled = g.json.enabled !== false;
        if (Array.isArray(g.json.allowed_requesters)) {
          govAllowed = new Set(g.json.allowed_requesters.map((s) => String(s).trim().toLowerCase()).filter(Boolean));
        }
      }
    } catch (e) {
      logger.warn(agentId, null, `no se pudo leer /api/poller/governance (${e.message}); se continúa con la config local.`);
    }
    if (!govEnabled) {
      logger.info(agentId, null, 'gobernanza del poller DESHABILITADA en el puente (F-10): no se ejecuta nada en este ciclo.');
      return { errors: 0 };
    }
    // Lista blanca efectiva: manda la config local si el usuario la definió;
    // si no, la del servidor (que además aplica su gate al reclamar).
    const allowedSet = cfg.allowed_requesters.length > 0
      ? new Set(cfg.allowed_requesters)
      : (govAllowed || new Set());

    // 2) Tickets aprobados de este agente
    const claimTickets = new Map();
    const updateTickets = new Map();
    try {
      const ar = await apiFetch(cfg, agentId, 'GET', `/api/action-requests?agent_id=${encodeURIComponent(agentId)}&status=approved`);
      const list = ar.json?.requests || ar.json?.action_requests || [];
      for (const r of Array.isArray(list) ? list : []) {
        if (r.action_type === 'tasks.claim' && r.payload?.task_id) claimTickets.set(r.payload.task_id, r.id);
        if (r.action_type === 'tasks.update' && r.payload?.task_id) {
          updateTickets.set(`${r.payload.task_id}:${r.payload.status}`, r.id);
          if (!updateTickets.has(r.payload.task_id)) updateTickets.set(r.payload.task_id, r.id);
        }
      }
    } catch (e) {
      logger.warn(agentId, null, `no se pudieron leer action-requests aprobados (${e.message}).`);
    }

    // 3) Reportes locales pendientes de aprobación: reintentar solo con ticket
    //    aprobado, o confirmar si el servidor ya aplicó la aprobación.
    if (!dryRun) {
      for (const entry of state.entriesFor(agentId, 'report_pending')) {
        const cur = await readBackTask(cfg, agentId, entry.taskId);
        if (!cur) { logger.warn(agentId, entry.taskId, 'reporte pendiente: la tarea ya no se lee; se descarta el pendiente local.'); state.del(entry.taskId); continue; }
        if (cur.status === entry.finalStatus) {
          state.set(entry.taskId, { agent: agentId, stage: 'done', finalStatus: entry.finalStatus });
          logger.info(agentId, entry.taskId, `reporte confirmado: el estado ya es '${entry.finalStatus}' (aprobación aplicada).`);
          continue;
        }
        const ticket = updateTickets.get(`${entry.taskId}:${entry.finalStatus}`) || updateTickets.get(entry.taskId) || null;
        if (!ticket) {
          logger.info(agentId, entry.taskId, `reporte '${entry.finalStatus}' sigue esperando aprobación (solicitud ${entry.requestId || 's/d'}).`);
          continue;
        }
        const tr = await transitionTask(cfg, agentId, cur, entry.finalStatus, entry.resultText || '', ticket);
        if (tr.ok) {
          const back = await readBackTask(cfg, agentId, entry.taskId);
          if (back && back.status === entry.finalStatus) {
            state.set(entry.taskId, { agent: agentId, stage: 'done', finalStatus: entry.finalStatus });
            logger.info(agentId, entry.taskId, `reporte con ticket aprobado confirmado por read-back: '${back.status}'.`);
          } else {
            logger.error(agentId, entry.taskId, `read-back tras reporte con ticket no confirma '${entry.finalStatus}'.`);
            errors++;
          }
        } else if (tr.approvalRequired) {
          logger.info(agentId, entry.taskId, 'el reporte volvió a pedir aprobación; queda pendiente.');
        } else if (tr.blocked) {
          logger.warn(agentId, entry.taskId, 'reporte con ticket bloqueado (autonomy_denied); queda pendiente.');
        } else {
          logger.error(agentId, entry.taskId, `reintento de reporte falló: ${tr.code || ''} ${tr.error || ''}`.trim());
          errors++;
        }
      }
    }

    // 4) Tareas running cuyo claim aprobado ya aplicó el servidor: adoptarlas.
    if (!dryRun) {
      try {
        const rr = await apiFetch(cfg, agentId, 'GET', `/api/tasks?assignee=${encodeURIComponent(agentId)}&status=running`);
        const running = rr.json?.tasks || [];
        for (const t of Array.isArray(running) ? running : []) {
          const st = state.get(t.id);
          if (st && st.stage === 'awaiting_claim_approval') {
            logger.info(agentId, t.id, 'el claim aprobado ya fue aplicado (tarea en running asignada): se adopta y se ejecuta localmente.');
            await executeAndReport(ctx, agentId, { ...t, _alreadyRunning: true }, updateTickets);
          }
        }
      } catch (e) {
        logger.warn(agentId, null, `no se pudieron listar tareas running (${e.message}).`);
      }
    }

    // 5) Tareas pendientes asignadas
    const pr = await apiFetch(cfg, agentId, 'GET', `/api/tasks?assignee=${encodeURIComponent(agentId)}&status=pending`);
    if (pr.status !== 200) {
      logger.error(agentId, null, `GET /api/tasks respondió ${pr.status}: ${pr.json?.error || 'sin detalle'}`);
      return { errors: errors + 1 };
    }
    const tasks = Array.isArray(pr.json?.tasks) ? pr.json.tasks : [];
    if (tasks.length === 0) {
      logger.info(agentId, null, 'sin tareas pendientes.');
      return { errors };
    }
    logger.info(agentId, null, `${tasks.length} tarea(s) pendiente(s).`);

    for (const task of tasks) {
      const prev = state.get(task.id);
      if (prev && prev.stage === 'done') {
        logger.warn(agentId, task.id, 'la tarea ya fue reportada localmente pero el puente la muestra pending: no se re-reclama (anti-bucle).');
        continue;
      }
      const gov = validateGovernance(task, agentId, allowedSet);
      if (!gov.valid) {
        logger.warn(agentId, task.id, `gobernanza local: rechazada (${gov.reason}) — ${gov.details || ''}`);
        continue;
      }
      if (dryRun) {
        const text = await fetchTaskText(cfg, agentId, task);
        logger.info(agentId, task.id, `[dry-run] reclamaría vía MCP bridge_claim_task${claimTickets.has(task.id) ? ` con ticket ${claimTickets.get(task.id)}` : ''} y ejecutaría el runtime. Texto: ${truncate(text || task.text || '', 160)}`);
        continue;
      }
      // 6) Reclamo gobernado vía MCP
      const ticket = claimTickets.get(task.id) || null;
      const claim = await claimViaMcp(cfg, agentId, task.id, ticket);
      if (claim.approvalRequired) {
        state.set(task.id, { agent: agentId, stage: 'awaiting_claim_approval', requestId: claim.requestId || null });
        logger.info(agentId, task.id, `claim en doctrina consultar: approval_required (solicitud ${claim.requestId || 'registrada'}). NO se ejecuta; se espera el ticket aprobado.`);
        continue;
      }
      if (claim.blocked) {
        logger.warn(agentId, task.id, `claim bloqueado por gobernanza (autonomy_denied): ${truncate(claim.error, 200)} Sin reintentos en bucle.`);
        continue;
      }
      if (claim.conflict) {
        logger.info(agentId, task.id, 'claim en conflicto: otro ejecutor ya tomó la tarea; se ignora.');
        continue;
      }
      if (!claim.ok) {
        logger.error(agentId, task.id, `claim falló (${claim.code || 'error'}): ${truncate(claim.error, 240)}`);
        errors++;
        continue;
      }
      const claimedTask = claim.task ? { ...task, ...claim.task } : { ...task, status: 'running' };
      logger.info(agentId, task.id, `tarea reclamada (running)${ticket ? ` con ticket ${ticket}` : ''}.`);
      // 7–9) Ejecutar + reportar + telemetría
      await executeAndReport(ctx, agentId, claimedTask, updateTickets);
    }
    return { errors };
  } finally {
    releaseLock(lockFile);
  }
}

// ---------------------------------------------------------------------------
// Presencia rica opcional (la presencia real sale de la actividad autenticada)
// ---------------------------------------------------------------------------
async function setPresence(cfg, logger, agentId, status, text) {
  if (!cfg.presence_updates) return;
  try {
    await apiFetch(cfg, agentId, 'PUT', '/api/agents/me/presence', { presence_status: status, status_text: text });
  } catch (e) {
    logger.warn(agentId, null, `no se pudo actualizar la presencia (${e.message}).`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return 0; }
  const cfg = loadExecutorConfig(args);
  const logger = new Logger(cfg.log_dir);
  const state = new LocalState(cfg.state_file || join(cfg.log_dir, 'executor-state.json'));
  const ctx = { cfg, logger, state };

  if (!args.dryRun && !cfg.runtime_command) {
    throw new Error('la config del ejecutor no declara "runtime_command" (el runtime local del usuario).');
  }
  logger.info(null, null, `inagate-bridge-executor v1 iniciado — puente: ${KIT_BRIDGE_URL} — agentes: ${cfg.agents.join(', ')} — modo: ${args.once ? 'once' : 'loop'}${args.dryRun ? ' (dry-run)' : ''} — transición: ${cfg.transition_mode}.`);

  for (const a of cfg.agents) await setPresence(cfg, logger, a, 'online', 'Ejecutor local en línea');
  let stopping = false;
  const onSignal = async (sig) => {
    if (stopping) return; stopping = true;
    logger.info(null, null, `señal ${sig}: parada limpia.`);
    for (const a of cfg.agents) await setPresence(cfg, logger, a, 'away', 'Ejecutor local detenido');
    process.exit(0);
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  let consecutiveErrorCycles = 0;
  for (;;) {
    let cycleErrors = 0;
    for (const agentId of cfg.agents) {
      try {
        const r = await processAgent(ctx, agentId, { dryRun: args.dryRun });
        cycleErrors += r.errors || 0;
      } catch (e) {
        cycleErrors++;
        logger.error(agentId, null, `excepción en el ciclo: ${e.message}`);
      }
    }
    if (args.once) {
      logger.info(null, null, `ciclo único terminado (errores: ${cycleErrors}).`);
      return cycleErrors > 0 ? 1 : 0;
    }
    if (cycleErrors > 0) {
      consecutiveErrorCycles++;
      logger.warn(null, null, `ciclo con errores (${consecutiveErrorCycles}/${cfg.max_consecutive_errors} consecutivos).`);
      if (consecutiveErrorCycles >= cfg.max_consecutive_errors) {
        logger.error(null, null, `tope de ${cfg.max_consecutive_errors} ciclos con error alcanzado: el ejecutor se pausa. Revisá executor.log y la conexión con el puente.`);
        for (const a of cfg.agents) await setPresence(cfg, logger, a, 'away', 'Ejecutor local detenido');
        return 1;
      }
    } else {
      consecutiveErrorCycles = 0;
    }
    await sleep(cfg.poll_interval_ms);
  }
}

main()
  .then((code) => { process.exitCode = code || 0; })
  .catch((err) => { console.error(`[executor] error fatal: ${err.message}`); process.exitCode = 1; });
