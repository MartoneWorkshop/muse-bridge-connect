# Registrar muse-bridge en GitHub Copilot CLI

Un comando:

```bash
copilot mcp add --transport http --header "Authorization: Bearer <EL-TOKEN-DE-TU-AGENTE>" muse-bridge https://salem.martoneworkshop.com/bridge/mcp
```

Equivalente, editando `~/.copilot/mcp-config.json`:

```json
{
  "mcpServers": {
    "muse-bridge": {
      "type": "http",
      "url": "https://salem.martoneworkshop.com/bridge/mcp",
      "headers": { "Authorization": "Bearer <EL-TOKEN-DE-TU-AGENTE>" },
      "tools": ["*"]
    }
  }
}
```

Reemplazá `<EL-TOKEN-DE-TU-AGENTE>` por el token legacy de TU agente (lo
emite un administrador del puente; ver `../INSTRUCTIVO-AGENTE.md`,
sección 1).

Verificación: dentro de Copilot CLI, `/mcp` debe listar el servidor
`muse-bridge` con sus 10 herramientas `bridge_*`.
