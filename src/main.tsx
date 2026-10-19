import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { AppModel, ModelContext } from './app/model';
import { parseRoute, routeToPath } from './app/router';
import { LocalStoragePersistence } from './persistence';
import { defaultPreferences } from './preferences';
import { SyncedStore } from './store';
import { createTransport } from './transport';

// Fresh id per page load (not sessionStorage, which duplicated tabs copy).
const tabId = crypto.randomUUID().slice(0, 8);

const store = new SyncedStore({
  tabId,
  transport: createTransport(),
  persistence: new LocalStoragePersistence(),
  defaults: defaultPreferences(),
  build: __BUILD_TIME__,
});
const model = new AppModel(store);

createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <ModelContext.Provider value={model}>
      <App />
    </ModelContext.Provider>
  </StrictMode>,
);

const currentView = () => routeToPath(parseRoute(location.hash));
store.announce(currentView());
store.start();

// Other tabs show which page each tab has open ("Also open in tab …").
window.addEventListener('hashchange', () => store.announce(currentView()));
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
    tabSync: SyncedStore;
  }
}
window.tabSync = store;
