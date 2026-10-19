import './styles.css';
import { LocalStoragePersistence } from './persistence';
import { defaultPreferences } from './preferences';
import { SyncedPreferences } from './store';
import { createTransport } from './transport';
import { SettingsView } from './ui';

// Fresh id per page load (not sessionStorage, which duplicated tabs copy).
const tabId = crypto.randomUUID().slice(0, 8);

const store = new SyncedPreferences({
  tabId,
  transport: createTransport(),
  persistence: new LocalStoragePersistence(),
  defaults: defaultPreferences(),
});

new SettingsView(document.getElementById('app')!, store);
store.start();

window.addEventListener('pagehide', () => store.stop());
window.addEventListener('pageshow', (event) => {
  if (event.persisted) store.resync();
});
document.addEventListener('visibilitychange', () => {
  // Peers allow background tabs a much longer heartbeat gap, so tell them now.
  store.announce();
  if (document.visibilityState === 'visible') store.resync();
});

// Enable colour transitions only after the first frame, so the initial
// theme is painted directly instead of animating in.
requestAnimationFrame(() => requestAnimationFrame(() => document.documentElement.classList.add('ready')));

// Exposed for the end-to-end tests and for poking around in DevTools.
declare global {
  interface Window {
    tabSync: SyncedPreferences;
  }
}
window.tabSync = store;
