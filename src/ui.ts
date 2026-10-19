import { icons } from './icons';
import { LANGUAGE_NAMES, translate, type MessageKey } from './i18n';
import { applyToDocument, FONT_SIZE, LANGUAGES, PREF_KEYS, type PrefKey, type Preferences } from './preferences';
import { RACE_DELAY_MS, type StoreEvent, type SyncedPreferences } from './store';

const FIELD_LABELS: Record<PrefKey, MessageKey> = { theme: 'darkMode', language: 'language', fontSize: 'fontSize' };
const MAX_LOG_ENTRIES = 50;
const MAX_LATENCY_SAMPLES = 200;
const MAX_TOASTS = 3;
const TOAST_MS = 3200;
/** A brief fingerprint mismatch while a message is in flight is not worth showing. */
const SYNCING_GRACE_MS = 300;
const LATENCY_TARGET_MS = 100;

type SyncState = 'alone' | 'synced' | 'syncing';

interface LogEntry {
  time: Date;
  message: MessageKey;
  tab?: string;
  keys?: PrefKey[];
}

interface Toast {
  node: HTMLElement;
  text: HTMLElement;
  close: HTMLElement;
  tab: string;
  keys: PrefKey[];
  signature: string;
  timer: ReturnType<typeof setTimeout>;
}

const SHELL = /* html */ `
  <header class="app-header">
    <div class="brand">
      <span class="logo">${icons.logo}</span>
      <div>
        <h1 data-i18n="appTitle"></h1>
        <p class="subtitle" data-i18n="appSubtitle"></p>
      </div>
    </div>
    <div class="presence" data-ref="presence" role="status">
      <span class="presence-dot"></span>
      <span data-ref="presenceLabel"></span>
    </div>
  </header>

  <div class="update-banner" data-ref="updateBanner" role="alert" hidden>
    ${icons.sync}
    <span data-i18n="updateAvailable"></span>
    <button type="button" class="button button-sm button-primary" data-ref="reloadButton">
      <span data-i18n="reload"></span>
    </button>
  </div>

  <main class="layout">
    <div class="column">
      <section class="card" aria-labelledby="prefs-heading">
        <div class="card-head">
          <h2 id="prefs-heading" data-i18n="preferences"></h2>
          <button type="button" class="button button-ghost button-sm" data-ref="reset">
            ${icons.reset}<span data-i18n="reset"></span>
          </button>
        </div>

        <div class="setting" data-setting="theme">
          <span class="setting-icon">${icons.moon}</span>
          <div class="setting-text">
            <span class="setting-label" id="dark-label" data-i18n="darkMode"></span>
            <span class="setting-hint" data-i18n="darkModeHint"></span>
          </div>
          <button type="button" class="switch" role="switch" aria-labelledby="dark-label" data-ref="themeSwitch">
            <span class="switch-icon switch-icon-sun">${icons.sun}</span>
            <span class="switch-icon switch-icon-moon">${icons.moon}</span>
            <span class="switch-thumb"></span>
          </button>
        </div>

        <div class="setting" data-setting="language">
          <span class="setting-icon">${icons.globe}</span>
          <div class="setting-text">
            <label class="setting-label" for="language" data-i18n="language"></label>
            <span class="setting-hint" data-i18n="languageHint"></span>
          </div>
          <div class="select-wrap">
            <select id="language" class="select" data-ref="languageSelect"></select>
            ${icons.chevron}
          </div>
        </div>

        <div class="setting setting-stacked" data-setting="fontSize">
          <div class="setting-row">
            <span class="setting-icon">${icons.type}</span>
            <div class="setting-text">
              <label class="setting-label" for="font-size" data-i18n="fontSize"></label>
              <span class="setting-hint" data-i18n="fontSizeHint"></span>
            </div>
            <output for="font-size" class="badge" data-ref="fontSizeOutput"></output>
          </div>
          <div class="slider-row">
            <button type="button" class="icon-button" data-ref="decrease">${icons.minus}</button>
            <span class="slider-a slider-a-small" aria-hidden="true">A</span>
            <input id="font-size" type="range" class="range" data-ref="fontSizeRange"
              min="${FONT_SIZE.min}" max="${FONT_SIZE.max}" step="${FONT_SIZE.step}" />
            <span class="slider-a slider-a-large" aria-hidden="true">A</span>
            <button type="button" class="icon-button" data-ref="increase">${icons.plus}</button>
          </div>
        </div>
      </section>

      <section class="card preview-card" aria-labelledby="preview-heading">
        <span class="eyebrow" data-i18n="preview"></span>
        <h3 id="preview-heading" class="preview-title" data-i18n="previewTitle"></h3>
        <p class="preview-text" data-i18n="previewText"></p>
        <div class="preview-meta">
          <span class="pill" data-ref="previewTheme"></span>
          <span class="pill" data-ref="previewLanguage"></span>
          <span class="pill mono" data-ref="previewSize"></span>
        </div>
      </section>
    </div>

    <div class="column">
      <section class="card" aria-labelledby="sync-heading">
        <div class="card-head">
          <h2 id="sync-heading" data-i18n="syncStatus"></h2>
        </div>

        <div class="status-hero" data-ref="statusHero">
          <span class="status-icon" data-ref="statusIcon"></span>
          <div class="status-text">
            <strong data-ref="statusTitle"></strong>
            <span data-ref="statusDetail"></span>
          </div>
        </div>

        <ul class="tab-list" data-ref="tabList" aria-label=""></ul>

        <div class="metrics" data-ref="metrics">
          <div class="metric"><span class="metric-label" data-i18n="lastLatency"></span><span class="metric-value mono" data-ref="latencyLast"></span></div>
          <div class="metric"><span class="metric-label" data-i18n="avgLatency"></span><span class="metric-value mono" data-ref="latencyAvg"></span></div>
          <div class="metric"><span class="metric-label" data-i18n="maxLatency"></span><span class="metric-value mono" data-ref="latencyMax"></span></div>
        </div>
        <p class="metrics-empty" data-ref="metricsEmpty" data-i18n="noLatency" hidden></p>
        <p class="setting-hint metric-target">${icons.bolt}<span data-i18n="latencyTarget"></span></p>

        <div class="actions">
          <button type="button" class="button" data-ref="openTab">${icons.externalTab}<span data-i18n="openTab"></span></button>
          <button type="button" class="button button-primary" data-ref="raceButton">${icons.bolt}<span data-i18n="raceTest"></span></button>
        </div>
        <p class="setting-hint" data-i18n="raceHint"></p>

        <details class="details">
          <summary>${icons.chevron}<span data-i18n="details"></span></summary>
          <dl class="detail-list">
            <div><dt data-i18n="thisTab"></dt><dd class="mono" data-ref="tabId"></dd></div>
            <div><dt data-i18n="transport"></dt><dd class="mono" data-ref="transport"></dd></div>
            <div>
              <dt data-i18n="fingerprint"></dt>
              <dd><code class="fingerprint" data-ref="fingerprint" data-testid="fingerprint"></code></dd>
            </div>
          </dl>
          <p class="setting-hint" data-i18n="fingerprintHint"></p>
          <h3 class="subheading" data-i18n="clocks"></h3>
          <div class="table-wrap">
            <table class="clocks">
              <thead><tr><th data-i18n="field"></th><th data-i18n="value"></th><th data-i18n="writer"></th><th>HLC</th></tr></thead>
              <tbody data-ref="clockRows"></tbody>
            </table>
          </div>
        </details>
      </section>

      <section class="card" aria-labelledby="activity-heading">
        <div class="card-head"><h2 id="activity-heading" data-i18n="activity"></h2></div>
        <ol class="log" data-ref="log"></ol>
      </section>
    </div>
  </main>

  <div class="toasts" data-ref="toasts" aria-live="polite"></div>
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Stable colour per tab id, so the same tab looks the same in every tab. */
function tabDot(id: string): HTMLElement {
  const dot = el('span', 'tab-dot');
  dot.style.setProperty('--hue', String(parseInt(id.slice(0, 6), 16) % 360));
  return dot;
}

/** Starts (or restarts) a CSS animation without forcing a synchronous layout. */
function replayClass(node: Element, className: string): void {
  if (!node.classList.contains(className)) {
    node.classList.add(className);
    node.addEventListener('animationend', () => node.classList.remove(className), { once: true });
    return;
  }
  for (const animation of node.getAnimations()) {
    animation.cancel();
    animation.play();
  }
}

export class SettingsView {
  private readonly refs: Record<string, HTMLElement> = {};
  private readonly log: LogEntry[] = [];
  private readonly latencies: number[] = [];
  private readonly toasts: Toast[] = [];
  private lastLatency?: number;
  private mismatchSince?: number;
  private graceTimer?: ReturnType<typeof setTimeout>;
  private renderQueued = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly store: SyncedPreferences,
  ) {
    root.innerHTML = SHELL;
    root.querySelectorAll<HTMLElement>('[data-ref]').forEach((node) => (this.refs[node.dataset.ref!] = node));
    this.populateLanguages();
    this.bindControls();
    store.subscribe((event) => this.onStoreEvent(event));
    this.render();
  }

  private get prefs(): Preferences {
    return this.store.values;
  }

  private t(key: MessageKey, params?: Record<string, string>): string {
    return translate(this.prefs.language, key, params);
  }

  private fieldNames(keys: PrefKey[]): string {
    return keys.map((key) => this.t(FIELD_LABELS[key])).join(', ');
  }

  private populateLanguages(): void {
    const select = this.refs.languageSelect as HTMLSelectElement;
    for (const code of LANGUAGES) {
      const option = el('option', undefined, LANGUAGE_NAMES[code]);
      option.value = code;
      option.lang = code;
      select.append(option);
    }
  }

  private bindControls(): void {
    const stepFont = (delta: number) => {
      const next = Math.min(FONT_SIZE.max, Math.max(FONT_SIZE.min, this.prefs.fontSize + delta));
      this.store.set('fontSize', next);
    };
    this.refs.themeSwitch.addEventListener('click', () =>
      this.store.set('theme', this.prefs.theme === 'dark' ? 'light' : 'dark'),
    );
    this.refs.languageSelect.addEventListener('change', (event) => {
      const value = (event.target as HTMLSelectElement).value;
      const language = LANGUAGES.find((code) => code === value);
      if (language) this.store.set('language', language);
    });
    this.refs.fontSizeRange.addEventListener('input', (event) =>
      this.store.set('fontSize', Number((event.target as HTMLInputElement).value)),
    );
    this.refs.decrease.addEventListener('click', () => stepFont(-FONT_SIZE.step));
    this.refs.increase.addEventListener('click', () => stepFont(FONT_SIZE.step));
    this.refs.reset.addEventListener('click', () => this.store.reset());
    this.refs.openTab.addEventListener('click', () => window.open(location.href, '_blank'));
    this.refs.reloadButton.addEventListener('click', () => location.reload());
    this.refs.raceButton.addEventListener('click', () => {
      const button = this.refs.raceButton as HTMLButtonElement;
      button.disabled = true;
      setTimeout(() => (button.disabled = false), RACE_DELAY_MS + 400);
      this.store.startRace();
    });
  }

  private onStoreEvent(event: StoreEvent): void {
    switch (event.type) {
      case 'change':
        this.addLog(
          event.source === 'local' ? 'logLocal' : event.source === 'remote' ? 'logRemote' : 'logStorage',
          { tab: event.source === 'local' ? this.store.tabId : event.from, keys: event.keys },
        );
        if (event.source !== 'local') this.highlight(event.keys);
        if (event.source === 'remote' && event.from) this.showToast(event.from, event.keys);
        break;
      case 'conflict':
        this.addLog('logConflict', { tab: event.from, keys: event.keys });
        break;
      case 'latency':
        this.lastLatency = event.ms;
        this.latencies.push(event.ms);
        if (this.latencies.length > MAX_LATENCY_SAMPLES) this.latencies.shift();
        break;
      case 'peers':
        event.joined.forEach((tab) => this.addLog('logJoined', { tab }));
        event.left.forEach((tab) => this.addLog('logLeft', { tab }));
        break;
      case 'race':
        this.addLog('logRace', { tab: event.from });
        break;
    }
    this.scheduleRender();
  }

  /** Coalesces the events of one task (change, peers, latency…) into a single render. */
  private scheduleRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    queueMicrotask(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  private addLog(message: MessageKey, details: Omit<LogEntry, 'time' | 'message'>): void {
    this.log.unshift({ time: new Date(), message, ...details });
    if (this.log.length > MAX_LOG_ENTRIES) this.log.pop();
  }

  /** Briefly outlines settings that another tab just changed. */
  private highlight(keys: PrefKey[]): void {
    for (const key of keys) {
      const row = this.root.querySelector(`[data-setting="${key}"]`);
      if (row) replayClass(row, 'flash');
    }
  }

  /** One toast per tab and field set: a slider drag updates the same toast instead of stacking. */
  private showToast(tab: string, keys: PrefKey[]): void {
    const signature = `${tab}:${[...keys].sort().join(',')}`;
    let toast = this.toasts.find((item) => item.signature === signature);
    if (toast) {
      clearTimeout(toast.timer);
    } else {
      const node = el('div', 'toast');
      const text = el('span', 'toast-text');
      const close = el('button', 'toast-close');
      close.type = 'button';
      close.innerHTML = icons.close;
      node.append(tabDot(tab), text, close);
      toast = { node, text, close, tab, keys, signature, timer: 0 as unknown as ReturnType<typeof setTimeout> };
      const created = toast;
      close.addEventListener('click', () => this.dismissToast(created));
      this.toasts.push(toast);
      this.refs.toasts.append(node);
      if (this.toasts.length > MAX_TOASTS) this.dismissToast(this.toasts[0]);
    }
    const current = toast;
    current.timer = setTimeout(() => this.dismissToast(current), TOAST_MS);
  }

  private dismissToast(toast: Toast): void {
    clearTimeout(toast.timer);
    const index = this.toasts.indexOf(toast);
    if (index >= 0) this.toasts.splice(index, 1);
    toast.node.classList.add('toast-leaving');
    toast.node.addEventListener('animationend', () => toast.node.remove(), { once: true });
    // Fallback when animations are disabled (reduced motion).
    setTimeout(() => toast.node.remove(), 400);
  }

  private syncState(): SyncState {
    const peers = this.store.peerStates;
    if (peers.length === 0) return 'alone';
    if (peers.every((peer) => peer.inSync)) {
      this.mismatchSince = undefined;
      return 'synced';
    }
    const now = performance.now();
    this.mismatchSince ??= now;
    const remaining = SYNCING_GRACE_MS - (now - this.mismatchSince);
    if (remaining <= 0) return 'syncing';
    clearTimeout(this.graceTimer);
    this.graceTimer = setTimeout(() => this.render(), remaining + 10);
    return 'synced';
  }

  private render(): void {
    const prefs = this.prefs;
    applyToDocument(prefs);
    document.title = this.t('appTitle');

    this.root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((node) => {
      node.textContent = this.t(node.dataset.i18n as MessageKey);
    });

    const isDark = prefs.theme === 'dark';
    this.refs.themeSwitch.setAttribute('aria-checked', String(isDark));
    (this.refs.languageSelect as HTMLSelectElement).value = prefs.language;
    (this.refs.fontSizeRange as HTMLInputElement).value = String(prefs.fontSize);
    this.refs.fontSizeOutput.textContent = `${prefs.fontSize}px`;
    (this.refs.decrease as HTMLButtonElement).disabled = prefs.fontSize <= FONT_SIZE.min;
    (this.refs.increase as HTMLButtonElement).disabled = prefs.fontSize >= FONT_SIZE.max;
    this.refs.decrease.setAttribute('aria-label', this.t('decrease'));
    this.refs.increase.setAttribute('aria-label', this.t('increase'));
    this.refs.decrease.title = this.t('decrease');
    this.refs.increase.title = this.t('increase');

    this.refs.previewTheme.textContent = this.t(isDark ? 'dark' : 'light');
    this.refs.previewLanguage.textContent = LANGUAGE_NAMES[prefs.language];
    this.refs.previewSize.textContent = `${prefs.fontSize}px`;

    for (const toast of this.toasts) {
      toast.text.textContent = this.t('logRemote', { tab: toast.tab, keys: this.fieldNames(toast.keys) });
      toast.close.setAttribute('aria-label', this.t('dismiss'));
    }

    this.refs.updateBanner.hidden = !this.store.newerBuildAvailable;
    this.renderStatus();
    this.renderLatency();
    this.renderDetails();
    this.renderLog();
  }

  private renderStatus(): void {
    const state = this.syncState();
    const peers = this.store.peerStates;
    const count = String(peers.length + 1);
    const titles: Record<SyncState, MessageKey> = {
      alone: 'statusAlone',
      synced: 'statusSynced',
      syncing: 'statusSyncing',
    };

    this.refs.presence.dataset.state = state;
    this.refs.presenceLabel.textContent =
      state === 'alone' ? this.t('openTabsCount', { count }) : `${this.t(titles[state])} · ${count}`;

    this.refs.statusHero.dataset.state = state;
    this.refs.statusIcon.innerHTML = state === 'alone' ? icons.tabs : state === 'synced' ? icons.check : icons.sync;
    this.refs.statusTitle.textContent = this.t(titles[state]);
    this.refs.statusDetail.textContent =
      state === 'alone' ? this.t('aloneHint') : this.t('openTabsCount', { count });

    const chip = (id: string, label: string, ok: boolean, self = false) => {
      const item = el('li', `tab-chip${self ? ' tab-chip-self' : ''}`);
      item.append(tabDot(id), el('span', 'mono', label));
      const mark = el('span', `tab-chip-state ${ok ? 'ok' : 'pending'}`);
      mark.innerHTML = ok ? icons.check : icons.sync;
      item.append(mark);
      return item;
    };
    this.refs.tabList.setAttribute('aria-label', this.t('connectedTabs'));
    this.refs.tabList.replaceChildren(
      chip(this.store.tabId, `${this.store.tabId} (${this.t('you')})`, true, true),
      ...peers.map((peer) => chip(peer.id, peer.id, peer.inSync || state === 'synced')),
    );
  }

  private renderLatency(): void {
    const samples = this.latencies;
    // Latency is measured by the tab that sends a change, so a tab that has
    // only received changes has nothing to show yet: say so instead of dashes.
    this.refs.metrics.hidden = samples.length === 0;
    this.refs.metricsEmpty.hidden = samples.length > 0;
    const set = (ref: string, ms: number | undefined) => {
      const node = this.refs[ref];
      node.textContent = ms === undefined ? this.t('noSamples') : `${ms < 10 ? ms.toFixed(2) : ms.toFixed(1)} ms`;
      node.dataset.ok = ms === undefined ? '' : String(ms < LATENCY_TARGET_MS);
    };
    set('latencyLast', this.lastLatency);
    set('latencyAvg', samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : undefined);
    set('latencyMax', samples.length ? Math.max(...samples) : undefined);
  }

  private renderDetails(): void {
    this.refs.tabId.textContent = this.store.tabId;
    this.refs.transport.textContent = this.store.transportKind;
    this.refs.fingerprint.textContent = this.store.fingerprint;

    const doc = this.store.document;
    this.refs.clockRows.replaceChildren(
      ...PREF_KEYS.map((key) => {
        const { value, ts } = doc[key];
        const row = el('tr');
        const writer = el('td', 'mono');
        if (ts.node === '') writer.textContent = this.t('defaultWriter');
        else writer.append(tabDot(ts.node), ts.node === this.store.tabId ? this.t('you') : ts.node);
        row.append(
          el('td', undefined, this.t(FIELD_LABELS[key])),
          el('td', 'mono', String(value)),
          writer,
          el('td', 'mono', ts.wall ? `${ts.wall}.${ts.counter}` : '0'),
        );
        return row;
      }),
    );
  }

  private renderLog(): void {
    const list = this.refs.log;
    if (this.log.length === 0) {
      list.replaceChildren(el('li', 'log-empty', this.t('emptyLog')));
      return;
    }
    const timeFormat = new Intl.DateTimeFormat(this.prefs.language, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    list.replaceChildren(
      ...this.log.map((entry) => {
        const item = el('li', `log-item log-${entry.message}`);
        const tab = entry.tab === this.store.tabId ? this.t('you') : entry.tab ?? '';
        const marker = entry.tab ? tabDot(entry.tab) : el('span', 'tab-dot tab-dot-none');
        item.append(
          el('time', 'log-time mono', timeFormat.format(entry.time)),
          marker,
          el('span', 'log-text', this.t(entry.message, { tab, keys: this.fieldNames(entry.keys ?? []) })),
        );
        return item;
      }),
    );
  }
}
