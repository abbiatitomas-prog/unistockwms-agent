# unistockwms-agent

Agente local que cierra el gap entre Railway (cloud) y las **Zebra ZD421** de la LAN del depo.

## ¿Cómo funciona?

```
Web/Zebra → Railway back → encola PrintJob ───┐
                                              │
                                              ▼
PC en el depo (este agente) ── poll cada 5s ─→ recibe N jobs
                                              │
                                              ▼
                                      ┌── Abre socket TCP a 192.168.x:9100
                                      └── Manda ZPL puro
                                              │
                                              ▼
                                        reporta done/fail
```

Cada `PrintJob` que se encole con una impresora configurada en modo `agent_socket`
queda en estado `PENDING` hasta que este agente lo agarra.

## Setup (5 minutos)

### 1. Crear API key del agente

En la web: **Admin → Impresoras y puestos → Agentes locales** (o `/admin/print-agents`)
- Clickeás "Nuevo agente"
- Anotás la key (`una_xxx...`) — solo se muestra UNA VEZ.

### 2. Configurar impresoras

En `/admin/printers` editá cada Zebra:
- `mode` = `agent_socket`
- `address` = IP de la Zebra en la LAN (ej. `192.168.1.50`)
- `active` = true

### 3. Instalar el agente

En una PC del depo que tenga IP en la misma LAN que las Zebras:

```bash
# Clonar este repo o copiar la carpeta
git clone <repo>
cd unistockwms-agent

# Instalar dependencias
npm install

# Configurar .env
cp .env.example .env
# Editar .env y poner el AGENT_KEY que generaste en el paso 1

# Build
npm run build

# Correr
npm start
```

Output esperado:
```
{"ts":"2026-05-15T...","level":"info","event":"agent_started","version":"0.1.0",...}
{"ts":"...","level":"info","event":"jobs_received","count":2}
{"ts":"...","level":"info","event":"job_printed","jobId":"...","printer":"Zebra Packing 1","bytes":1234}
```

### 4. Correr como servicio (recomendado para producción)

**Windows** (con [nssm](https://nssm.cc/)):
```cmd
nssm install UnistockWmsAgent "C:\Program Files\nodejs\node.exe" "C:\unistockwms-agent\dist\index.js"
nssm set UnistockWmsAgent AppDirectory "C:\unistockwms-agent"
nssm set UnistockWmsAgent AppEnvironmentExtra ":NODE_ENV=production"
nssm start UnistockWmsAgent
```

**Linux** (systemd):
```ini
# /etc/systemd/system/unistockwms-agent.service
[Unit]
Description=Unistock WMS Print Agent
After=network.target

[Service]
Type=simple
User=unistock
WorkingDirectory=/opt/unistockwms-agent
ExecStart=/usr/bin/node /opt/unistockwms-agent/dist/index.js
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now unistockwms-agent
sudo journalctl -u unistockwms-agent -f
```

## Troubleshooting

| Síntoma | Causa probable | Fix |
|---|---|---|
| `poll_failed` status 401 | AGENT_KEY inválida o revocada | Regenerar en /admin/print-agents |
| `job_print_failed` con `socket timeout` | La Zebra no responde en `address:9100` | Pingear la IP, verificar que esté prendida |
| `job_print_failed` con `ECONNREFUSED` | Wrong IP o puerto no es 9100 | Verificar config en /admin/printers |
| Agente "🔴 caído" en la web | El agente no está corriendo o sin red | Mirar logs del servicio |
| Jobs siempre PENDING | La impresora NO está en mode `agent_socket` | Editar en /admin/printers |

## Variables de entorno

| Variable | Default | Descripción |
|---|---|---|
| `BACKEND_URL` | (requerido) | URL del back Railway sin trailing slash |
| `AGENT_KEY` | (requerido) | Plain key generada en /admin/print-agents |
| `POLL_INTERVAL_MS` | 5000 | Frecuencia de poll en ms |
| `POLL_LIMIT` | 5 | Jobs máximo a procesar por poll |
| `ZPL_PORT` | 9100 | Puerto TCP de las Zebras (estándar) |
| `SOCKET_TIMEOUT_MS` | 10000 | Timeout del socket TCP por job |
| `LOG_LEVEL` | info | `info` o `debug` |

## Logs

Salen como JSON estructurado por stdout. Si querés grep-ear:

```bash
npm start 2>&1 | grep '"event":"job_printed"'
```

## Seguridad

- La key se hashea (bcrypt) en el back. El plain solo aparece UNA VEZ al crear.
- El agente solo puede pollear/reportar jobs de su org. No tiene acceso al resto del API.
- Para revocar un agente comprometido: `/admin/print-agents` → botón revocar (deja inactivo).
- Recomendado: una key distinta por depo / por PC para auditoría.
