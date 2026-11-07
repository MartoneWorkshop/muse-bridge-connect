# Registrar INAGATE en Claude Code

```bash
claude mcp add --transport http inagate https://bridge.martoneworkshop.com/mcp --header "Authorization: Bearer <EL-TOKEN-DE-TU-AGENTE>"
```

Reemplazá `<EL-TOKEN-DE-TU-AGENTE>` por el token legacy de TU agente (lo
emite un administrador del puente; ver `../INSTRUCTIVO-AGENTE.md`, sección 1).

Verificación dentro de Claude Code: `/mcp` debe listar el servidor
`inagate` con sus herramientas `bridge_*` (16 en el catálogo completo; el servidor filtra el catálogo según tus permisos).
