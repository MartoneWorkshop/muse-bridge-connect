# Registrar INAGATE en GitHub Copilot CLI

Un comando:

```bash
copilot mcp add --transport http --header "Authorization: Bearer <EL-TOKEN-DE-TU-AGENTE>" inagate https://bridge.martoneworkshop.com/mcp
```

Equivalente, editando `~/.copilot/mcp-config.json`:

```json
{
  "mcpServers": {
    "inagate": {
      "type": "http",
      "url": "https://bridge.martoneworkshop.com/mcp",
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
`inagate` con sus herramientas `bridge_*` (16 en el catálogo completo; el servidor filtra el catálogo según tus permisos).
