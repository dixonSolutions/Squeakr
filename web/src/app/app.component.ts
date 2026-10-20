import type { EffectRef, OnDestroy, OnInit } from '@angular/core';
import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';

import { Button } from '@openng/optimus-ui/button';
import { Dialog } from '@openng/optimus-ui/dialog';
import { Fluid } from '@openng/optimus-ui/fluid';
import { IftaLabel } from '@openng/optimus-ui/iftalabel';
import { Message } from '@openng/optimus-ui/message';
import { Password } from '@openng/optimus-ui/password';
import { Tag } from '@openng/optimus-ui/tag';
import { Toast } from '@openng/optimus-ui/toast';
import { Toolbar } from '@openng/optimus-ui/toolbar';

import { BrandComponent } from './components/brand/brand.component';
import { ConfigTabComponent } from './components/config-tab/config-tab.component';
import { LogsTabComponent } from './components/logs-tab/logs-tab.component';
import { MediaViewerComponent } from './components/media-viewer/media-viewer.component';
import { VoiceTabComponent } from './components/voice-tab/voice-tab.component';
import { WakeWordTestComponent } from './components/wake-word-test/wake-word-test.component';
import { AppearanceService } from './services/appearance.service';
import { AppStateService } from './services/app-state.service';
import { BridgeService } from './services/bridge.service';
import { LogService } from './services/log.service';
import { ToastService } from './services/toast.service';
import { VoiceProvidersService } from './services/voice-providers.service';
import { VoiceSessionService } from './services/voice-session.service';
import { PushService } from './services/push.service';

export type AppTab = 'voice' | 'wake' | 'config' | 'logs';

type TagSeverity = 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast' | undefined;

interface TabItem {
  id: AppTab;
  label: string;
  icon: string;
}

@Component({
  selector: 'cv-root',
  templateUrl: './app.component.html',
  standalone: true,
  imports: [
    FormsModule,
    BrandComponent,
    Button,
    Dialog,
    Fluid,
    IftaLabel,
    Message,
    Password,
    Tag,
    Toast,
    Toolbar,
    VoiceTabComponent,
    WakeWordTestComponent,
    ConfigTabComponent,
    LogsTabComponent,
    MediaViewerComponent,
  ],
})
export class AppComponent implements OnInit, OnDestroy {
  protected readonly bridge = inject(BridgeService);
  protected readonly appState = inject(AppStateService);
  protected readonly voiceSession = inject(VoiceSessionService);
  protected readonly voiceProviders = inject(VoiceProvidersService);
  private readonly appearance = inject(AppearanceService);
  private readonly toast = inject(ToastService);
  private readonly logs = inject(LogService);
  private readonly push = inject(PushService);

  protected tokenInput = '';
  protected readonly activeTab = signal<AppTab>('voice');

  protected readonly tabs: TabItem[] = [
    { id: 'voice', label: 'Voice', icon: 'pi pi-microphone' },
    { id: 'wake', label: 'Wake test', icon: 'pi pi-bolt' },
    { id: 'config', label: 'Config', icon: 'pi pi-cog' },
    { id: 'logs', label: 'Logs', icon: 'pi pi-list' },
  ];

  protected readonly visibleTabs = computed(() => this.tabs);

  /** Hide the top bar while the voice session is live (mic on / listening / working). */
  protected readonly isLiveVoice = computed(() => this.appState.state() !== 'idle');

  protected readonly statusLabel = computed(() => {
    const ws = this.bridge.wsStatus();
    const st = this.appState.state();
    if (this.bridge.apiStatus() === 'error') return 'API blocked';
    if (st === 'working') return 'Working';
    if (st === 'listening') return 'Listening';
    if (st === 'inactive') return 'Mic on';
    if (ws === 'connected') return 'Connected';
    if (ws === 'connecting') return 'Connecting';
    if (ws === 'disconnected') return 'Disconnected';
    if (ws === 'error') return 'Reconnecting…';
    return 'Not connected';
  });

  protected readonly statusSeverity = computed<TagSeverity>(() => {
    const ws = this.bridge.wsStatus();
    const st = this.appState.state();
    if (this.bridge.apiStatus() === 'error') return 'warn';
    if (st === 'working') return 'warn';
    if (ws === 'connected' || st === 'listening') return 'success';
    if (ws === 'error') return 'warn';
    if (ws === 'disconnected') return 'secondary';
    return 'secondary';
  });

  protected readonly statusIcon = computed(() => {
    const st = this.appState.state();
    if (st === 'working') return 'pi pi-spin pi-spinner';
    if (st === 'listening') return 'pi pi-microphone';
    if (this.bridge.wsStatus() === 'connected') return 'pi pi-check-circle';
    if (this.bridge.wsStatus() === 'error') return 'pi pi-sync';
    if (this.bridge.wsStatus() === 'disconnected') return 'pi pi-link';
    return 'pi pi-sync';
  });

  private _connectEffect: EffectRef;
  private _apiWarned = false;
  private _subs = new Subscription();

  constructor() {
    this._connectEffect = effect(() => {
      if (this.bridge.wsStatus() === 'connected') {
        void this.voiceProviders.refresh();
        void this.push.ensureRegistered();
        void this.push.syncPendingApprovals();
      }
      if (this.bridge.apiStatus() === 'error' && !this._apiWarned) {
        this._apiWarned = true;
        this.toast.warn('API unavailable', 'Check Bridge URL or leave it blank in test mode.');
      }
      if (this.bridge.apiStatus() === 'ok') {
        this._apiWarned = false;
      }
    });
  }

  ngOnInit(): void {
    this.appearance.init();
    this.bridge.loadCredentials();
    if (this.bridge.hasCredentials()) {
      this.bridge.connect();
      this.logs.append('info', 'bridge', 'Loaded saved credentials');
    }

    this._subs.add(
      this.bridge.authFailed$.subscribe(() => {
        this.toast.error(
          'Invalid app token',
          'Copy APP_TOKEN from the bridge .env file exactly — no extra spaces.',
        );
      }),
    );

    /**
     * Read question, plan and permission cards aloud (docs/40 §1).
     *
     * Nothing spoke these before: they went straight to the approval panel,
     * so a hands-free user with no screen was asked a question in silence.
     */
    this._subs.add(
      this.bridge.approvalRequest$.subscribe((request) => {
        this.voiceSession.speakPromptCard(request);
      }),
    );

    this._subs.add(
      this.bridge.channelCall$.subscribe((event) => this.voiceSession.mirrorChannelCall(event)),
    );

    this._subs.add(
      this.bridge.narration$.subscribe((event) => {
        // The event always arrives; `speak` decides whether it is heard. That
        // separation is why turning narration off no longer also kills the
        // "a job is running" state below (docs/39 Part B).
        if (event.speak !== false) this.voiceSession.injectNarration(event.text);
        if (event.kind === 'job_started') {
          this.voiceSession.notifyJobRunning(true);
        } else if (
          event.kind === 'job_done' ||
          event.kind === 'job_error' ||
          event.kind === 'ghost_killed'
        ) {
          this.voiceSession.notifyJobRunning(false);
        }
      }),
    );
  }

  ngOnDestroy(): void {
    this._connectEffect.destroy();
    this._subs.unsubscribe();
    this.voiceSession.stopSession();
    this.bridge.disconnect();
  }

  protected setTab(tab: AppTab): void {
    this.activeTab.set(tab);
  }

  protected isActiveTab(tab: AppTab): boolean {
    return this.activeTab() === tab;
  }

  protected onSaveToken(): void {
    const token = this.tokenInput.trim();
    if (!token) return;
    this.bridge.saveCredentials(token);
    this.tokenInput = '';
    this.bridge.connect();
    this.logs.append('info', 'bridge', 'Initial credentials saved');
    this.toast.success('Saved', 'Connecting to bridge…');
  }
}
