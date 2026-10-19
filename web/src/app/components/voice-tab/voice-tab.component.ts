import {
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import type { ElementRef } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { Accordion, AccordionContent, AccordionHeader, AccordionPanel } from '@openng/optimus-ui/accordion';
import { Button } from '@openng/optimus-ui/button';
import { Card } from '@openng/optimus-ui/card';
import { Dialog } from '@openng/optimus-ui/dialog';
import { Fluid } from '@openng/optimus-ui/fluid';
import { IftaLabel } from '@openng/optimus-ui/iftalabel';
import { Message } from '@openng/optimus-ui/message';
import { PrimeTemplate } from '@openng/optimus-ui/api';
import { Select } from '@openng/optimus-ui/select';
import { SelectButton } from '@openng/optimus-ui/selectbutton';
import { Skeleton } from '@openng/optimus-ui/skeleton';
import { Tag } from '@openng/optimus-ui/tag';
import { Textarea } from '@openng/optimus-ui/textarea';
import { ToggleSwitch } from '@openng/optimus-ui/toggleswitch';

import { AppStateService } from '../../services/app-state.service';
import {
  BridgeService,
  NEW_CURSOR_SESSION_ID,
  type CursorSessionEntry,
} from '../../services/bridge.service';
import { ToastService } from '../../services/toast.service';
import { LogService } from '../../services/log.service';
import { AgentProviderService, effortLabel, type ModelSelection } from '../../services/agent-provider.service';
import { VoiceProvidersService } from '../../services/voice-providers.service';
import { VoiceSessionService } from '../../services/voice-session.service';
import { ApprovalPanelComponent } from '../approval-panel/approval-panel.component';
import { AuthCardComponent } from '../auth-card/auth-card.component';
import { LiveLogPanelComponent } from '../live-log-panel/live-log-panel.component';
import {
  VoiceOrbComponent,
  type OrbActivity,
  type OrbColorMode,
} from '../voice-orb/voice-orb.component';
import { formatBytes, type ModelDownloadState } from '../../../model-download.js';
import {
  cachedMicPermission,
  micPermissionHelp,
  micPermissionState,
  onMicPermissionChange,
  type MicPermissionState,
} from '../../../mic-service.js';

const SELECT_PANEL_WIDTH_VAR = '--cv-select-panel-width';

interface ProjectOption {
  value: string;
  name: string;
  title: string;
  description: string;
  detail?: string;
  label: string;
  search: string;
}

interface SessionOption {
  value: string;
  title: string;
  detail?: string;
  label: string;
  search: string;
  isNew?: boolean;
}

interface ModelOption {
  value: string;
  title: string;
  label: string;
  detail?: string;
  search: string;
}

interface ModelGroup {
  label: string;
  items: ModelOption[];
}

interface EffortOption {
  label: string;
  value: string;
}

interface PermissionOption {
  value: string;
  label: string;
  detail: string;
  search: string;
}

/** SelectButton needs a non-null value; this stands in for "let the CLI decide". */
const DEFAULT_EFFORT_VALUE = '__default__';

@Component({
  selector: 'cv-voice-tab',
  standalone: true,
  imports: [
    FormsModule,
    Accordion,
    AccordionPanel,
    AccordionHeader,
    AccordionContent,
    Button,
    Card,
    Dialog,
    Fluid,
    IftaLabel,
    Message,
    PrimeTemplate,
    Select,
    SelectButton,
    Skeleton,
    Tag,
    Textarea,
    ToggleSwitch,
    ApprovalPanelComponent,
    AuthCardComponent,
    VoiceOrbComponent,
    LiveLogPanelComponent,
  ],
  templateUrl: './voice-tab.component.html',
})
export class VoiceTabComponent {
  protected readonly bridge = inject(BridgeService);
  protected readonly appState = inject(AppStateService);
  protected readonly voiceSession = inject(VoiceSessionService);
  protected readonly voiceProviders = inject(VoiceProvidersService);
  protected readonly agentProviders = inject(AgentProviderService);
  private readonly toast = inject(ToastService);
  private readonly logs = inject(LogService);

  protected selectedProject: string | null = null;
  protected selectedSessionId: string = NEW_CURSOR_SESSION_ID;
  protected typedMessage = '';
  protected textDialogVisible = false;

  /** Typed-request dialog copy — follows the active agent, never hardcoded. */
  protected readonly textDialogHeader = computed(
    () => `Ask ${this.agentProviders.activeProviderName()}`,
  );
  protected readonly textDialogPlaceholder = computed(
    () => `Describe what you want ${this.agentProviders.activeProviderName()} to do…`,
  );
  protected readonly sessionHistoryLoaded = signal(false);
  protected readonly loadingSessionLogs = signal(false);
  protected readonly agentSessions = signal<CursorSessionEntry[]>([]);
  protected readonly activeAgentSessionId = signal<string | null>(null);
  protected readonly loadingSessions = signal(false);
  protected readonly activationPhrase = computed(
    () => this.voiceProviders.data()?.wakeWords.start?.trim() || 'start',
  );

  protected readonly submitPhrase = computed(
    () => this.voiceProviders.data()?.wakeWords.end?.trim() || 'send',
  );

  protected readonly silenceSubmitLabel = computed(() => {
    const ms = this.voiceProviders.data()?.turnSubmit.silenceMs ?? 1500;
    if (this.vadEnabledEffective()) {
      return `${(ms / 1000).toFixed(1)}s silence (VAD)`;
    }
    return `${(ms / 1000).toFixed(1)}s silence`;
  });

  protected readonly vadEnabledEffective = computed(
    () => this.voiceProviders.data()?.turnSubmit.vadEnabled !== false,
  );

  protected readonly cancelPhrase = computed(
    () => this.voiceProviders.data()?.wakeWords.cancel?.trim() || 'cancel',
  );

  protected readonly workflowHint = computed(() => {
    const start = this.activationPhrase();
    const end = this.submitPhrase();
    const cancel = this.cancelPhrase();
    const silence = this.silenceSubmitLabel();
    const cancelNote = `Say "${cancel}" to abort a turn without sending.`;
    if (this.vadEnabledEffective()) {
      if (this.isAgentNative()) {
        const agent = this.agentProviders.activeProviderName();
        return (
          `Agent-first voice: say "${start}" to activate, then pause ${silence} to send. ` +
          `${cancelNote} The bridge auto-starts ${agent} when you speak — session id appears in logs.`
        );
      }
      return `Say "${start}" to activate. After that, Silero VAD sends your turn when you pause ${silence}. ${cancelNote} Vosk detects the wake phrase offline. Type below to test without a mic.`;
    }
    if (this.isAgentNative()) {
      const agent = this.agentProviders.activeProviderName();
      return (
        `Agent-first voice: say "${start}" to activate, then pause ${silence} or say "${end}" to send. ` +
        `${cancelNote} The bridge auto-starts ${agent} when you speak — session id appears in logs.`
      );
    }
    return `Say "${start}" to activate. After that, pause ${silence} or say "${end}" to send. ${cancelNote} Vosk detects start/end offline. Type below to test without a mic.`;
  });

  protected readonly sessionHint = computed(() => {
    const selected = this.selectedSessionId;
    if (!selected || selected === NEW_CURSOR_SESSION_ID) {
      return `New session — a fresh ${this.agentProviders.activeProviderName()} thread is created when you start voice.`;
    }
    const match = this.agentSessions().find((s) => s.session_id === selected);
    if (match) {
      return `Continuing thread from ${this.formatSessionDate(match.last_run_at)}. Prompts resume in that session.`;
    }
    return `Selected session will be used for the next ${this.agentProviders.activeProviderName()} run.`;
  });

  protected readonly audioBackendLabel = computed(() => {
    const backends = this.voiceSession.audioBackends();
    if (!backends) return null;
    // The session names the engines — the STT one is whatever the bridge routes to.
    const stt = backends.stt === 'text_only' ? 'Text input' : backends.sttLabel;
    const tts = backends.tts === 'none' ? 'No TTS' : backends.ttsLabel;
    return `${stt} · ${tts}`;
  });

  protected readonly isCascadeWorkflow = computed(() => {
    const workflow = this.bridge.settings()?.workflow.default ?? 'agent_native';
    return workflow === 'agent_native' || workflow === 'llm_intelligence';
  });

  protected readonly isAgentNative = computed(
    () => (this.bridge.settings()?.workflow.default ?? 'agent_native') === 'agent_native',
  );

  protected readonly showTextInput = computed(
    () => this.isBridgeConnected() && this.isCascadeWorkflow(),
  );

  /** Keep the editor reachable throughout a live session, including while Cursor works. */
  protected readonly showTextOrb = computed(
    () => this.showTextInput() && this.voiceSession.conversationActive(),
  );

  /** Typed follow-ups use the same turn queue as voice — available whenever the session is live. */
  protected readonly canSendTextTurn = computed(
    () => this.voiceSession.conversationActive() || this.voiceSession.sessionConnecting(),
  );

  /** Hide project/setup chrome while a voice session is starting or live. */
  protected readonly isLiveSession = computed(
    () =>
      this.voiceSession.sessionPrepActive() ||
      this.voiceSession.sessionConnecting() ||
      this.voiceSession.conversationActive(),
  );

  /** Large "Preparing" label while MCP setup runs — logs and setup chrome stay hidden. */
  protected readonly isPreparing = computed(() => this.voiceSession.sessionPrepActive());

  /** Whole-number percent for the progress bar; 0 while the total is unknown. */
  protected downloadPercent(download: ModelDownloadState): number {
    if (download.fraction === null) return 0;
    return Math.round(download.fraction * 100);
  }

  /** "23.4 MB of 48.2 MB · 49%", or a phase label when there is nothing to count. */
  protected downloadStatus(download: ModelDownloadState): string {
    if (download.phase === 'unpacking') return 'Unpacking…';
    if (download.totalBytes === null) {
      return `${formatBytes(download.loadedBytes)} downloaded`;
    }
    const loaded = formatBytes(download.loadedBytes);
    const total = formatBytes(download.totalBytes);
    return `${loaded} of ${total} · ${this.downloadPercent(download)}%`;
  }

  /** Session log panel: existing session history or live call — never during prepare. */
  protected readonly showSessionLogs = computed(() => {
    if (this.voiceSession.sessionPrepActive()) return false;
    return (
      this.sessionHistoryLoaded() ||
      this.voiceSession.conversationActive() ||
      this.voiceSession.sessionConnecting()
    );
  });

  protected readonly projectOptions = computed<ProjectOption[]>(() =>
    this.bridge.projects().map((p) => {
      const description = p.description?.trim() ?? '';
      return {
        value: p.name,
        name: p.name,
        title: p.name,
        description,
        detail: description || undefined,
        label: p.name,
        search: [p.name, description, ...(p.aliases ?? [])].filter(Boolean).join(' '),
      };
    }),
  );

  protected readonly sessionOptions = computed<SessionOption[]>(() => {
    const fromHistory = this.agentSessions().map((s) => {
      const title = this.formatSessionTitle(s);
      const detail = this.truncatePrompt(s.last_prompt, 120);
      return {
        value: s.session_id,
        title,
        detail: detail || undefined,
        label: title,
        search: [s.session_id, s.last_prompt, s.last_status, title, detail].join(' '),
      };
    });
    return [
      {
        title: 'New session',
        value: NEW_CURSOR_SESSION_ID,
        detail: 'Fresh thread on start',
        label: 'New session',
        search: 'new session fresh thread',
        isNew: true,
      },
      ...fromHistory,
    ];
  });

  /** Shown on the collapsed accordion header so users see current context. */
  protected readonly setupAccordionSummary = computed(() => {
    const project = this.selectedProject ?? this.bridge.activeProject();
    if (!project) return 'Choose project and session';

    let sessionPart = 'new session';
    const sid = this.selectedSessionId;
    if (sid && sid !== NEW_CURSOR_SESSION_ID) {
      const match = this.agentSessions().find((s) => s.session_id === sid);
      const idShort = sid.length > 10 ? `${sid.slice(0, 8)}…` : sid;
      const prompt = match ? this.truncatePrompt(match.last_prompt, 22) : '';
      sessionPart = prompt ? `${idShort} — ${prompt}` : idShort;
    }

    const provider = this.agentProviders.activeProvider;
    const modelPart = provider?.supportsModelSelection ? ` · ${this.agentProviders.activeLabel()}` : '';
    return `${project} · ${sessionPart}${modelPart}`;
  });

  protected readonly isBridgeConnected = computed(
    () => this.bridge.wsStatus() === 'connected',
  );

  protected readonly pttDisabled = computed(() => {
    if (
      this.voiceSession.sessionPrepActive() ||
      this.voiceSession.sessionConnecting()
    ) {
      return false;
    }
    return (
      this.bridge.wsStatus() !== 'connected' ||
      !this.bridge.activeProject() ||
      !this.selectedSessionId
    );
  });

  /**
   * Workflow tag. Names the *pipeline*, not the agent — the agent's own name
   * belongs to activeProviderChip below, so it is never printed twice.
   */
  protected readonly workflowLabel = computed(() => {
    const workflow = this.bridge.settings()?.workflow.default ?? 'agent_native';
    if (workflow === 'agent_native') return 'Agent first';
    const model = this.bridge.settings()?.workflow.llmIntelligence.model;
    return model ? `Intelligence · ${model}` : 'Intelligence first';
  });

  protected selectedModelId: string | null = null;
  protected selectedEffortValue: string = DEFAULT_EFFORT_VALUE;
  protected selectedFast = false;
  protected readonly applyingSelection = signal(false);

  /**
   * Live model list for the active agent CLI, grouped by vendor — never
   * hardcoded. "Auto" always leads its group so the CLI-default row is one
   * tap away.
   */
  protected readonly modelGroups = computed<ModelGroup[]>(() => {
    const providerName = this.agentProviders.activeProviderName();
    const groups = new Map<string, ModelOption[]>();
    const order: string[] = [];
    const push = (label: string, opt: ModelOption) => {
      let items = groups.get(label);
      if (!items) {
        items = [];
        groups.set(label, items);
        order.push(label);
      }
      items.push(opt);
    };

    for (const m of this.agentProviders.models()) {
      push(m.id === 'auto' ? providerName : (m.vendor ?? providerName), {
        value: m.id,
        title: m.displayName,
        label: m.displayName,
        detail: m.description,
        search: `${m.id} ${m.displayName} ${m.vendor ?? ''} ${m.description ?? ''} ${(m.variants ?? []).map((v) => v.id).join(' ')}`,
      });
    }

    // The active id must always be an option or the trigger renders blank —
    // e.g. a model from a previous CLI version that is no longer listed.
    const active = this.agentProviders.activeSelection().model;
    if (active && !this.agentProviders.modelById(active)) {
      push(providerName, {
        value: active,
        title: active === 'auto' ? 'Auto' : active,
        label: active === 'auto' ? 'Auto' : active,
        detail: active === 'auto' ? undefined : 'Not in the current model list',
        search: active,
      });
    }

    return order.map((label) => ({ label, items: groups.get(label)! }));
  });

  /** Flat view of the grouped options (for lookups). */
  protected readonly modelOptions = computed<ModelOption[]>(() =>
    this.modelGroups().flatMap((g) => g.items),
  );

  protected readonly selectedModel = computed(() => {
    // Read the signal so the effort row re-computes when the list arrives.
    this.agentProviders.models();
    return this.agentProviders.modelById(this.selectedModelId ?? this.agentProviders.activeSelection().model);
  });

  /**
   * Effort levels the CLI offers for the selected model, in display order.
   * Variant-based models (Cursor) only get "Default" when an unsuffixed id
   * exists; flag-based ones (Claude Code, Codex) always can omit the flag.
   */
  protected readonly effortOptions = computed<EffortOption[]>(() => {
    const model = this.selectedModel();
    if (!model || model.efforts.length === 0) return [];
    const levels: Array<string | null> = model.variants
      ? [...new Set(model.variants.map((v) => v.effort))]
      : [null, ...model.efforts];
    // Keep the bridge's order for real levels; "Default" always leads.
    const ordered = [
      ...(levels.includes(null) ? [null] : []),
      ...model.efforts.filter((e) => levels.includes(e)),
    ];
    return ordered.map((e) => ({
      label: e === null ? 'Default' : effortLabel(e),
      value: e ?? DEFAULT_EFFORT_VALUE,
    }));
  });

  protected readonly selectedModelSupportsFast = computed(() => this.selectedModel()?.fast ?? false);

  // ── Permission mode ──────────────────────────────────────────────────────

  protected selectedPermissionMode: string | null = null;
  protected readonly applyingPermission = signal(false);

  /** The approval policies this CLI can run headlessly — from the bridge, per provider. */
  protected readonly permissionOptions = computed<PermissionOption[]>(() =>
    this.agentProviders.permissionModes().map((m) => ({
      value: m.id,
      label: m.label,
      detail: `${m.description} ${this.promptsNote(m.prompts)}`.trim(),
      search: `${m.id} ${m.label} ${m.description}`,
    })),
  );

  /** One line under the select: what a would-be prompt turns into in the active mode. */
  protected readonly permissionHint = computed(() => {
    const active = this.agentProviders.activePermissionMode();
    if (!active) return null;
    const agent = this.agentProviders.activeProviderName();
    switch (active.prompts) {
      case 'phone':
        return `${agent} sends each permission prompt to this phone — allow or deny on the card, or say "yes" / "no".`;
      case 'deny':
        return `${agent} cannot show a prompt headlessly in this mode — anything it would ask about is refused.`;
      default:
        return `Nothing asks in this mode. sudo, git and ssh password prompts still come to this phone.`;
    }
  });

  private promptsNote(prompts: 'phone' | 'deny' | 'never'): string {
    switch (prompts) {
      case 'phone':
        return '· prompts go to your phone';
      case 'deny':
        return '· prompts are refused';
      default:
        return '';
    }
  }

  /** "Live from Cursor" / "Cursor list from 3 min ago" — tells the user how fresh the picker is. */
  protected readonly modelSourceHint = computed(() => {
    const provider = this.agentProviders.activeProviderName();
    const count = this.agentProviders.models().length;
    const cachedAt = this.agentProviders.modelsCachedAt();
    if (count === 0) return `No models reported by ${provider}`;
    if (!cachedAt) return `${count} models · live from ${provider}`;
    const ageMs = Date.now() - new Date(cachedAt).getTime();
    const mins = Math.max(0, Math.round(ageMs / 60_000));
    const age = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`;
    return `${count} models · from ${provider} ${age}`;
  });

  /**
   * The single place the coding agent identifies itself in the UI, e.g.
   * "Claude Code · Opus (1M context) · High · Fast". Everything else refers to
   * the pipeline or to Squeakr — see app/branding.ts.
   */
  protected readonly activeProviderChip = computed(() => {
    const provider = this.agentProviders.activeProvider;
    if (!provider) return null;
    if (!provider.supportsModelSelection) return provider.displayName;
    return `${provider.displayName} · ${this.agentProviders.activeLabel()}`;
  });

  protected readonly visualizeUserSpeech = computed(() => {
    if (!this.voiceSession.voiceActivated()) return false;
    if (this.voiceSession.vadListening()) return true;
    if (this.voiceSession.endPhraseArmed()) return true;
    if (this.voiceSession.submittingTurn()) return true;
    return this.voiceSession.audioSpectrum().mic >= 0.028;
  });

  protected readonly orbColorMode = computed((): OrbColorMode => {
    if (this.voiceSession.sessionPrepActive() || this.voiceSession.sessionConnecting()) {
      return 'idle';
    }
    if (!this.voiceSession.conversationActive()) return 'idle';
    if (this.voiceSession.voiceActivated()) return 'listening';
    return 'ready';
  });

  /**
   * Whether work is running, taken from the bridge's `agent_busy` rather than
   * guessed from narration — narration can be off, and a reconnect wipes
   * whatever the client had inferred (docs/40 §3).
   */
  protected readonly orbActivity = computed((): OrbActivity => {
    const busy = this.bridge.agentBusy();
    if (busy.pendingApprovals > 0) return 'waiting_for_you';
    if (busy.voiceTurnActive || busy.workers > 0) return 'working';
    return 'none';
  });

  /** One line under the orb saying what the ring means. */
  protected readonly orbActivityCaption = computed((): string => {
    const busy = this.bridge.agentBusy();
    if (busy.pendingApprovals > 0) {
      return busy.pendingApprovals === 1
        ? 'Waiting for your answer'
        : `Waiting for your answer — ${busy.pendingApprovals} questions`;
    }
    if (busy.workers > 0) {
      return busy.workers === 1 ? 'Working — 1 agent' : `Working — ${busy.workers} agents`;
    }
    if (busy.voiceTurnActive) return 'Working';
    return '';
  });

  /**
   * Microphone permission, watched rather than assumed. `prompt` is fine —
   * the orb tap will ask — so only `denied` gets the onboarding card, which is
   * the state the user cannot escape from inside the app.
   */
  protected readonly micPermission = signal<MicPermissionState>(cachedMicPermission());

  protected readonly micPermissionBlocked = computed(() => this.micPermission() === 'denied');

  protected readonly micHelp = computed(() => micPermissionHelp());

  protected readonly showOrbCaption = computed(
    () => !this.isLiveSession() && this.orbColorMode() === 'idle',
  );

  protected readonly orbStateLabel = computed(() => {
    if (this.voiceSession.sessionPrepActive()) return 'Preparing…';
    if (this.voiceSession.sessionConnecting()) return 'Connecting…';
    if (!this.voiceSession.conversationActive()) return 'Tap to start';
    return 'Tap to hang up';
  });

  protected readonly pttAriaLabel = computed(() => this.appState.pttLabel());

  protected readonly wakeHint = computed(() => {
    if (this.isLiveSession()) return null;
    const start = this.activationPhrase();
    const backends = this.voiceSession.audioBackends();
    if (backends?.stt === 'text_only') {
      return 'No mic STT — type below. Mic path requires browser speech recognition or Amazon Transcribe.';
    }
    return `Tap the orb — then say "${start}" to activate. Background noise is filtered.`;
  });

  protected readonly liveSessionHint = computed(() => {
    if (!this.voiceSession.conversationActive()) return null;
    const wakeOff = this.voiceProviders.data()?.wakeWordsEnabled === false;
    if (this.voiceSession.nativeCallActive()) {
      if (wakeOff) {
        return 'Wake words off — use Speak / Cancel. You can lock the screen; the call stays active.';
      }
      return 'You can lock the screen — the call stays active and uses less battery. Hang up when you are done.';
    }
    if (wakeOff) {
      return 'Wake words off — use Speak / Cancel on screen. Keep this app open.';
    }
    return 'Keep this app open — voice pauses if you switch apps. Screen stays on while connected.';
  });

  /** Speak / Cancel bar — when_muted (default), always, or off. */
  protected readonly showTouchControls = computed(() => {
    if (!this.voiceSession.conversationActive()) return false;
    if (this.voiceSession.submittingTurn()) return false;
    const mode = this.voiceProviders.data()?.touchControls ?? 'when_muted';
    if (mode === 'off') return false;
    if (mode === 'always') return true;
    return this.voiceSession.micMuted();
  });

  protected readonly showCancelProcessing = computed(
    () => this.voiceSession.conversationActive() && this.voiceSession.submittingTurn(),
  );

  protected readonly showCaptureCancel = computed(
    () =>
      this.showTouchControls() &&
      this.voiceSession.voiceActivated() &&
      !this.voiceSession.submittingTurn(),
  );

  protected readonly showTouchSpeak = computed(
    () =>
      this.showTouchControls() &&
      !this.voiceSession.voiceActivated() &&
      !this.voiceSession.submittingTurn(),
  );

  /** Select overlays must sit above mobile tabbar (z-index 1200). */
  protected readonly selectOverlayOptions = {
    baseZIndex: 1300,
  };

  protected readonly selectPanelStyleClass = 'cv-voice-select-overlay';

  private readonly pickersEl = viewChild<ElementRef<HTMLElement>>('pickers');

  /**
   * Publish the picker column width so body-appended select panels can match it.
   * This has to be current *before* a panel opens: the library positions the
   * overlay from its rendered width, so measuring on show would leave a
   * correctly sized panel sitting at the wrong offset.
   */
  private trackPickerWidth(): void {
    effect((onCleanup) => {
      const host = this.pickersEl()?.nativeElement;
      const root = document.documentElement;
      if (!host) {
        root.style.removeProperty(SELECT_PANEL_WIDTH_VAR);
        return;
      }

      const publish = () => {
        const width = Math.round(host.getBoundingClientRect().width);
        if (width > 0) root.style.setProperty(SELECT_PANEL_WIDTH_VAR, `${width}px`);
      };

      publish();
      const observer = new ResizeObserver(publish);
      observer.observe(host);
      onCleanup(() => {
        observer.disconnect();
        root.style.removeProperty(SELECT_PANEL_WIDTH_VAR);
      });
    });
  }

  constructor() {
    this.trackPickerWidth();

    // The microphone permission can change while the app is open (the user
    // flipping it in site settings), so this watches rather than sampling once.
    void micPermissionState().then((state) => this.micPermission.set(state));
    inject(DestroyRef).onDestroy(
      onMicPermissionChange((state) => this.micPermission.set(state)),
    );

    effect(() => {
      if (this.bridge.wsStatus() === 'connected') {
        void this.voiceProviders.refresh();
        void this.agentProviders.refreshProviders();
        void this.agentProviders.refreshModels();
        void this.agentProviders.refreshPermissionModes();
      }
    });
    effect(() => {
      const active = this.bridge.activeProject();
      if (active) {
        this.selectedProject = active;
        void this.loadSessionsForProject(active);
      }
    });
    effect(() => {
      if (this.bridge.wsStatus() === 'connected' && this.selectedProject) {
        void this.loadSessionsForProject(this.selectedProject);
      }
    });
    effect(() => {
      const active = this.agentProviders.activeSelection();
      this.selectedModelId = active.model;
      this.selectedEffortValue = active.effort ?? DEFAULT_EFFORT_VALUE;
      this.selectedFast = active.fast;
    });
    effect(() => {
      this.selectedPermissionMode = this.agentProviders.activePermissionMode()?.id ?? null;
    });
  }

  protected toggleMicMute(): void {
    this.voiceSession.toggleMicMute();
  }

  protected onTouchSpeak(): void {
    void this.voiceSession.touchSpeak();
  }

  protected onTouchCancel(): void {
    if (this.voiceSession.cancelCurrentTurn()) {
      this.toast.info('Cancelled', 'Turn discarded.');
    }
  }

  protected onCancelProcessing(): void {
    if (this.voiceSession.cancelCurrentTurn()) {
      this.toast.info('Cancelled', 'Processing stopped — turn discarded.');
    }
  }

  protected onProjectChange(name: string | null): void {
    if (!name) return;
    this.selectedProject = name;
    void this.bridge.setActiveProject(name).then(async () => {
      this.toast.info('Project updated', name);
      await this.loadSessionsForProject(name);
      if (this.voiceSession.conversationActive()) {
        this.toast.warn(
          'Restart voice',
          'Hang up and tap the orb again so the new project is picked up.',
        );
      }
    });
  }

  protected onSessionChange(sessionId: string | null): void {
    const next = sessionId ?? NEW_CURSOR_SESSION_ID;
    this.selectedSessionId = next;

    const project = this.selectedProject;
    if (!project) return;

    if (next === NEW_CURSOR_SESSION_ID) {
      this.sessionHistoryLoaded.set(false);
      this.logs.clearVoiceSession();
      this.bridge.storeCursorSessionPreference(project, NEW_CURSOR_SESSION_ID);
      return;
    }

    this.bridge.storeCursorSessionPreference(project, next);
    void this.bridge.selectCursorSession(project, next).catch(() => {
      this.toast.error('Could not select session');
    });
    void this.loadSessionLogsForSelection(project, next);
  }

  protected onModelChange(modelId: string | null): void {
    if (!modelId || modelId === this.selectedModelId) return;
    this.selectedModelId = modelId;
    // Keep the knobs; the bridge clamps them to what the new model offers and
    // the response tells us what it actually applied.
    void this.applySelection({
      model: modelId,
      effort: this.effortFromValue(this.selectedEffortValue),
      fast: this.selectedFast,
    });
  }

  protected onEffortChange(value: string | null): void {
    const next = value ?? DEFAULT_EFFORT_VALUE;
    if (next === this.selectedEffortValue) return;
    this.selectedEffortValue = next;
    void this.applySelection({
      model: this.selectedModelId ?? this.agentProviders.activeSelection().model,
      effort: this.effortFromValue(next),
      fast: this.selectedFast,
    });
  }

  protected onFastChange(fast: boolean): void {
    if (fast === this.selectedFast) return;
    this.selectedFast = fast;
    void this.applySelection({
      model: this.selectedModelId ?? this.agentProviders.activeSelection().model,
      effort: this.effortFromValue(this.selectedEffortValue),
      fast,
    });
  }

  protected onPermissionModeChange(modeId: string | null): void {
    if (!modeId || modeId === this.selectedPermissionMode) return;
    this.selectedPermissionMode = modeId;
    this.applyingPermission.set(true);
    void this.agentProviders
      .setPermissionMode(modeId)
      .then((res) => {
        this.toast.info('Permissions updated', `${res.displayName} · ${res.active.label}`);
      })
      .catch((err) => {
        const detail = err instanceof Error ? err.message : String(err);
        this.toast.error('Could not set permissions', detail);
        this.selectedPermissionMode = this.agentProviders.activePermissionMode()?.id ?? null;
      })
      .finally(() => this.applyingPermission.set(false));
  }

  protected refreshModels(): void {
    void this.agentProviders.refreshModels({ force: true }).then(() => {
      if (this.agentProviders.modelsError()) return;
      this.toast.info('Models reloaded', this.modelSourceHint());
    });
  }

  private effortFromValue(value: string | null): string | null {
    return !value || value === DEFAULT_EFFORT_VALUE ? null : value;
  }

  private async applySelection(selection: ModelSelection): Promise<void> {
    this.applyingSelection.set(true);
    try {
      const res = await this.agentProviders.setSelection(selection);
      const asked = selection.effort ?? null;
      const clamped = res.active.effort !== asked || res.active.fast !== selection.fast;
      if (clamped) {
        this.toast.warn('Adjusted to what the CLI offers', res.label);
      } else {
        this.toast.info('Model updated', res.label);
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.toast.error('Could not set model', detail);
      // Snap the controls back to what the bridge is actually running.
      const active = this.agentProviders.activeSelection();
      this.selectedModelId = active.model;
      this.selectedEffortValue = active.effort ?? DEFAULT_EFFORT_VALUE;
      this.selectedFast = active.fast;
    } finally {
      this.applyingSelection.set(false);
    }
  }

  protected handlePtt(): void {
    if (
      this.voiceSession.sessionPrepActive() ||
      this.voiceSession.sessionConnecting()
    ) {
      this.voiceSession.stopSession();
      this.toast.info('Cancelled');
      return;
    }

    const st = this.appState.state();
    if (st === 'idle') {
      void this.voiceSession.startSession();
    } else if (st === 'inactive' || st === 'listening' || st === 'working') {
      this.voiceSession.stopSession();
      this.toast.info('Mic off');
    }
  }

  protected async sendTypedMessage(): Promise<void> {
    const text = this.typedMessage.trim();
    if (!text || !this.canSendTextTurn()) return;
    const sent = await this.voiceSession.sendTextMessage(text);
    if (!sent) return;
    this.typedMessage = '';
    this.textDialogVisible = false;
  }

  protected openTextDialog(): void {
    this.textDialogVisible = true;
  }

  protected closeTextDialog(): void {
    this.textDialogVisible = false;
  }

  protected handleEditorKeydown(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      this.sendTypedMessage();
    }
  }

  private async loadSessionsForProject(project: string): Promise<void> {
    if (!this.isBridgeConnected()) return;
    this.loadingSessions.set(true);
    try {
      const data = await this.bridge.loadCursorSessions(project);
      const sessions = [...data.sessions];
      if (
        data.active_session_id &&
        !sessions.some((s) => s.session_id === data.active_session_id)
      ) {
        sessions.unshift({
          session_id: data.active_session_id,
          last_prompt: 'Current thread',
          last_status: 'done',
          last_run_at: new Date().toISOString(),
          job_count: 0,
        });
      }

      const stored = this.bridge.getStoredCursorSession(project);
      if (
        stored &&
        stored !== NEW_CURSOR_SESSION_ID &&
        !sessions.some((s) => s.session_id === stored)
      ) {
        // Stale local preference from another host or cleared server DB — drop it.
        this.bridge.clearStoredCursorSession(project);
      }

      this.agentSessions.set(sessions);
      this.activeAgentSessionId.set(data.active_session_id);
      this.restoreSessionSelection(project, sessions, data.active_session_id);
    } catch {
      this.agentSessions.set([]);
      this.selectedSessionId = NEW_CURSOR_SESSION_ID;
    } finally {
      this.loadingSessions.set(false);
    }
  }

  /** Keep user choice across reloads; fall back to stored preference or active resume id. */
  private restoreSessionSelection(
    project: string,
    sessions: CursorSessionEntry[],
    activeSessionId: string | null,
  ): void {
    const valid = new Set<string>([
      NEW_CURSOR_SESSION_ID,
      ...sessions.map((s) => s.session_id),
    ]);
    if (activeSessionId) valid.add(activeSessionId);

    const stored = this.bridge.getStoredCursorSession(project);
    if (stored && !valid.has(stored)) {
      this.bridge.clearStoredCursorSession(project);
    }

    const current =
      this.selectedSessionId && valid.has(this.selectedSessionId)
        ? this.selectedSessionId
        : null;

    let pick = NEW_CURSOR_SESSION_ID;
    if (stored && valid.has(stored)) {
      pick = stored;
    } else if (current) {
      pick = current;
    } else if (activeSessionId && valid.has(activeSessionId)) {
      pick = activeSessionId;
    }

    this.selectedSessionId = pick;
    if (pick !== NEW_CURSOR_SESSION_ID) {
      void this.loadSessionLogsForSelection(project, pick);
    } else {
      this.sessionHistoryLoaded.set(false);
      this.logs.clearVoiceSession();
    }
  }

  private async loadSessionLogsForSelection(project: string, sessionId: string): Promise<void> {
    if (!this.isBridgeConnected()) return;
    this.loadingSessionLogs.set(true);
    try {
      const data = await this.bridge.loadCursorSessionLogs(project, sessionId);
      this.logs.loadSessionHistory(data.entries);
      this.sessionHistoryLoaded.set(true);
    } catch {
      this.sessionHistoryLoaded.set(false);
      this.toast.error('Could not load session logs');
    } finally {
      this.loadingSessionLogs.set(false);
    }
  }

  private formatSessionTitle(s: CursorSessionEntry): string {
    const id = s.session_id.length > 10 ? `${s.session_id.slice(0, 8)}…` : s.session_id;
    return id;
  }

  private truncatePrompt(text: string, max = 48): string {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (clean.length <= max) return clean;
    return `${clean.slice(0, max - 1)}…`;
  }

  private formatSessionDate(iso: string): string {
    try {
      return new Date(iso).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
    } catch {
      return iso;
    }
  }
}
