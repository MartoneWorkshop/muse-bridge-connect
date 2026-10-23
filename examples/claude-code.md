# Registrar muse-bridge en Claude Code

```bash
claude mcp add --transport http muse-bridge https://salem.martoneworkshop.com/bridge/mcp --header "Authorization: Bearer <EL-TOKEN-DE-TU-AGENTE>"
```

Reemplazá `<EL-TOKEN-DE-TU-AGENTE>` por el token legacy de TU agente (lo
emite un administrador del puente; ver `../INSTRUCTIVO-AGENTE.md`, sección 1).

Verificación dentro de Claude Code: `/mcp` debe listar el servidor
`muse-bridge` con sus 10 herramientas `bridge_*`.
