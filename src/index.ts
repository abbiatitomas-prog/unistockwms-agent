#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// unistockwms-agent — agente local de impresión Zebra
// ═══════════════════════════════════════════════════════════════
//
// Corre en una PC del depo. Cada N segundos pollea a Railway:
//   1. POST /print-agent/poll → recibe N jobs PENDING con ZPL renderizado +
//      IP target.
//   2. Por cada job: abre socket TCP a printer.address:9100 y manda el ZPL.
//   3. POST /print-agent/jobs/:id/done  (o /fail con error).
//
// Cómo configurarlo:
//   1. Crear agente en /admin/print-agents (devuelve un plain key UNA VEZ).
//   2. Guardarlo en .env junto a la URL del back.
//   3. Crear impresoras en /admin/printers con:
//        - mode = 'agent_socket'
//        - address = IP de la Zebra en la LAN (ej. 192.168.1.50)
//   4. npm install && npm run build && npm start
//
// Variables de entorno (.env):
//   BACKEND_URL=https://api.unistockwms.com          (sin trailing slash)
//   AGENT_KEY=una_xxxxxxxxxx                          (de /admin/print-agents)
//   POLL_INTERVAL_MS=5000                            (default 5s)
//   POLL_LIMIT=5                                     (jobs por poll)
//   ZPL_PORT=9100                                    (default 9100)
//   SOCKET_TIMEOUT_MS=10000                          (default 10s)
//   LOG_LEVEL=info | debug                           (default info)
// ═══════════════════════════════════════════════════════════════

import axios, { AxiosError } from 'axios';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';

const AGENT_VERSION = '0.1.0';

interface Config {
  backendUrl: string;
  agentKey: string;
  pollIntervalMs: number;
  pollLimit: number;
  zplPort: number;
  socketTimeoutMs: number;
  logLevel: 'info' | 'debug';
}

interface PollResponse {
  jobs: Array<{
    id: string;
    printerId: string;
    printerName: string;
    printerAddress: string | null;
    zpl: string;
  }>;
}

function loadEnv(): void {
  // Cargar .env si existe — sin dependencia externa, parser simple
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = value;
  }
}

function loadConfig(): Config {
  const backendUrl = process.env.BACKEND_URL?.replace(/\/$/, '') ?? '';
  const agentKey = process.env.AGENT_KEY ?? '';
  if (!backendUrl || !agentKey) {
    console.error('FATAL: BACKEND_URL y AGENT_KEY son requeridos en .env');
    process.exit(1);
  }
  return {
    backendUrl,
    agentKey,
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS ?? '5000', 10),
    pollLimit: parseInt(process.env.POLL_LIMIT ?? '5', 10),
    zplPort: parseInt(process.env.ZPL_PORT ?? '9100', 10),
    socketTimeoutMs: parseInt(process.env.SOCKET_TIMEOUT_MS ?? '10000', 10),
    logLevel: (process.env.LOG_LEVEL as 'info' | 'debug') ?? 'info',
  };
}

function log(level: 'info' | 'debug' | 'warn' | 'error', event: string, payload?: Record<string, unknown>) {
  const cfg = (global as any).__cfg as Config | undefined;
  if (level === 'debug' && cfg?.logLevel !== 'debug') return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...payload,
  });
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

/**
 * Manda ZPL a la Zebra por socket TCP. Resuelve con ok=true si
 * efectivamente se enviaron bytes (la Zebra no devuelve ACK con ZPL puro).
 */
function sendZpl(address: string, port: number, zpl: string, timeoutMs: number): Promise<{ ok: boolean; bytesSent: number; error?: string }> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let resolved = false;
    let bytesSent = 0;

    const finish = (result: { ok: boolean; bytesSent: number; error?: string }) => {
      if (resolved) return;
      resolved = true;
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.on('timeout', () => finish({ ok: false, bytesSent, error: 'socket timeout' }));
    socket.on('error', (err) => finish({ ok: false, bytesSent, error: err.message }));

    socket.connect(port, address, () => {
      socket.write(zpl, 'utf8', (err) => {
        if (err) {
          finish({ ok: false, bytesSent, error: err.message });
          return;
        }
        bytesSent = Buffer.byteLength(zpl, 'utf8');
        // Pequeño delay para que la Zebra reciba antes de cerrar el socket.
        setTimeout(() => finish({ ok: true, bytesSent }), 100);
      });
    });
  });
}

async function pollOnce(cfg: Config): Promise<void> {
  let resp;
  try {
    resp = await axios.post<PollResponse>(
      `${cfg.backendUrl}/print-agent/poll`,
      { limit: cfg.pollLimit, version: AGENT_VERSION },
      {
        headers: { 'X-Agent-Key': cfg.agentKey },
        timeout: 15_000,
      },
    );
  } catch (e) {
    const err = e as AxiosError;
    log('error', 'poll_failed', {
      status: err.response?.status,
      data: (err.response?.data as any)?.message ?? err.message,
    });
    return;
  }

  const jobs = resp.data.jobs ?? [];
  if (jobs.length === 0) {
    log('debug', 'poll_empty');
    return;
  }
  log('info', 'jobs_received', { count: jobs.length });

  for (const job of jobs) {
    if (!job.printerAddress) {
      await reportFail(cfg, job.id, 'printer sin address configurada');
      continue;
    }
    const result = await sendZpl(job.printerAddress, cfg.zplPort, job.zpl, cfg.socketTimeoutMs);
    if (result.ok) {
      log('info', 'job_printed', { jobId: job.id, printer: job.printerName, bytes: result.bytesSent });
      await reportDone(cfg, job.id);
    } else {
      log('warn', 'job_print_failed', { jobId: job.id, printer: job.printerName, error: result.error });
      await reportFail(cfg, job.id, result.error ?? 'unknown print error');
    }
  }
}

async function reportDone(cfg: Config, jobId: string) {
  try {
    await axios.post(`${cfg.backendUrl}/print-agent/jobs/${jobId}/done`, {}, {
      headers: { 'X-Agent-Key': cfg.agentKey },
      timeout: 10_000,
    });
  } catch (e) {
    const err = e as AxiosError;
    log('error', 'report_done_failed', { jobId, status: err.response?.status });
  }
}

async function reportFail(cfg: Config, jobId: string, error: string) {
  try {
    await axios.post(
      `${cfg.backendUrl}/print-agent/jobs/${jobId}/fail`,
      { error: error.slice(0, 500) },
      { headers: { 'X-Agent-Key': cfg.agentKey }, timeout: 10_000 },
    );
  } catch (e) {
    const err = e as AxiosError;
    log('error', 'report_fail_failed', { jobId, status: err.response?.status });
  }
}

async function main() {
  loadEnv();
  const cfg = loadConfig();
  (global as any).__cfg = cfg;
  log('info', 'agent_started', {
    version: AGENT_VERSION,
    backendUrl: cfg.backendUrl,
    pollIntervalMs: cfg.pollIntervalMs,
    pollLimit: cfg.pollLimit,
  });

  // Loop principal — no setInterval para no superponer si un poll tarda más
  // que el intervalo.
  let running = true;
  process.on('SIGINT', () => {
    log('info', 'agent_stopping');
    running = false;
    setTimeout(() => process.exit(0), 1000);
  });

  while (running) {
    await pollOnce(cfg);
    await new Promise((r) => setTimeout(r, cfg.pollIntervalMs));
  }
}

main().catch((e) => {
  log('error', 'agent_crashed', { error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
