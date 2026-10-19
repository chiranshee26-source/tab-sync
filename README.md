# Tab Sync Settings

A TypeScript web app that keeps user preferences (dark mode, language, font size) in sync across every open browser tab in real time, persists them across sessions, and resolves simultaneous edits deterministically.

**Live demo:** https://chiranshee26-source.github.io/tab-sync/ (open it in two or more tabs side by side)

- **Dark-mode toggle**, **language selector** (English, Español, Français, Deutsch, हिन्दी, 日本語, العربية, with right-to-left layout for Arabic) and **font-size slider** (12–24 px)
- Changes reach other tabs in **~1 ms** via `BroadcastChannel` (target: < 100 ms). Each tab shows measured latency
- Preferences **persist** in `localStorage` and are restored on reopen
- **No flash of the wrong theme**: an inline boot script applies saved settings before the first paint
- **Deterministic conflict resolution**: a per-field Last-Writer-Wins CRDT ordered by Hybrid Logical Clocks
- Built-in **concurrent-edit test**: every open tab makes conflicting edits at the same instant, and they all still converge
- **Self-healing**: tabs compare state fingerprints on every heartbeat and repair any divergence automatically

### User experience

- **Live sync status**: "All tabs in sync" (green), "Syncing…" (amber) or "Only this tab is open" (with a prompt to open another), in the header and the sync panel
- **Remote-change feedback**: when another tab changes a setting, a toast says which tab changed what, and the affected control briefly highlights. Slider drags update a single toast instead of stacking
- **Colour-coded tabs**: each tab gets a stable colour, used in the tab list, activity log, toasts and field clocks
- **Polished controls**: sun/moon switch, styled language picker, font slider with −/+ buttons and A/A scale, one-click **Reset to defaults**, and a live preview card
- **Progressive disclosure**: fingerprint, transport and per-field clocks sit in a collapsible "Technical details" section
- **Accessible and responsive**: keyboard and screen-reader friendly (`role="switch"`, live regions, labelled buttons), right-to-left layout for Arabic, phone-sized layouts, `prefers-reduced-motion` respected

No framework, no runtime dependencies: Vite + TypeScript (strict). Vitest for unit tests, Playwright for multi-tab end-to-end tests.

## Getting started

Requires Node.js 18+ (22 recommended).

```bash
npm install
npm run dev          # http://localhost:5173, open it in several tabs
```

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server with hot reload |
| `npm run build` | Type-check and build to `dist/` |
| `npm run preview` | Serve the production build |
| `npm test` | Unit tests (clock, CRDT laws, multi-tab simulation) |
| `npm run test:e2e` | Playwright tests with real tabs (run `npx playwright install chromium` once) |
| `npm run typecheck` | `tsc` only |

## Try it

1. Open the app in two or three tabs (or click **Open another tab**) and put them side by side.
2. Toggle dark mode, switch language or drag the font-size slider. Every tab follows immediately; the **Synchronization** panel shows latency and which tab wrote each field.
3. Click **Run concurrent-edit test**. All tabs make conflicting edits at the same moment. The activity log shows the older edits being discarded, and the **state fingerprint** is identical in every tab afterwards.
4. Close every tab and reopen the app. Your last settings are back, with no flash of the default theme.

## Technical explanation

### Architecture

```
src/
├── preferences.ts  Schema: fields, allowed values, defaults, validators, applyToDocument()
├── clock.ts        Hybrid Logical Clock + total ordering of timestamps
├── lww.ts          LWW-map CRDT: merge, validation, canonical serialization, fingerprint
├── transport.ts    BroadcastChannel transport (storage-event fallback) + message validation
├── persistence.ts  localStorage read-merge-write under a Web Lock
├── store.ts        SyncedPreferences: ties clock, CRDT, transport and persistence together
├── boot.ts         Inlined into <head> at build time; applies saved prefs before first paint
├── ui.ts / i18n.ts View layer and translations
└── main.ts         Wiring and page lifecycle (pagehide, pageshow, visibilitychange)
```

The sync engine (`store.ts` and below) has no DOM dependency apart from injected adapters, so the unit tests run several "tabs" against a simulated message bus that can reorder and delay messages.

### Synchronization

Each tab owns a full replica of the preference document. A local edit is stamped, applied, then:

1. **Broadcast** as an `update` message on a `BroadcastChannel`. This is an in-memory, same-origin message bus, so delivery takes about a millisecond, well under the 100 ms target. Every receiver answers with an `ack` echoing the update's send time, and the sender displays half the round trip as the latency. Both timestamps come from the sender's own monotonic clock, so the figure stays correct even when tabs' clocks disagree (e.g. after laptop sleep or an NTP correction). Browsers without `BroadcastChannel` fall back to the `storage` event.
2. **Persisted** to `localStorage` with a *read-merge-write* cycle: the stored document is merged with the in-memory one before saving, so a tab can never overwrite a newer value written by another tab. Where the Web Locks API is available, the cycle runs under a cross-tab lock. Rapid edits (slider drags) are coalesced into one write per task.

Several mechanisms make delivery robust:

- **Handshake.** A newly opened tab sends `hello`; peers reply with their full `state`. This covers updates that have not reached storage yet.
- **Anti-entropy.** Every tab also listens for `storage` events, a second, independent path, so a missed broadcast is repaired the next time any tab persists.
- **Resync.** On `visibilitychange` and bfcache restore (`pageshow` with `persisted`), the tab re-reads storage and re-announces itself.
- **Presence.** Heartbeats every second, plus `bye` on `pagehide`, drive the open-tabs counter. Browsers throttle timers in background tabs (Chrome: down to one run per minute after five minutes hidden), so each message says whether its sender is hidden. A silent visible tab is dropped after 3.5 s, a silent background tab only after 90 s. Tabs announce visibility changes immediately. A closed tab sends `bye` and disappears at once either way.
- **Convergence check and self-repair.** Every message carries the sender's state fingerprint. A tab that applies a remote change acknowledges at once with its new fingerprint, so each tab knows whether its peers have converged (that drives the "All tabs in sync" indicator). If a heartbeat reveals a mismatch, the tab replies with its full state. A tab that receives a state lacking something it has sends its own state back once. After that exchange both hold the join of the two states, so the repair always terminates.

All incoming data (messages and storage) is validated field by field. Unknown or corrupt fields are dropped individually, so a tab running an older build, or a hand-edited `localStorage`, cannot break the others.

### Conflict resolution

The document is a **Last-Writer-Wins map CRDT**: each field (`theme`, `language`, `fontSize`) is an independent register `{ value, ts }`. Merging keeps, per field, the entry with the greater timestamp. Simultaneous edits to *different* fields therefore never conflict, because both survive.

Timestamps come from a **Hybrid Logical Clock** (HLC): `(wall, counter, tabId)`.

- `wall` tracks `Date.now()` but never goes backwards; `counter` orders events within the same millisecond.
- When a tab receives a timestamp, it advances its clock past it. An edit made *after* seeing another tab's value therefore always wins over that value, even if the system clock jumps backwards. The intent "I saw X and changed it to Y" is preserved.
- `tabId` (random per page load) breaks exact ties, which makes the order **total**. As a final safeguard, entries with identical timestamps are ordered by value.

Because the merge is **commutative, associative and idempotent**, tabs that have received the same set of updates hold identical state, regardless of delivery order or duplication. That is strong eventual convergence. The unit tests check these laws with randomized property tests, and simulate five tabs making 300 conflicting edits with randomly reordered delivery. The **state fingerprint** (an FNV-1a hash of the canonical document) shown in the UI makes convergence visible.

Defaults (system color scheme, browser language) carry the zero timestamp, so any real user edit, from any tab, wins over them.

### Initialization without a flash

`src/boot.ts` is compiled with esbuild and inlined as a classic `<script>` in `<head>` by a small Vite plugin (`vite.config.ts`). It runs synchronously before the body is parsed. It reads `localStorage`, merges it over the defaults with the same CRDT code the app uses, and sets `data-theme`, `color-scheme`, `lang`, `dir` and the font size on `<html>`. The first paint is therefore already correct. Color transitions are enabled only after the first frame, so the initial theme is never animated in. An end-to-end test asserts that the theme is set before `<body>` exists.

## Tests

- **Unit (Vitest, 23 tests):** HLC monotonicity and causality; merge laws (randomized); delivery-order convergence; validation of corrupt input; store-level propagation, persistence, handshake, skewed clocks, conflict reporting, presence, reset, self-repair after a dropped message, clock-independent latency measurement, and presence for throttled background tabs.
- **End-to-end (Playwright, 8 tests with real Chromium tabs sharing one browser context):** cross-tab propagation under 100 ms; language/RTL/font-size sync through the UI; persistence after closing every tab; no wrong-theme paint on a new tab; four tabs converging after the concurrent-edit test; toast, highlight and "in sync" status; reset across tabs; the single-tab prompt.

## Deployment

`.github/workflows/deploy.yml` runs type-checking, unit and end-to-end tests on every push and pull request, then deploys `dist/` to **GitHub Pages** from `main`. One-time setup: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

The build is fully static, with relative asset paths (`base: './'`), so `dist/` can also be served by Netlify, Vercel, Cloudflare Pages or any static host.

## Browser support

Current Chrome, Edge, Firefox and Safari. `BroadcastChannel` and Web Locks are used when present; otherwise the app falls back to `storage` events and unlocked read-merge-write, which still converges thanks to the CRDT merge.
