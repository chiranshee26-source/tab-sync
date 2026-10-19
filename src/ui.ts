import { LANGUAGE_NAMES, translate, type MessageKey } from './i18n';
import { fingerprint } from './lww';
import { applyToDocument, FONT_SIZE, LANGUAGES, PREF_KEYS, type PrefKey, type Preferences } from './preferences';
import type { StoreEvent, SyncedPreferences } from './store';

const FIELD_LABELS: Record<PrefKey, MessageKey> = { theme: 'darkMode', language: 'language', fontSize: 'fontSize' };
const MAX_LOG_ENTRIES = 50;
const MAX_LATENCY_SAMPLES = 200;

interface LogEntry {
  time: Date;
  message: MessageKey;
  tab?: string;
  keys?: PrefKey[];
}

const SHELL = /* html */ `
  <header class="app-header">
    <div>
      <h1 data-i18n="appTitle"></h1>
      <p class="subtitle" data-i18n="appSubtitle"></p>
    </div>
    <div class="presence" aria-live="polite">
      <span class="presence-dot"></span>
      <span data-ref="presenceCount"></span>
    </div>
  </header>

  <main class="grid">
    <section class="card" aria-labelledby="prefs-heading">
      <h2 id="prefs-heading" data-i18n="preferences"></h2>

      <div class="setting">
        <div class="setting-text">
          <span class="setting-label" id="dark-label" data-i18n="darkMode"></span>
          <span class="setting-hint" data-i18n="darkModeHint"></span>
        </div>
        <button type="button" class="switch" role="switch" aria-labelledby="dark-label" data-ref="themeSwitch">
          <span class="switch-thumb"></span>
        </button>
      </div>

      <div class="setting">
        <div class="setting-text">
          <label class="setting-label" for="language" data-i18n="language"></label>
          <span class="setting-hint" data-i18n="languageHint"></span>
        </div>
        <select id="language" class="select" data-ref="languageSelect"></select>
      </div>

      <div class="setting setting-stacked">
        <div class="setting-row">
          <div class="setting-text">
            <label class="setting-label" for="font-size" data-i18n="fontSize"></label>
            <span class="setting-hint" data-i18n="fontSizeHint"></span>
          </div>
          <output for="font-size" class="badge" data-ref="fontSizeOutput"></output>
        </div>
        <input id="font-size" type="range" class="range" data-ref="fontSizeRange"
          min="${FONT_SIZE.min}" max="${FONT_SIZE.max}" step="${FONT_SIZE.step}" />
      </div>

      <div class="preview">
        <span class="eyebrow" data-i18n="preview"></span>
        <p data-i18n="previewText"></p>
      </div>
    </section>

    <section class="card" aria-labelledby="sync-heading">
      <h2 id="sync-heading" data-i18n="syncStatus"></h2>
      <dl class="stats">
        <div><dt data-i18n="thisTab"></dt><dd class="mono" data-ref="tabId"></dd></div>
        <div><dt data-i18n="connectedTabs"></dt><dd data-ref="peerList"></dd></div>
        <div><dt data-i18n="transport"></dt><dd class="mono compact" data-ref="transport"></dd></div>
        <div><dt data-i18n="lastLatency"></dt><dd class="mono" data-ref="latencyLast"></dd></div>
        <div><dt data-i18n="avgLatency"></dt><dd class="mono" data-ref="latencyAvg"></dd></div>
        <div><dt data-i18n="maxLatency"></dt><dd class="mono" data-ref="latencyMax"></dd></div>
      </dl>

      <div class="fingerprint">
        <span class="eyebrow" data-i18n="fingerprint"></span>
        <code data-ref="fingerprint" data-testid="fingerprint"></code>
        <span class="setting-hint" data-i18n="fingerprintHint"></span>
      </div>

      <div class="actions">
        <button type="button" class="button" data-ref="openTab" data-i18n="openTab"></button>
        <button type="button" class="button button-primary" data-ref="raceButton" data-i18n="raceTest"></button>
      </div>
      <p class="setting-hint" data-i18n="raceHint"></p>

      <h3 data-i18n="clocks"></h3>
      <div class="table-wrap">
        <table class="clocks">
          <thead><tr><th data-i18n="field"></th><th data-i18n="value"></th><th data-i18n="writer"></th><th>HLC</th></tr></thead>
          <tbody data-ref="clockRows"></tbody>
        </table>
      </div>
    </section>

    <section class="card card-wide" aria-labelledby="activity-heading">
      <h2 id="activity-heading" data-i18n="activity"></h2>
      <ol class="log" data-ref="log" aria-live="polite"></ol>
    </section>
  </main>
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class SettingsView {
  private readonly refs: Record<string, HTMLElement> = {};
  private readonly log: LogEntry[] = [];
  private readonly latencies: number[] = [];
  private lastLatency?: number;

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
    this.refs.openTab.addEventListener('click', () => window.open(location.href, '_blank'));
    this.refs.raceButton.addEventListener('click', () => this.store.startRace());
  }

  private onStoreEvent(event: StoreEvent): void {
    switch (event.type) {
      case 'change':
        this.addLog(
          event.source === 'local' ? 'logLocal' : event.source === 'remote' ? 'logRemote' : 'logStorage',
          { tab: event.from, keys: event.keys },
        );
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
        this.addLog('logRace', { tab: event.from === this.store.tabId ? this.t('you') : event.from });
        break;
    }
    this.render();
  }

  private addLog(message: MessageKey, details: Omit<LogEntry, 'time' | 'message'>): void {
    this.log.unshift({ time: new Date(), message, ...details });
    if (this.log.length > MAX_LOG_ENTRIES) this.log.pop();
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
    this.refs.themeSwitch.title = this.t(isDark ? 'dark' : 'light');
    (this.refs.languageSelect as HTMLSelectElement).value = prefs.language;
    (this.refs.fontSizeRange as HTMLInputElement).value = String(prefs.fontSize);
    this.refs.fontSizeOutput.textContent = `${prefs.fontSize}px`;

    this.renderStats();
    this.renderClocks();
    this.renderLog();
  }

  private renderStats(): void {
    const peers = this.store.peerIds;
    this.refs.tabId.textContent = this.store.tabId;
    this.refs.presenceCount.textContent = `${peers.length + 1}`;
    this.refs.peerList.replaceChildren(
      ...(peers.length ? peers.map((id) => el('span', 'chip mono', id)) : [document.createTextNode('0')]),
    );
    this.refs.transport.textContent = this.store.transportKind;

    const format = (ms: number | undefined) => (ms === undefined ? this.t('noSamples') : `${ms.toFixed(2)} ms`);
    const samples = this.latencies;
    this.refs.latencyLast.textContent = format(this.lastLatency);
    this.refs.latencyAvg.textContent = format(
      samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : undefined,
    );
    this.refs.latencyMax.textContent = format(samples.length ? Math.max(...samples) : undefined);
    this.refs.fingerprint.textContent = fingerprint(this.store.document);
  }

  private renderClocks(): void {
    const doc = this.store.document;
    this.refs.clockRows.replaceChildren(
      ...PREF_KEYS.map((key) => {
        const { value, ts } = doc[key];
        const row = el('tr');
        const writer = ts.node === '' ? this.t('defaultWriter') : ts.node === this.store.tabId ? this.t('you') : ts.node;
        row.append(
          el('td', undefined, this.t(FIELD_LABELS[key])),
          el('td', 'mono', String(value)),
          el('td', 'mono', writer),
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
        const keys = (entry.keys ?? []).map((key) => this.t(FIELD_LABELS[key])).join(', ');
        const item = el('li', `log-item log-${entry.message}`);
        item.append(
          el('time', 'log-time mono', timeFormat.format(entry.time)),
          el('span', undefined, this.t(entry.message, { tab: entry.tab ?? '', keys })),
        );
        return item;
      }),
    );
  }
}
