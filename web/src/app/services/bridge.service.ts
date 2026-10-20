import { Injectable, signal } from '@angular/core';
import { Subject } from 'rxjs';
import { approvalFromPush, type ApprovalRequest, type ApprovalResponse } from '@squeakr/client';
export type WsStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export type WorkflowId = 'agent_native' | 'llm_intelligence';

export interface AppSettings {
  workflow: {
    default: WorkflowId;
    llmIntelligence: {
      model: string;
      region: string;
    };
  };
  wakeWords?: { start: string; end: string };
  turnSubmit?: { silenceMs: number; vadEnabled?: boolean };
}

export interface Project {
  name: string;
  description: string | null;
  aliases: string[];
  enabled: boolean;
}

/** Sentinel value for "start a fresh cursor-agent thread on voice start". */
export const NEW_CURSOR_SESSION_ID = '__new__';

export interface CursorSessionEntry {
  session_id: string;
  last_prompt: string;
  last_status: string;
  last_run_at: string;
  job_count: number;
}

export interface CursorSessionsResponse {
  project: string;
  active_session_id: string | null;
  sessions: CursorSessionEntry[];
}

export interface CursorSessionLogEntry {
  at: string;
  level: 'info' | 'warn' | 'error';
  summary: string;
  detail?: string;
}

export interface CursorSessionLogsResponse {
  project: string;
  session_id: string;
  entries: CursorSessionLogEntry[];
}

export interface VoiceSessionLogEvent {
  phase: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  at: string;
}

export interface VoiceSessionPrepareResult {
  ok: boolean;
  project: string;
  scope?: 'global';
  message: string;
  mcpPath?: string;
  userRoot?: string;
  hostOs?: string;
  action?: string;
  version?: string;
}

export interface NarrationEvent {
  text: string;
  kind?: string;
  /**
   * Whether this line should be played aloud. The bridge decides per event
   * (docs/39 Part B); the event itself always travels so push notifications
   * and the orb's state survive narration being switched off.
   *
   * Older bridges do not send it — undefined means "speak", which is what
   * they meant.
   */
  speak?: boolean;
  data?: Record<string, unknown>;
}

/**
 * One moment of a voice call on a channel (a Discord call, docs/44), mirrored
 * to the app as it happens: what was heard, what was said, every cue played.
 */
export type ChannelCallEvent = { call: string; source: string } & (
  | { event: 'started'; wake: boolean }
  | { event: 'ended' }
  | { event: 'heard'; speaker: string; text: string; state: 'request' | 'armed' | 'held' | 'cancel' | 'ignored' }
  | { event: 'reply'; text: string; own: boolean }
  | { event: 'cue'; cue: 'listening' | 'sent' | 'cancel' | 'error' }
  | { event: 'activity'; line: string }
  | { event: 'notice'; text: string }
);

// ── Approval push types ────────────────────────────────────────────────────
//
// Shared with the VS Code / Cursor extension through packages/client — one
// definition of what an approval card is, however many frontends render it.

export type {
  InputType,
  UserInputRequest,
  PlanApprovalRequest,
  PermissionRequest,
  SecretInputRequest,
  ApprovalRequest,
  UserInputResponse,
  PlanApprovalResponse,
  PermissionResponse,
  SecretInputResponse,
  ApprovalResponse,
} from '@squeakr/client';

// ── Agent-provider auth push types ────────────────────────────────────────

export type AuthFlowId = 'browser-url' | 'device-code' | 'token-paste' | 'api-key';

export interface AuthFlowDescriptor {
  id: AuthFlowId;
  label: string;
  description: string;
  pasteLabel?: string;
  pastePlaceholder?: string;
}

export interface AuthRequiredEvent {
  provider: string;
  displayName: string;
  flows: AuthFlowDescriptor[];
  context?: string;
}

// ── Hosting-provider setup push types ─────────────────────────────────────

export interface HostingSetupProgressPush {
  runId: string;
  provider: string;
  message: string;
  done?: boolean;
  error?: string;
  result?: { ok: boolean; publicUrl: string | null; detail: string };
}

export interface SpeechSetupProgressPush {
  runId: string;
  message: string;
  done?: boolean;
  error?: string;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

/**
 * Bridge service — owns the control WebSocket + HTTP API calls.
 *
 * Responsibilities:
 *   - Credential storage (localStorage)
 *   - WS lifecycle: connect, auth, auto-reconnect
 *   - HTTP: /api/projects, /api/active-project, /api/voice/providers
 *   - Tool-call relay: pendingToolCalls map resolved by WS tool_result frames
 *   - Speaking-state updates forwarded to narrator cadence gate
 *   - Narration events published via narration$ Observable (→ VoiceSessionService)
 */
@Injectable({ providedIn: 'root' })
export class BridgeService {
  // ── Signals ────────────────────────────────────────────────────────────

  readonly hasCredentials = signal<boolean>(false);
  readonly wsStatus = signal<WsStatus>('disconnected');
  /** Set when REST /api/* calls fail after WS auth (e.g. cross-origin without CORS). */
  readonly apiStatus = signal<'ok' | 'error'>('ok');
  readonly projects = signal<Project[]>([]);
  readonly activeProject = signal<string | null>(null);
  readonly settings = signal<AppSettings | null>(null);

  // ── Narration observable ───────────────────────────────────────────────

  /** Emits when the bridge pushes a narration event. AppComponent routes to voice session. */
  readonly narration$ = new Subject<NarrationEvent>();

  /** Emits for every moment of a channel voice call (Discord) — see ChannelCallEvent. */
  readonly channelCall$ = new Subject<ChannelCallEvent>();

  /** Emits when the bridge rejects the app token (WebSocket close 4001). */
  readonly authFailed$ = new Subject<void>();

  // ── Approval push observable ───────────────────────────────────────────

  /**
   * What the bridge says is running right now — a voice turn in progress, how
   * many workers, and how many approval cards are open. Source of truth for
   * the orb's working ring, re-sent on reconnect so it is correct after the
   * phone comes back (docs/40 §3).
   */
  readonly agentBusy = signal<{ voiceTurnActive: boolean; workers: number; pendingApprovals: number }>(
    { voiceTurnActive: false, workers: 0, pendingApprovals: 0 },
  );

  /** Emits when the bridge pushes a user_input_request or plan_approval_request. */
  readonly approvalRequest$ = new Subject<ApprovalRequest>();

  /** The currently pending approval request, if any (shown in ApprovalPanelComponent). */
  readonly pendingApproval = signal<ApprovalRequest | null>(null);

  /** Set when the active agent CLI needs the user to sign in (shown in AuthCardComponent). */
  readonly pendingAuthRequired = signal<AuthRequiredEvent | null>(null);

  /** Emits streamed progress for an in-flight hosting-provider setup run (Config → Network). */
  readonly hostingSetupProgress$ = new Subject<HostingSetupProgressPush>();
  /** Self-hosted speech server setup: image pull, container start, model install. */
  readonly speechSetupProgress$ = new Subject<SpeechSetupProgressPush>();

  // ── Agent-shown media (show_media, docs/48) ────────────────────────────

  /** media_show / media_remove / media_sync / media_control frames, for DisplayService. */
  readonly mediaFrames$ = new Subject<Record<string, unknown>>();

  // ── Private ────────────────────────────────────────────────────────────

  private _appToken = '';
  private _ws: WebSocket | null = null;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _autoReconnect = true;
  private _pendingCalls = new Map<string, PendingCall>();

  // ── Credential management ──────────────────────────────────────────────

  loadCredentials(): void {
    const token = localStorage.getItem('cv_token')?.trim();
    // Migrate: remove any stored base URL — app and API are on the same origin now.
    localStorage.removeItem('cv_bridge');
    if (token) {
      this._appToken = token;
      localStorage.setItem('cv_token', token);
      this.hasCredentials.set(true);
    }
  }

  saveCredentials(token: string): void {
    this._appToken = token.trim();
    if (!this._appToken) return;
    localStorage.setItem('cv_token', this._appToken);
    localStorage.removeItem('cv_bridge');
    this.hasCredentials.set(true);
  }

  clearCredentials(): void {
    localStorage.removeItem('cv_token');
    localStorage.removeItem('cv_bridge');
    this._appToken = '';
    this.hasCredentials.set(false);
    this.disconnect();
  }

  // ── Accessors ──────────────────────────────────────────────────────────

  get appToken(): string { return this._appToken; }
  /** Always the same origin — app and API are co-hosted. */
  get bridgeBase(): string { return window.location.origin; }

  // ── WebSocket ──────────────────────────────────────────────────────────

  connect(): void {
    if (this._ws?.readyState === WebSocket.OPEN) return;
    if (!this._appToken) {
      this.wsStatus.set('disconnected');
      this.hasCredentials.set(false);
      return;
    }

    this._autoReconnect = true;
    this.wsStatus.set('connecting');
    const wsUrl = window.location.origin.replace(/^http/, 'ws') + '/ws/control';
    this._ws = new WebSocket(wsUrl);

    this._ws.addEventListener('open', () => {
      this._ws!.send(JSON.stringify({ type: 'auth', token: this._appToken }));
    });

    this._ws.addEventListener('message', (ev: MessageEvent<string>) => {
      this._handleWsMessage(ev.data);
    });

    this._ws.addEventListener('close', (ev: CloseEvent) => {
      this._ws = null;

      if (ev.code === 4001) {
        this._autoReconnect = false;
        this._rejectAllPending('Invalid app token');
        this.authFailed$.next();
        this.clearCredentials();
        return;
      }

      if (this._autoReconnect) {
        this.wsStatus.set('error');
        this._rejectAllPending('Bridge WebSocket disconnected');
        this._reconnectTimer = setTimeout(() => this.connect(), 3000);
        return;
      }

      this.wsStatus.set('disconnected');
      this._rejectAllPending('Bridge disconnected');
    });

    this._ws.addEventListener('error', () => {
      this.wsStatus.set('error');
    });
  }

  /** Close the control WebSocket and stop auto-reconnect. Credentials are kept. */
  disconnect(): void {
    this._autoReconnect = false;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._ws) {
      /**
       * Say goodbye on purpose (docs/36 §1). A socket that just closes is
       * indistinguishable from a tunnel blip, so the bridge would hold the
       * grace window open for 45 s before applying the away policy. Hanging up
       * explicitly applies it straight away.
       */
      if (this._ws.readyState === WebSocket.OPEN) {
        try {
          this._ws.send(JSON.stringify({ type: 'hangup' }));
        } catch {
          // A socket that cannot take the frame is already gone.
        }
      }
      this._ws.close();
      this._ws = null;
    }
    this.wsStatus.set('disconnected');
    this.apiStatus.set('ok');
    this._rejectAllPending('Bridge disconnected');
    // Hanging up ends the session, and media shown in it goes with it.
    this.mediaFrames$.next({ type: 'media_sync', items: [] });
  }

  /** Tell the bridge how an agent-shown video / audio is playing (docs/48). */
  sendMediaState(state: Record<string, unknown>): void {
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify({ type: 'media_state', ...state }));
    }
  }

  // ── API calls ──────────────────────────────────────────────────────────

  async loadProjects(): Promise<void> {
    try {
      const data = await this.apiFetch<{ projects: Project[] }>('/api/projects');
      this.projects.set(data.projects);
      this.apiStatus.set('ok');

      // Restore last selected project and sync to bridge session state.
      const saved = localStorage.getItem('cv_active_project');
      const name =
        saved && data.projects.some((p) => p.name === saved)
          ? saved
          : data.projects[0]?.name;
      if (name) {
        await this.setActiveProject(name);
      }
    } catch {
      this.apiStatus.set('error');
    }
  }

  async setActiveProject(name: string): Promise<void> {
    await this.apiFetch('/api/active-project', {
      method: 'POST',
      body: JSON.stringify({ project: name }),
    });
    this.activeProject.set(name);
    localStorage.setItem('cv_active_project', name);
  }

  async loadCursorSessions(project: string): Promise<CursorSessionsResponse> {
    const q = new URLSearchParams({ project });
    return this.apiFetch<CursorSessionsResponse>(`/api/agent-sessions?${q}`);
  }

  async loadCursorSessionLogs(
    project: string,
    sessionId: string,
  ): Promise<CursorSessionLogsResponse> {
    const q = new URLSearchParams({ project, session_id: sessionId });
    return this.apiFetch<CursorSessionLogsResponse>(`/api/agent-sessions/logs?${q}`);
  }

  async selectCursorSession(project: string, sessionId: string): Promise<void> {
    await this.apiFetch('/api/agent-sessions/select', {
      method: 'POST',
      body: JSON.stringify({ project, session_id: sessionId }),
    });
    localStorage.setItem(this._sessionStorageKey(project), sessionId);
  }

  async createNewCursorSession(
    project: string,
  ): Promise<{ active_session_id: string | null; message: string }> {
    const result = await this.apiFetch<{
      active_session_id: string | null;
      message: string;
    }>('/api/agent-sessions/new', {
      method: 'POST',
      body: JSON.stringify({ project }),
    });
    if (result.active_session_id) {
      localStorage.setItem(this._sessionStorageKey(project), result.active_session_id);
    } else {
      localStorage.setItem(this._sessionStorageKey(project), NEW_CURSOR_SESSION_ID);
    }
    return result;
  }

  getStoredCursorSession(project: string): string | null {
    return localStorage.getItem(this._sessionStorageKey(project));
  }

  clearStoredCursorSession(project: string): void {
    localStorage.removeItem(this._sessionStorageKey(project));
  }

  storeCursorSessionPreference(project: string, sessionId: string): void {
    localStorage.setItem(this._sessionStorageKey(project), sessionId);
  }

  /**
   * Apply the user's session choice before voice / submit work begins.
   * "New session" creates a fresh thread; otherwise resume_id is set on the project.
   */
  async ensureAgentSessionReady(project: string): Promise<string | null> {
    const stored = this.getStoredCursorSession(project);
    if (!stored || stored === NEW_CURSOR_SESSION_ID) {
      const created = await this.createNewCursorSession(project);
      return created.active_session_id;
    }
    try {
      await this.selectCursorSession(project, stored);
      return stored;
    } catch {
      this.clearStoredCursorSession(project);
      const created = await this.createNewCursorSession(project);
      return created.active_session_id;
    }
  }

  /**
   * Stream live voice session prep logs (global MCP install / version check / enable).
   * Resolves when the backend sends the `complete` SSE event.
   */
  async prepareVoiceSession(
    project: string,
    onLog: (event: VoiceSessionLogEvent) => void,
    signal?: AbortSignal,
  ): Promise<VoiceSessionPrepareResult> {
    const res = await fetch(`/api/voice-session/prepare`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this._appToken}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({ project }),
      signal,
    });

    if (!res.ok) {
      let detail = `${res.status} ${res.statusText}`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body.error) detail = body.error;
      } catch {
        // ignore
      }
      throw new Error(detail);
    }

    if (!res.body) {
      throw new Error('Prepare stream missing response body');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let complete: VoiceSessionPrepareResult | null = null;

    const processBlock = (block: string): void => {
      const lines = block.split('\n');
      let eventName = 'message';
      let dataLine = '';
      for (const line of lines) {
        if (line.startsWith('event:')) eventName = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLine += line.slice(5).trim();
      }
      if (!dataLine) return;
      const payload = JSON.parse(dataLine) as Record<string, unknown>;
      if (eventName === 'session_log') {
        onLog(payload as unknown as VoiceSessionLogEvent);
      } else if (eventName === 'complete') {
        complete = {
          ok: Boolean(payload['ok']),
          project: String(payload['project'] ?? project),
          message: String(payload['message'] ?? ''),
          mcpPath: typeof payload['mcpPath'] === 'string' ? payload['mcpPath'] : undefined,
          action: typeof payload['action'] === 'string' ? payload['action'] : undefined,
          version: typeof payload['version'] === 'string' ? payload['version'] : undefined,
        };
      }
    };

    while (true) {
      if (signal?.aborted) {
        await reader.cancel().catch(() => {});
        throw new DOMException('Voice prepare aborted', 'AbortError');
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        if (part.trim()) processBlock(part);
      }
    }

    if (buffer.trim()) processBlock(buffer);

    if (!complete) {
      throw new Error('Prepare stream ended without completion');
    }
    const result: VoiceSessionPrepareResult = complete;
    if (!result.ok) {
      throw new Error(result.message || 'Voice session preparation failed');
    }
    return result;
  }

  private _sessionStorageKey(project: string): string {
    return `cv_cursor_session_${project}`;
  }

  async loadSettings(): Promise<void> {
    try {
      const data = await this.apiFetch<AppSettings>('/api/settings');
      this.settings.set(data);
      this.apiStatus.set('ok');
    } catch {
      this.apiStatus.set('error');
    }
  }

  // ── Tool-call relay ────────────────────────────────────────────────────

  /**
   * Forward a provider function call to the bridge over the control WS.
   * Returns the tool result or throws on error / disconnect.
   * Called by VoiceSessionService for each tool call the voice model emits.
   */
  relayToolCall(callId: string, name: string, args: unknown): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const ws = this._ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Bridge WebSocket not connected'));
        return;
      }
      this._pendingCalls.set(callId, { resolve, reject });
      ws.send(JSON.stringify({ type: 'tool_call', call_id: callId, name, arguments: args }));
    });
  }

  /** Notify the narrator of TTS activity so it respects cadence (Doherty). */
  sendSpeakingState(speaking: boolean): void {
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify({ type: 'speaking', value: speaking }));
    }
  }

  /**
   * Send the user's answer back to the bridge so the blocked MCP tool call can resolve.
   * Called by ApprovalPanelComponent when the user taps approve / answer.
   */
  sendApprovalResponse(request_id: string, response: ApprovalResponse): void {
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify({ type: 'approval_response', request_id, response }));
    }
    // Clear the pending signal immediately so the UI dismisses without waiting for ack.
    const current = this.pendingApproval();
    if (current?.request_id === request_id) {
      this.pendingApproval.set(null);
    }
  }

  // ── Private ────────────────────────────────────────────────────────────

  private _handleWsMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    switch (msg['type']) {
      /**
       * Server heartbeat (docs/36 §1). Answering it is what lets the bridge
       * tell a live connection from a half-open one — without the pong, a
       * phone that dropped off Wi-Fi looks connected until TCP gives up.
       */
      case 'ping':
        if (this._ws?.readyState === WebSocket.OPEN) {
          this._ws.send(JSON.stringify({ type: 'pong' }));
        }
        break;

      /**
       * The bridge's own account of what is running (docs/40 §3). The orb used
       * to guess this from narration, so it was wrong after a reconnect and
       * wrong whenever narration was off.
       */
      case 'agent_busy': {
        this.agentBusy.set({
          voiceTurnActive: msg['voice_turn_active'] === true,
          workers: typeof msg['workers'] === 'number' ? msg['workers'] : 0,
          pendingApprovals: typeof msg['pending_approvals'] === 'number' ? msg['pending_approvals'] : 0,
        });
        break;
      }

      case 'auth_ok':
        this.wsStatus.set('connected');
        this.apiStatus.set('ok');
        void this.loadProjects();
        void this.loadSettings();
        break;

      case 'narration': {
        const text = msg['text'] as string | undefined;
        const kind = msg['kind'] as string | undefined;
        if (typeof text === 'string' && text) {
          this.narration$.next({
            text,
            kind,
            speak: msg['speak'] !== false,
            data:
              typeof msg['data'] === 'object' && msg['data'] !== null
                ? (msg['data'] as Record<string, unknown>)
                : undefined,
          });
        }
        break;
      }

      case 'channel_call': {
        if (typeof msg['event'] === 'string' && typeof msg['call'] === 'string') {
          this.channelCall$.next(msg as unknown as ChannelCallEvent);
        }
        break;
      }

      case 'user_input_request':
      case 'plan_approval_request':
      case 'permission_request':
      case 'secret_input_request': {
        const req = approvalFromPush(msg);
        if (req) {
          this.approvalRequest$.next(req);
          this.pendingApproval.set(req);
        }
        break;
      }

      case 'auth_required': {
        const event: AuthRequiredEvent = {
          provider: String(msg['provider'] ?? ''),
          displayName: String(msg['displayName'] ?? 'Your agent'),
          flows: Array.isArray(msg['flows']) ? (msg['flows'] as AuthFlowDescriptor[]) : [],
          context: typeof msg['context'] === 'string' ? msg['context'] : undefined,
        };
        this.pendingAuthRequired.set(event);
        break;
      }

      case 'hosting_setup_progress': {
        this.hostingSetupProgress$.next({
          runId: String(msg['runId'] ?? ''),
          provider: String(msg['provider'] ?? ''),
          message: String(msg['message'] ?? ''),
          done: msg['done'] === true,
          error: typeof msg['error'] === 'string' ? msg['error'] : undefined,
          result:
            typeof msg['result'] === 'object' && msg['result'] !== null
              ? (msg['result'] as { ok: boolean; publicUrl: string | null; detail: string })
              : undefined,
        });
        break;
      }

      case 'speech_setup_progress': {
        this.speechSetupProgress$.next({
          runId: String(msg['runId'] ?? ''),
          message: String(msg['message'] ?? ''),
          done: msg['done'] === true,
          error: typeof msg['error'] === 'string' ? msg['error'] : undefined,
        });
        break;
      }

      case 'approval_cancelled': {
        const requestId = typeof msg['request_id'] === 'string' ? msg['request_id'] : null;
        const current = this.pendingApproval();
        if (!requestId || current?.request_id === requestId) {
          this.pendingApproval.set(null);
        }
        break;
      }

      case 'media_show':
      case 'media_remove':
      case 'media_sync':
      case 'media_control':
        this.mediaFrames$.next(msg);
        break;

      case 'tool_result': {
        const callId = msg['call_id'] as string | undefined;
        if (callId) {
          const pending = this._pendingCalls.get(callId);
          if (pending) {
            pending.resolve(msg['result']);
            this._pendingCalls.delete(callId);
          }
        }
        break;
      }

      case 'tool_error': {
        const callId = msg['call_id'] as string | undefined;
        const error  = (msg['error'] as string | undefined) ?? 'Tool error';
        if (callId) {
          const pending = this._pendingCalls.get(callId);
          if (pending) {
            pending.reject(new Error(error));
            this._pendingCalls.delete(callId);
          }
        }
        break;
      }

      default:
        break;
    }
  }

  private _rejectAllPending(reason: string): void {
    for (const { reject } of this._pendingCalls.values()) {
      reject(new Error(reason));
    }
    this._pendingCalls.clear();
  }

  /** Authenticated fetch to the bridge API. Uses relative paths — app and API share the same origin. */
  async apiFetch<T>(path: string, opts: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this._appToken}`,
      ...(opts.headers as Record<string, string> | undefined),
    };
    // Fastify rejects empty bodies when Content-Type is application/json
    // (FST_ERR_CTP_EMPTY_JSON_BODY). Only set it when we actually send JSON.
    if (opts.body !== undefined && opts.body !== null && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(path, {
      ...opts,
      headers,
    });
    if (!res.ok) {
      let detail = `${res.status} ${res.statusText}`;
      try {
        const body = (await res.json()) as { error?: string; message?: string };
        if (body.message) detail = body.message;
        else if (body.error) detail = body.error;
      } catch {
        // ignore non-JSON error bodies
      }
      throw new Error(detail);
    }
    return res.json() as Promise<T>;
  }

  apiGet<T>(path: string): Promise<T> {
    return this.apiFetch<T>(path);
  }

  apiPost<T>(path: string, body: unknown = {}): Promise<T> {
    return this.apiFetch<T>(path, { method: 'POST', body: JSON.stringify(body) });
  }

  apiPatch<T>(path: string, body: unknown): Promise<T> {
    return this.apiFetch<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
  }

  apiDelete<T>(path: string): Promise<T> {
    return this.apiFetch<T>(path, { method: 'DELETE' });
  }

  async loadConfigFile(): Promise<Record<string, unknown>> {
    return this.apiFetch<Record<string, unknown>>('/api/config');
  }

  async saveConfigFile(config: unknown): Promise<void> {
    await this.apiFetch<{ ok: boolean }>('/api/config', {
      method: 'PUT',
      body: JSON.stringify(config),
    });
    await this.loadSettings();
  }
}
