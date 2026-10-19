# Daybook

Daybook is a personal workspace that combines **tasks, a reading list, notes and a diary**. You can open any part of it in as many browser tabs as you like: preferences and data stay in sync across every tab in real time, survive closing the browser, and resolve simultaneous edits deterministically.

**Live demo:** https://chiranshee26-source.github.io/tab-sync/ (open it in two or more tabs side by side)

It was built for the *Multi-Tab Settings Synchronization* task. The required preferences (a **dark-mode toggle**, a **language selector** and a **font-size slider**) live under *Settings & sync*. The same sync engine also carries all the user's data, which gives the app a real reason to be open in several tabs.

## What you can do

| Section | Features |
| --- | --- |
| **Today** | Greeting and date, today's diary entry, open tasks with quick add, what you're reading, recent notes |
| **Tasks** | Add tasks with optional due dates, tick them off, overdue and due-today badges, inline editing, clear completed |
| **Reading list** | Save articles or books (with optional links), move them through *To read → Reading → Finished*, filter by status |
| **Notes** | Searchable list and editor; **open any note in its own tab**; see "Also open in tab …" when another tab has it open |
| **Diary** | One page per day with a mood picker, previous/next-day navigation, and a list of past entries |
| **Settings & sync** | Dark mode, 7 languages (English, Español, Français, Deutsch, हिन्दी, 日本語, العربية with right-to-left layout), font size 12–24 px, reset to defaults; live sync status, latency, open tabs and what each is viewing, concurrent-edit test, activity log |

Sync is visible in the UI:
- When another tab changes something, a toast names the tab, and the changed item briefly highlights.
- The sidebar pill reads *All tabs in sync*.
- If you're typing in a note or diary entry that another tab edits, your cursor stays where it was.

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
| `npm test` | Unit tests (clock, CRDT laws, multi-tab simulation, caret logic) |
| `npm run test:e2e` | Playwright tests with real tabs (run `npx playwright install chromium` once) |
| `npm run typecheck` | `tsc` only |

Stack: TypeScript (strict), React 18, Vite. The sync engine has no dependencies. Vitest and Playwright for tests.

## Technical explanation

### Architecture

```
src/
├── preferences.ts  Preference fields, defaults, validators, applyToDocument()
├── schema.ts       Record kinds (prefs, task, reading, note, diary), field validators, ids
├── clock.ts        Hybrid Logical Clock + total ordering of timestamps
├── lww.ts          LWW-map CRDT over records: merge, validation, serialization, fingerprint
├── transport.ts    BroadcastChannel transport (storage-event fallback) + message validation
├── persistence.ts  localStorage read-merge-write under a Web Lock; v1 → v2 migration
├── store.ts        SyncedStore: clock + CRDT + transport + persistence + presence
├── boot.ts         Inlined into <head> at build time; applies saved prefs before first paint
├── i18n.ts         116 strings × 7 languages (type-checked for completeness)
├── main.tsx        Wiring and page lifecycle (pagehide, pageshow, visibilitychange, routing)
└── app/            React UI: model (toasts, log, latency, status), router, pages, components
```

The sync engine (`store.ts` and below) does not depend on React or the DOM; the browser pieces are passed in as adapters. The unit tests run several "tabs" against a simulated message bus that can reorder, delay and drop messages.

### Data model

Everything lives in one document, a map of **records**:

```
prefs                → { theme, language, fontSize }
task:<id>            → { title, done, due, createdAt, deleted }
reading:<id>         → { title, url, status, createdAt, deleted }
note:<id>            → { title, body, createdAt, updatedAt, deleted }
diary:<YYYY-MM-DD>   → { body, mood, updatedAt }
```

Every **field** of every record is an independent register `{ value, ts }`.
- Two tabs editing *different* fields of the same item never conflict. For example, one tab ticks a task while another renames it, and both changes survive.
- Deleting is a field write (`deleted: true`, a tombstone), so a delete and a concurrent edit are ordered like any other two writes.
- Diary records are keyed by date, so two tabs that both start writing "today" edit the same entry instead of creating duplicates.

### Synchronization

Each tab owns a full replica of the document. A local edit is stamped, applied, then:

1. **Broadcast** as an `update` message containing only the changed fields, on a `BroadcastChannel`. This is an in-memory, same-origin message bus, so delivery takes a few milliseconds, well under the 100 ms target. Every receiver answers with an `ack` echoing the update's send time, and the sender displays half the round trip as the latency. Both timestamps come from the sender's own monotonic clock, so the figure stays correct even when tabs' clocks disagree (e.g. after laptop sleep or an NTP correction). Browsers without `BroadcastChannel` fall back to the `storage` event.
2. **Persisted** to `localStorage` with a *read-merge-write* cycle: the stored document is merged with the in-memory one before saving, so a tab can never overwrite a newer value written by another tab. Where the Web Locks API is available, the cycle runs under a cross-tab lock. Bursts (typing, slider drags) are coalesced into one write per task.

Several mechanisms make delivery robust:

- **Handshake.** A newly opened tab sends `hello`; peers reply with their full `state`. This covers updates that have not reached storage yet.
- **Anti-entropy.** Every tab also listens for `storage` events, a second, independent path.
- **Convergence check and self-repair.** Every message carries the sender's state fingerprint. A tab that applies a remote change acknowledges at once with its new fingerprint, which drives the *All tabs in sync* indicator. If a heartbeat reveals a mismatch, the tab replies with its full state. A tab that receives a state lacking something it has sends its own state back once. After that exchange both hold the join of the two states, so the repair always terminates.
- **Presence.** Heartbeats every second, plus `bye` on `pagehide`, track open tabs and which page each shows (so a note can say "Also open in tab …"). Browsers throttle timers in background tabs, so a silent visible tab is dropped after 3.5 s but a silent background tab only after 90 s.
- **Mixed versions.** Messages carry the sender's build time. A tab left open across a deploy shows *A newer version is open in another tab* with a Reload button. Full-state repair runs only between tabs on the same build.

All incoming data (messages and storage) is validated per record and per field against the schema. Unknown or corrupt values are dropped individually.

### Conflict resolution

The document is a **Last-Writer-Wins map CRDT**: for each `(record, field)` pair, the merge keeps the entry with the greater timestamp.

Timestamps come from a **Hybrid Logical Clock** (HLC): `(wall, counter, tabId)`.
- `wall` tracks `Date.now()` but never goes backwards; `counter` orders events within the same millisecond.
- When a tab receives a timestamp, it advances its clock past it. An edit made *after* seeing another tab's value therefore always wins over that value, even if the system clock jumps backwards. The intent "I saw X and changed it to Y" is preserved.
- `tabId` (random per page load) breaks exact ties, which makes the order **total**. As a final safeguard, entries with identical timestamps are ordered by value.

Because the merge is **commutative, associative and idempotent**, tabs that have received the same set of updates hold identical state, regardless of delivery order or duplication. That is strong eventual convergence. The unit tests check these laws with randomized property tests, and simulate five tabs making 300 conflicting edits with randomly reordered delivery. The **state fingerprint** in *Settings & sync → Technical details* makes convergence visible, and the **concurrent-edit test** button makes every open tab change the same settings at the same instant.

**Text fields.** A note's body is one register, so if two tabs type into the *same* note at the *same* moment, the most recent keystroke's text wins (both tabs still converge). The UI keeps this rare in practice: it shows which other tabs have the note open, and remote edits keep your cursor in place. Character-level merging would need a sequence CRDT (e.g. Yjs), which is the natural next step.

### Initialization without a flash

`src/boot.ts` is compiled with esbuild and inlined as a classic `<script>` in `<head>` by a small Vite plugin (`vite.config.ts`). It runs synchronously before the body is parsed. It reads `localStorage`, migrating the first version's format if needed, merges it over the defaults with the same CRDT code the app uses, and sets `data-theme`, `color-scheme`, `lang`, `dir` and the font size on `<html>`. The first paint is therefore already correct. Color transitions are enabled only after the first frame. An end-to-end test asserts that the theme is set before `<body>` exists.

## Tests

- **Unit (Vitest, 35 tests):**
  - HLC monotonicity and causality
  - CRDT merge laws (randomized), delivery-order convergence, tombstones
  - Validation and v1 migration
  - Store-level sync of preferences, tasks, notes and the diary
  - Persistence, handshake, skewed clocks, conflict reporting, presence (including throttled background tabs and per-tab views)
  - Self-repair after a dropped message, round-trip latency, version detection
  - Caret adjustment
- **End-to-end (Playwright, 12 tests with real Chromium tabs sharing one browser context):**
  - Propagation under 100 ms
  - Language/RTL/font-size sync through the UI
  - Persistence of preferences and data after closing every tab
  - No wrong-theme paint
  - v1 migration
  - Four tabs converging after the concurrent-edit test
  - Diary entries merging
  - Tasks syncing
  - Live note editing with the cursor preserved
  - Toasts, highlight and in-sync status
  - Reset across tabs
  - Lone-tab prompt and latency display

## Deployment

`.github/workflows/deploy.yml` runs type-checking, unit and end-to-end tests on every push and pull request, then deploys `dist/` to **GitHub Pages** from `main`. One-time setup: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

The build is fully static, with relative asset paths and hash routing, so it works from any host or sub-path.

## Browser support and limits

- Works in current Chrome, Edge, Firefox and Safari.
- Data is stored in the browser (`localStorage`, about 5 MB per site). It syncs between tabs of the **same browser profile and the same address**. It does not sync across devices, browsers, or between private and normal windows.
