# Ejecutor del lado del usuario — inagate-bridge-connect

El ejecutor es el componente del kit que corre **en tu computadora** y hace que
tus agentes de INAGATE trabajen: sondea el puente, reclama las tareas asignadas
a **tus** agentes por la vía gobernada (MCP `bridge_claim_task`), las ejecuta
con **tu runtime y tu cuota** y reporta el resultado por las vías gobernadas del
puente. El puente gobierna; la ejecución y el costo quedan de tu lado.

## Qué hace en cada ciclo

Por cada agente de tu lista:

1. Consulta el interruptor de gobernanza del poller (`GET /api/poller/governance`).
   Si el puente lo apaga, no ejecuta nada.
2. Busca tickets aprobados en `GET /api/action-requests` (doctrina `consultar`).
3. Lista las tareas `pending` asignadas a ese agente y valida la gobernanza
   local: prohibida la auto-asignación, asignado == agente, estado `pending` y,
   si configuraste `allowed_requesters`, solicitante en la lista blanca.
4. Reclama vía MCP `bridge_claim_task`:
   - `ok` → ejecuta.
   - `approval_required` / `autonomy_denied` → **no ejecuta**. El pedido queda
     en la vía de aprobación del puente; en ciclos siguientes, con el ticket
     aprobado, reclama con `action_request_id`. La doctrina `consultar` nunca
     se salta: no hay opción de configuración para eso.
   - `conflict` → otro ejecutor la tomó; se ignora.
5. Ejecuta tu runtime local pasándole el prompt de la tarea **por stdin**, con
   timeout. La salida queda en `<log_dir>/<task_id>.log`.
6. Reporta: `PATCH /api/tasks/:id` (modo `direct`) o mensaje `task_result`
   (modo `task_result_message`), con **read-back** de verificación. Si el
   reporte cae en doctrina `consultar`, queda pendiente a nivel local y se
   completa cuando el ticket correspondiente se aprueba.
7. Telemetría best-effort a `/api/reports` y `/api/prompts`: si el puente
   responde 403, se omite sin fallar la tarea.

Presencia: cualquier request autenticada refresca tu `last_seen` en el puente,
así que el polling (≤ 60 s) te mantiene «en línea». Con `presence_updates: true`
además marca la presencia rica (`online` al arrancar, `away` al detenerse
limpiamente) vía `PUT /api/agents/me/presence`. El ejecutor no finge presencia:
si el proceso no corre, no hay actividad.

Anti-bucles: lockfile por agente (una instancia por agente), una tarea por vez
por agente, estado local (`<log_dir>/executor-state.json`) que evita
re-reclamar lo ya reportado y guarda los reportes pendientes de aprobación, y
tope de ciclos con error (`max_consecutive_errors`) tras el cual se pausa.

## Configuración

1. Primero configurá el kit como siempre (`inagate-bridge-mcp setup`): eso crea
   `~/.config/inagate-bridge-mcp/config.json` con la URL del puente y tu
   credencial (sesión login con usuario y contraseña; desde Cyber M-05, 2026-11-11, el puente ya no acepta tokens legacy). El ejecutor reutiliza ese módulo
   de autenticación; no guarda secretos propios.
2. Copiá la plantilla y completala:

   ```sh
   cp executor/executor.example.json ~/.config/inagate-bridge-mcp/executor.json
   chmod 600 ~/.config/inagate-bridge-mcp/executor.json
   ```

   Campos (ver también la plantilla comentada en `credentials._comentario`):

   | Campo | Significado |
   |---|---|
   | `agents` | Lista explícita de **tus** agentes a servir. Solo se tocan tareas asignadas a ellos. |
   | `runtime_command` / `runtime_args` | Tu runtime local. Recibe el prompt por **stdin**. Ej.: `agy` con `["--model", "gemini-3.8-flash-high"]`; si tu runtime espera el prompt como argumento, envolvelo en un script wrapper que lea stdin. |
   | `poll_interval_ms` | Intervalo entre ciclos (default 60000). |
   | `transition_mode` | `direct` (PATCH) o `task_result_message` (mensaje formal). |
   | `claim_mode` | `approved`: flujo de tickets aprobados para doctrina `consultar`. |
   | `allowed_requesters` | Lista blanca opcional de solicitantes. Vacía = manda la gobernanza del servidor. |
   | `log_dir` | Logs por ciclo (`executor.log`) y por tarea (`<task_id>.log`) + estado local. |
   | `timeout_ms` | Timeout por ejecución del runtime. |
   | `presence_updates` | `true` para presencia rica al arrancar/parar. |
   | `credentials` | Opcional, por agente: `{ "config_file": "~/.config/inagate-bridge-mcp/agents/<agente>.json" }` (un `config.json` del kit con su sesión login). La opción `token_file` (token legacy) quedó sin efecto: el puente la rechaza desde Cyber M-05 (2026-11-11). Sin entradas, se usa la credencial compartida del kit. |

   La URL del puente y la credencial salen de la config/auth del kit
   (`BRIDGE_URL`, `BRIDGE_TOKEN`, `BRIDGE_CONFIG_FILE`, etc. tienen prioridad
   por entorno, como en el CLI).

## Cómo se corre

```sh
# Ciclo continuo (default)
node executor/inagate-bridge-executor.mjs

# Un solo ciclo (timers, cron, pruebas)
node executor/inagate-bridge-executor.mjs --once

# Prueba en seco: lista y muestra qué haría, sin reclamar ni ejecutar
node executor/inagate-bridge-executor.mjs --dry-run --once

# Config en otra ruta
node executor/inagate-bridge-executor.mjs --config ~/executor-prueba.json --once
```

También queda expuesto como binario del paquete: `inagate-bridge-executor`
(ver `bin` en el `package.json` del kit).

### Dejarlo corriendo con systemd --user

```ini
# ~/.config/systemd/user/inagate-bridge-executor.service
[Unit]
Description=Ejecutor local de INAGATE (inagate-bridge-connect)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/dev/inagate-bridge-connect
ExecStart=/usr/bin/node %h/dev/inagate-bridge-connect/executor/inagate-bridge-executor.mjs
Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now inagate-bridge-executor.service
journalctl --user -u inagate-bridge-executor.service -f   # o el executor.log de log_dir
```

Alternativa sin servicio residente: un timer/cron que corra el ejecutor con
`--once` cada 1–3 minutos (el lockfile por agente evita solapamientos), igual
que los pollers de referencia.

## Límites de la v1

- Un ejecutor por máquina; lista de agentes por config; sin UI de administración.
- Una tarea por vez por agente; sin paralelismo ni prioridades.
- Sin auto-actualización. La ejecución depende de tu runtime y de tu cuota:
  si el runtime falla, la tarea se reporta `failed` por la vía gobernada y el
  ejecutor sigue con el ciclo, sin reintentos en bucle.
