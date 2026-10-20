/**
 * Fastify server — serves the PWA, exposes /api routes, runs the authenticated
 * control WebSocket for tool-call relay, and hosts the MCP SSE server.
 *
 * Route groups:
 *   GET  /healthz            — unauthenticated health check
 *   /api/*                   — Bearer-authenticated REST endpoints
 *   /ws/control              — authenticated control WebSocket (voice model relay)
 *   /ws         — authenticated WebSocket (llm_intelligence workflow)
 *   /ws/events               — authenticated multi-client desk socket (IDE extension, docs/34)
 *   /ws/audio-stream         — authenticated WebSocket: raw PCM piped to the voice agent (docs/41)
 *   GET|POST|DELETE /mcp     — MCP Streamable HTTP server (the agent CLI registers this)
 *
 * All /api/* and /mcp routes require a valid Bearer token (see auth.ts).
 * Security is enforced at the API level on every request and WS frame.
 */

import Fastify from 'fastify';
import type { FastifyInstance, FastifyServerFactoryHandler } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer as createHttpsServer } from 'node:https';
import type { Server as HttpServer } from 'node:http';
import { requireAuth, verifyWsToken, parseWsAuthMessage } from './auth.js';
import { getDb } from './state/db.js';
import { getAppVersionInfo } from './state/appVersion.js';
import {
  listProjects,
  resolveProject,
  setActiveProject,
  getSessionState,
} from './state/registry.js';
import { getConfig } from './config.js';
import { getRunModeInfo } from './runMode.js';
import { childLogger } from './log.js';
import { dispatchTool } from './mcp/handlers.js';
import { getNarrator, PhoneRelaySession } from './executor/narrator.js';
import { registerVoiceProviderRoutes } from './routes/voiceProviders.js';
import { registerWebSocket } from './intelligence/ws.js';
import { ensureVoskModel } from './serve/ensureVoskModel.js';
import { registerAudioStreamWebSocket } from './routes/audioStream.js';
import { registerSttWebSocket } from './routes/sttSocket.js';
import { registerChannelRoutes } from './channels/manager.js';
import { registerIntelligenceAudioRoutes } from './routes/intelligenceAudio.js';
import { registerAgentSessionRoutes } from './routes/agentSessions.js';
import { registerVoiceSessionPrepareRoutes } from './routes/voiceSessionPrepare.js';
import { registerConfigRoutes } from './routes/config.js';
import { registerAdminSettingsRoutes } from './routes/adminSettings.js';
import { registerServeRoutes } from './routes/serve.js';
import { registerProjectsAdminRoutes } from './routes/projectsAdmin.js';
import { registerProviderAuthRoutes } from './routes/providerAuth.js';
import { registerProviderModelRoutes } from './routes/providerModels.js';
import { registerProviderPermissionRoutes } from './routes/providerPermissions.js';
import { registerAskpassRoutes } from './routes/askpass.js';
import { registerHostingAdminRoutes } from './routes/hostingAdmin.js';
import { registerSpeechProviderRoutes } from './routes/speechProviders.js';
import { registerMcpServer } from './mcp/server/index.js';
import { attachDevWebProxy, registerProductionWeb } from './webDispatch.js';
import { registerControlSocket } from './state/controlSocket.js';
import { getPresence, type PresenceClient } from './state/presence.js';
import { setReconnectDigestSource } from './mcp/server/voiceToolHandlers.js';
import { publishAgentBusy } from './state/agentBusy.js';
import { notifyPhone } from './push/notifyPhone.js';
import { getPendingApprovals } from './mcp/server/approvalRegistry.js';
import { registerPushRoutes } from './routes/push.js';
import { registerApprovalRoutes } from './routes/approvals.js';
import { registerTurnRoutes } from './routes/turns.js';
import { registerMediaRoutes } from './routes/media.js';
import { registerToolRoutes } from './routes/tools.js';
import { registerWorkspaceRoutes } from './routes/workspace.js';
import { registerEventsSocket } from './routes/eventsSocket.js';
import { applyApprovalResponse } from './mcp/server/approvalResponses.js';
import { getDisplayRegistry, type PlaybackStateName } from './display/registry.js';
import { registerDisplayRoutes, DISPLAY_ROUTE_PREFIX } from './display/serve.js';
import { getActiveProvider } from './providers/agents/registry.js';

/** Required for vosk-browser SharedArrayBuffer (wake-word WASM). */
const CROSS_ORIGIN_ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
} as const;

const log = childLogger('server');

// ── Health check helpers ──────────────────────────────────────────────────
//
// An `about`/version probe can take several seconds — never block /healthz on
// it. Cache the version in the background; liveness must stay sub-second.
// The probe follows the ACTIVE provider, so /healthz reports the CLI that
// actually runs the work rather than always reporting Cursor's.

let cachedCliVersion: string | null = null;
let cachedCliClient: string | null = null;
let cachedCliFound: boolean | null = null;
let cliVersionRefreshInFlight: Promise<void> | null = null;

async function fetchActiveCliVersion(): Promise<{ client: string; version: string | null; found: boolean }> {
  const provider = getActiveProvider();
  const found = provider.isInstalled();
  try {
    const about = found && provider.getAbout ? await provider.getAbout() : null;
    return { client: provider.id, version: about?.cliVersion ?? null, found };
  } catch {
    return { client: provider.id, version: null, found };
  }
}

function refreshCliVersionCache(): void {
  if (cliVersionRefreshInFlight) return;
  cliVersionRefreshInFlight = (async () => {
    try {
      const { client, version, found } = await fetchActiveCliVersion();
      cachedCliClient = client;
      cachedCliVersion = version;
      cachedCliFound = found;
    } finally {
      cliVersionRefreshInFlight = null;
    }
  })();
}

// ── Server factory ────────────────────────────────────────────────────────

export async function buildServer(): Promise<FastifyInstance> {
  const { settings } = getConfig();
  const run = getRunModeInfo(settings);
  const tls = run.tls;

  const app = Fastify({
    logger: false,
    bodyLimit: 10 * 1024 * 1024,
    // Bring-your-own-cert HTTPS (src/tls.ts). Fastify's `https` option would
    // retype this instance as FastifyInstance<https.Server>, which no longer
    // matches the bare FastifyInstance every src/routes module takes;
    // serverFactory stays on the default-generic overload, so nothing else
    // in the codebase changes. https.Server is API-compatible with the
    // http.Server that Fastify listens on and closes.
    ...(tls
      ? {
          serverFactory: (handler: FastifyServerFactoryHandler) =>
            createHttpsServer({ cert: tls.cert, key: tls.key }, handler) as unknown as HttpServer,
        }
      : {}),
  });

  // Raw PCM uploads for Amazon Transcribe (PWA posts application/octet-stream).
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer' },
    (_req, body, done) => {
      done(null, body);
    },
  );

  app.addHook('onSend', async (req, reply, payload) => {
    // COOP/COEP are required for the PWA (Vosk WASM SharedArrayBuffer).
    // Do NOT send them on /mcp — the CLI's MCP client is not a browser and
    // some SSE clients reject responses with COEP/COOP set.
    if (!req.url.startsWith('/mcp')) {
      for (const [key, value] of Object.entries(CROSS_ORIGIN_ISOLATION_HEADERS)) {
        reply.header(key, value);
      }
    }
    return payload;
  });

  // Request log. API and MCP traffic at debug (it lands in the session .log
  // file, not the terminal); anything that failed at warn/error. Static asset
  // hits are skipped unless they fail. Query strings are dropped — image URLs
  // carry a signed `k` parameter.
  app.addHook('onResponse', async (req, reply) => {
    const path = req.url.split('?')[0] ?? req.url;
    const status = reply.statusCode;
    const isBackend =
      path.startsWith('/api/') || path.startsWith('/mcp') || path === '/ws' || path.startsWith('/ws/');
    if (!isBackend && status < 400) return;
    const entry = {
      method: req.method,
      path,
      status,
      ms: Math.round(reply.elapsedTime),
    };
    if (status >= 500) log.error(entry, 'request failed');
    else if (status >= 400 && status !== 401) log.warn(entry, 'request rejected');
    else log.debug(entry, 'request');
  });

  // Test mode: allow cross-origin API calls when the PWA is opened directly on the
  // Angular dev port (http://localhost:4200) instead of the unified port.
  if (run.useDevWebServer) {
    const devOrigins = new Set([
      run.webUrl,
      `http://127.0.0.1:${run.webPort}`,
      `http://localhost:${run.webPort}`,
    ]);

    app.addHook('onRequest', async (req, reply) => {
      const origin = req.headers.origin;
      if (origin && devOrigins.has(origin)) {
        reply.header('Access-Control-Allow-Origin', origin);
        reply.header('Vary', 'Origin');
        reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
        reply.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      }
      if (req.method === 'OPTIONS') {
        await reply.code(204).send();
      }
    });
  }

  await app.register(fastifyWebsocket);

  const webDistPath = resolve('web/dist');
  const isDevelopment = process.env.NODE_ENV === 'development';

  // ── Unauthenticated routes ─────────────────────────────────────────────

  app.get('/healthz', async (_req, _reply) => {
    const db = getDb();
    const projects = listProjects();
    refreshCliVersionCache();
    const cliVersion = cachedCliVersion;
    const { settings } = getConfig();
    const run = getRunModeInfo(settings);
    const { appVersion, gitCommit } = getAppVersionInfo();
    return {
      status: db.open ? 'ok' : 'degraded',
      db: db.open ? 'ok' : 'error',
      projects: projects.length,
      cliVersion,
      /** null until the first background probe finishes. */
      cliFound: cachedCliFound,
      agentClient: cachedCliClient ?? settings.agentClient,
      appVersion,
      gitCommit,
      runMode: run.runMode,
      backendUrl: run.backendUrl,
      webUrl: run.webUrl,
      publicBaseUrl: run.publicBaseUrl ?? null,
      useDevWebServer: run.useDevWebServer,
      ts: new Date().toISOString(),
    };
  });

  // ── Auth gate for all /api/* ───────────────────────────────────────────

  app.addHook('preHandler', async (req, reply) => {
    if (req.method === 'OPTIONS') return;
    if (req.url.startsWith('/api/')) {
      // Per-item key auth — <img> / <video> cannot send Bearer tokens.
      if (req.url.startsWith(DISPLAY_ROUTE_PREFIX)) return;
      await requireAuth(req, reply);
    }
  });

  // ── Agent-shown media (show_media, docs/48) ────────────────────────────

  /** GET /api/display/:id?k= — images, video, audio; ranges and live files. */
  registerDisplayRoutes(app);
  const display = getDisplayRegistry();
  display.setEmitter((frame) => void notifyPhone(frame));
  // `self_destruct: "never"` means "as long as the session lives": a hang-up,
  // or the grace window running out, ends it.
  getPresence().onChange((snap) => {
    if (snap.state === 'away' || snap.state === 'hung_up') display.clear('session_ended');
  });

  // ── Project endpoints ──────────────────────────────────────────────────

  /** GET /api/projects — names + descriptions, never paths. */
  app.get('/api/projects', async () => {
    const projects = listProjects();
    return {
      projects: projects.map((p) => ({
        name: p.name,
        description: p.description,
        aliases: p.aliases,
        enabled: p.enabled,
      })),
    };
  });

  /** GET /api/active-project */
  app.get('/api/active-project', async () => {
    const session = getSessionState('default');
    return {
      activeProject: session.activeProject,
      activeModel: session.activeModel,
      activeEffort: session.activeEffort,
      activeFast: session.activeFast,
    };
  });

  /** POST /api/active-project { project: string } */
  app.post<{ Body: { project: string } }>(
    '/api/active-project',
    {
      schema: {
        body: {
          type: 'object',
          required: ['project'],
          properties: { project: { type: 'string' } },
        },
      },
    },
    async (req, reply) => {
      const resolved = resolveProject(req.body.project);
      if (!resolved) {
        return reply
          .code(404)
          .send({ error: `Project "${req.body.project}" not found in registry` });
      }
      setActiveProject('default', resolved.name);
      return { activeProject: resolved.name, description: resolved.description };
    },
  );

  // ── Intelligence + MCP WebSockets ──────────────────────────────────────

  registerWebSocket(app);
  registerAudioStreamWebSocket(app);
  registerSttWebSocket(app);
  registerChannelRoutes(app);
  await registerVoiceProviderRoutes(app);
  await registerConfigRoutes(app);
  await registerIntelligenceAudioRoutes(app);
  await registerAgentSessionRoutes(app);
  await registerVoiceSessionPrepareRoutes(app);
  await registerAdminSettingsRoutes(app);
  await registerServeRoutes(app);
  await registerProjectsAdminRoutes(app);
  await registerProviderAuthRoutes(app);
  await registerProviderModelRoutes(app);
  await registerProviderPermissionRoutes(app);
  await registerAskpassRoutes(app);
  await registerHostingAdminRoutes(app);
  await registerSpeechProviderRoutes(app);
  registerPushRoutes(app);
  await registerApprovalRoutes(app);
  await registerTurnRoutes(app);
  await registerMediaRoutes(app);
  await registerToolRoutes(app);
  registerWorkspaceRoutes(app);
  // Desk clients (VS Code / Cursor extension) — multi-client, never displaces the phone.
  registerEventsSocket(app);

  /** GET /api/settings — non-secret operational settings. */
  app.get('/api/settings', async () => {
    const { settings: s } = getConfig();
    const run = getRunModeInfo(s);
    return {
      runMode: run.runMode,
      backendUrl: run.backendUrl,
      webUrl: run.webUrl,
      publicBaseUrl: run.publicBaseUrl ?? null,
      useDevWebServer: run.useDevWebServer,
      wakeWords: s.voice.wakeWords,
      turnSubmit: s.voice.turnSubmit,
      defaultMode: s.defaultMode,
      maxConcurrentJobs: s.maxConcurrentJobs,
      /**
       * docs/39: `planFirst` and `narratorCadenceMs` are gone — nothing read
       * either of them, and both had a control on the config screen.
       */
      narration: {
        enabled: s.narration.enabled,
        events: s.narration.events,
        speakRawDetail: s.narration.speakRawDetail,
      },
      /** docs/36 — the PWA needs the policy to label its away toggle. */
      session: {
        graceMs: s.session.graceMs,
        onPhoneAway: s.session.onPhoneAway,
        onBridgeRestart: s.session.onBridgeRestart,
      },
      /** docs/40 §1 — how much of a question / plan card the phone reads out. */
      readPrompts: s.voice.tts.readPrompts,
      workflow: {
        default: s.workflow.default,
        llmIntelligence: {
          model: s.workflow.llmIntelligence.llm.model,
          region: s.workflow.llmIntelligence.llm.region,
          audio: {
            sttProvider: s.workflow.llmIntelligence.audio.stt.provider,
            ttsProvider: s.workflow.llmIntelligence.audio.tts.provider,
            language: s.workflow.llmIntelligence.audio.stt.language,
          },
        },
      },
    };
  });

  // ── Control WebSocket ──────────────────────────────────────────────────
  //
  // Full protocol (all frames are JSON):
  //
  // Phone → Bridge:
  //   { type: "auth", token: "<app-token>" }           First frame — auth
  //   { type: "tool_call", call_id, name, arguments }  Voice provider tool call
  //   { type: "speaking", value: bool }                TTS state update for narrator
  //   { type: "media_state", media_id, state, open, position_s?, duration_s? }  docs/48
  //
  // Bridge → Phone:
  //   { type: "auth_ok" }
  //   { type: "tool_result", call_id, result }
  //   { type: "tool_error",  call_id, error }
  //   { type: "narration",   text, kind? }             Narrator injection

  app.register(async (wsApp) => {
    wsApp.get('/ws/control', { websocket: true }, (socket, _req) => {
      let authenticated = false;
      // Voice tools share session state on the `default` key (same as /api/active-project).
      const sessionKey = 'default';
      let relaySession: PhoneRelaySession | null = null;
      let presence: PresenceClient | null = null;

      log.debug({ sessionKey }, 'ws connection attempt');

      socket.on('message', (rawMsg: Buffer | string) => {
        const str = typeof rawMsg === 'string' ? rawMsg : rawMsg.toString('utf-8');

        // ── First frame: authenticate ──────────────────────────────────
        if (!authenticated) {
          const token = parseWsAuthMessage(str);
          if (!verifyWsToken(token)) {
            log.warn({ sessionKey }, 'ws auth failed — closing');
            socket.close(4001, 'Unauthorized');
            return;
          }
          authenticated = true;

          // Wire narrator to this connection.
          relaySession = new PhoneRelaySession((data) => {
            if (socket.readyState === socket.OPEN) {
              socket.send(data);
            }
          });
          void getNarrator().setSession(relaySession);

          // Register socket broadcaster for approval push events.
          registerControlSocket((data) => {
            if (socket.readyState === socket.OPEN) socket.send(data);
          });

          // Presence starts at auth, not at connect: an unauthenticated socket
          // is not a listener (docs/36 §1).
          presence = getPresence().register({
            kind: 'phone_control',
            ping: () => {
              if (socket.readyState === socket.OPEN) {
                socket.send(JSON.stringify({ type: 'ping' }));
              }
            },
            close: (code, reason) => {
              try {
                socket.close(code, reason);
              } catch {
                socket.terminate?.();
              }
            },
          });

          socket.send(JSON.stringify({ type: 'auth_ok', sessionKey }));

          /**
           * Everything the phone missed while it was gone (docs/36 §3.5,
           * docs/40 §3): what is running, and any approval card still open.
           * Both are re-sent rather than assumed, because the client's copy
           * died with its last socket.
           */
          publishAgentBusy(true);
          for (const request of getPendingApprovals()) {
            void notifyPhone({ type: `${request.kind}_request`, ...request });
          }
          // Media still shown (docs/48) — the phone's copy may be stale.
          socket.send(JSON.stringify(getDisplayRegistry().syncFrame()));

          log.info({ sessionKey }, 'ws authenticated');
          return;
        }

        // Any authenticated frame proves the socket is alive, so the pong is
        // only a fallback for an otherwise idle connection.
        presence?.alive();

        // ── Subsequent frames: tool calls + state updates ──────────────
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(str) as Record<string, unknown>;
        } catch {
          socket.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
          return;
        }

        if (msg['type'] === 'pong') return;

        // The PWA says goodbye before closing, so hanging up applies the away
        // policy immediately instead of waiting out the grace window.
        if (msg['type'] === 'hangup') {
          presence?.hangUp();
          presence = null;
          return;
        }

        // TTS state update — the narrator defers a spoken line while TTS runs.
        if (msg['type'] === 'speaking' && typeof msg['value'] === 'boolean') {
          relaySession?.setSpeaking(msg['value']);
          return;
        }

        // PWA → bridge: playback of an item from show_media (docs/48).
        if (msg['type'] === 'media_state' && typeof msg['media_id'] === 'string') {
          const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
          const states: PlaybackStateName[] = ['shown', 'loading', 'playing', 'paused', 'ended', 'closed', 'error'];
          const state = states.find((st) => st === msg['state']);
          if (state) {
            getDisplayRegistry().reportPlayback(msg['media_id'], {
              state,
              open: msg['open'] === true,
              position_s: num(msg['position_s']),
              duration_s: num(msg['duration_s']),
              muted: typeof msg['muted'] === 'boolean' ? msg['muted'] : null,
              ...(typeof msg['message'] === 'string' ? { message: msg['message'].slice(0, 300) } : {}),
            });
          }
          return;
        }

        // PWA → bridge: user answered an agent question / plan / permission / password.
        // Shared with /ws/events and POST /api/approvals — first answer wins.
        if (msg['type'] === 'approval_response') {
          const request_id = typeof msg['request_id'] === 'string' ? msg['request_id'] : null;
          const resolved = request_id ? applyApprovalResponse(request_id, msg['response'], 'phone').ok : false;
          socket.send(JSON.stringify({ type: 'approval_ack', request_id, ok: resolved }));
          return;
        }

        // Tool call relay
        if (msg['type'] === 'tool_call') {
          const callId = typeof msg['call_id'] === 'string' ? msg['call_id'] : randomUUID();
          const toolName = typeof msg['name'] === 'string' ? msg['name'] : '';
          const toolArgs = typeof msg['arguments'] === 'object' ? msg['arguments'] : {};

          log.debug({ sessionKey, tool: toolName, callId }, 'tool call received');

          void dispatchTool(toolName, toolArgs, sessionKey)
            .then((result) => {
              socket.send(
                JSON.stringify({ type: 'tool_result', call_id: callId, result }),
              );
            })
            .catch((err: Error) => {
              socket.send(
                JSON.stringify({
                  type: 'tool_error',
                  call_id: callId,
                  error: err.message,
                }),
              );
            });
          return;
        }

        log.debug({ msg }, 'unhandled ws message type');
      });

      socket.on('close', () => {
        log.info({ sessionKey }, 'ws closed');
        presence?.release();
        presence = null;
        // Detach narrator — events will buffer until next connection.
        if (relaySession) {
          void getNarrator().setSession(null);
          relaySession = null;
        }
        // Deregister control socket broadcaster.
        registerControlSocket(null);
      });

      socket.on('error', (err: Error) => {
        log.error({ err, sessionKey }, 'ws error');
      });
    });
  });

  /**
   * The catch-up digest the agent receives with the first turn after the user
   * comes back (docs/36 §3.5). Injected rather than imported so the voice tool
   * handlers keep no dependency on the executor.
   */
  setReconnectDigestSource(() => {
    const narrator = getNarrator();
    const digest = narrator.buildDigest();
    if (digest) narrator.clearBuffer();
    return digest;
  });

  registerMcpServer(app);

  // ── Web dispatch (after /api/* and /ws/* routes) ───────────────────────
  //
  // Development: proxy everything else to the Angular dev server (HMR).
  // Production: serve web/dist with SPA index.html fallback.
  if (isDevelopment) {
    await attachDevWebProxy(app, run.webPort);
  } else {
    await registerProductionWeb(app, webDistPath);
  }

  app.setErrorHandler((err, req, reply) => {
    log.error({ err, url: req.url }, 'unhandled route error');
    reply.code(500).send({ error: 'Internal server error' });
  });

  log.info(
    {
      webDispatch: isDevelopment ? 'dev-proxy' : 'static',
      webDistPath: isDevelopment ? null : webDistPath,
    },
    'web dispatch configured',
  );

  refreshCliVersionCache();

  return app;
}

/** Start listening. Serve mode binds to 0.0.0.0 so Tailscale peers can reach the bridge directly. */
export async function startServer(app: FastifyInstance): Promise<string> {
  const { settings } = getConfig();
  const run = getRunModeInfo(settings);
  const host = run.runMode === 'serve' ? '0.0.0.0' : '127.0.0.1';
  const listenAddress = await app.listen({ port: run.backendPort, host });

  // Prepare the wake-word model on launch so it is ready (or visibly preparing)
  // before any client needs it — the bridge owns it, not each client.
  void ensureVoskModel().catch(() => {
    /* preparation errors are logged and surfaced to clients via vosk_status */
  });
  // Fastify derives that string's scheme from its `https` option, which
  // serverFactory-based TLS never sets (fastify/lib/server.js), so it would
  // claim http:// for a genuine HTTPS listener. Correct it from run.tls.
  const address = run.tls ? listenAddress.replace(/^http:\/\//, 'https://') : listenAddress;
  log.info(
    {
      address,
      tls: run.tls ? { cert: run.tls.certPath, key: run.tls.keyPath } : null,
      runMode: run.runMode,
      webUrl: run.webUrl,
      angularDev: run.useDevWebServer ? `http://127.0.0.1:${run.webPort} (internal)` : null,
      useDevWebServer: run.useDevWebServer,
    },
    run.useDevWebServer
      ? `bridge listening on :${run.backendPort} — open ${run.webUrl} (PWA; proxies /api + /ws to bridge)`
      : 'bridge listening',
  );
  return address;
}
