# Chapter 05: Frontend Specification

## 5.1 Tech Stack

| Component | Technology |
|-----------|-----------|
| Language | TypeScript (strict mode) |
| Terminal emulator | `@xterm/xterm` v5+ |
| Build tool | Vite |
| UI framework | Vanilla TypeScript (no framework) — Wails provides the window; keep it lightweight |
| CSS | Plain CSS or Tailwind CSS (optional) |

## 5.2 UI Layout

```
┌─────────────────────────────────────────────────────────────┐
│  [xssh title bar]                                           │
├────────────────────┬────────────────────────────────────────┤
│                    │  [Tab 1]  [Tab 2]  [Tab 3]  [+]       │
│  ┌──────────────┐  │────────────────────────────────────────│
│  │ Host Card 1  │  │                                        │
│  │ 🟢 web-01   │  │   xterm.js instance (active tab)        │
│  │ user@10.0.0.1│  │                                        │
│  │              │  │   $ cd /work                            │
│  └──────────────┘  │   $ ls                                  │
│  ┌──────────────┐  │   app/  bin/  docs/                     │
│  │ Host Card 2  │  │                                        │
│  │ 🟣 prod-db  │  │                                        │
│  │ root@10.0.1.5│  │                                        │
│  │              │  │                                        │
│  └──────────────┘  │                                        │
│  ┌──────────────┐  │                                        │
│  │ Host Card 3  │  │                                        │
│  │ 🟡 staging  │  │                                        │
│  │ dev@192.168.1│ │                                        │
│  │              │  │                                        │
│  └──────────────┘  │                                        │
│                    │                                        │
│  [+ Add Host]      │                                        │
│                    │                                        │
│  (left panel:      │                                        │
│   250px, resizable)│                                        │
└────────────────────┴────────────────────────────────────────┘
```

### Layout Rules

| Rule | Detail |
|------|--------|
| Left panel width | Fixed 250 px, resizable via a draggable divider (min 200 px, max 400 px) |
| Tab strip height | 36 px, horizontal scroll if too many tabs |
| Terminal area | Fills remaining space; xterm.js `fit` to container |
| Responsive | On window resize, xterm.js `ResizeObserver` triggers `Resize` to Go |

## 5.3 Host Panel

### 5.3.1 Host Card Rendering

Each host card displays:
- **Color indicator** (6 px left border or dot)
- **Name** (bold, truncated with ellipsis if > 20 chars)
- **Connection info** (user@host:port, smaller font, gray)
- **Edit/Delete** buttons on hover (or a context menu)

### 5.3.2 Host CRUD Operations

| Action | Behavior |
|--------|----------|
| **Add** | Opens a modal form: name, host, port, user, auth type, auth credential, shell, init commands (textarea, one command per line), color picker. Calls `App.SaveHost(host)` → Go persists to DB → refresh list. |
| **Edit** | Clicking a card's edit icon opens the same modal pre-filled. |
| **Delete** | Confirmation dialog → `App.DeleteHost(hostID)` → Go removes from DB + closes all open sessions to that host → refresh list. |
| **Open tab** | Clicking a card (not the edit/delete buttons) calls `App.OpenTab(hostID, cols, rows)` → creates a new tab. |

### 5.3.3 Host List Data

The host list is fetched from Go on startup via `App.GetHosts()`. After any CRUD operation, the frontend either refetches or updates the local array.

## 5.4 Tab Panel

### 5.4.1 Tab Manager

```typescript
interface Tab {
    id: string;          // session ID (ULID)
    hostID: string;
    hostName: string;
    term: Terminal;      // xterm.js instance
    el: HTMLDivElement;  // terminal container div
}

class TabManager {
    private tabs: Map<string, Tab>;
    private activeTabId: string | null;

    createTab(sessionId: string, hostId: string, hostName: string): Tab;
    closeTab(sessionId: string): void;
    switchTab(sessionId: string): void;
    getActiveTab(): Tab | null;
}
```

### 5.4.2 Tab Behavior

| Behavior | Detail |
|----------|--------|
| Click tab | Switch active xterm.js instance (show/hide DOM, or `term.focus()`) |
| Middle-click tab | Close the tab (calls `App.CloseTab(sid)`) |
| `[+]` button | Opens the active host card's new tab |
| Tab title | Displays `hostName` (or first 12 chars); if session ended, shows `(closed)` |
| Multiple tabs to same host | Each gets a new `sessionID` from Go; independent PTY |

### 5.4.3 Session Ended UX

When `ssh:closed:<sid>` event fires:
1. Write `\r\n\x1b[90m[session ended]\x1b[0m\r\n` to the terminal.
2. Mark the tab title with `(closed)`.
3. Optionally show a "Reconnect" button overlay (calls `App.OpenTab` again with same host).

## 5.5 xterm.js Integration

### 5.5.1 Terminal Creation

```typescript
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

function createTerminal(container: HTMLDivElement): { term: Terminal, fit: FitAddon } {
    const term = new Terminal({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        theme: {
            background: "#1e1e1e",
            foreground: "#d4d4d4",
            cursor: "#aeafad",
        },
        allowProposedApi: true,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();

    return { term, fit };
}
```

### 5.5.2 Keystroke → Go

```typescript
term.onData((data: string) => {
    // data is a string of characters (UTF-8 encoded by xterm.js)
    // Encode as base64 for binary safety over Wails events
    const b64 = btoa(unescape(encodeURIComponent(data)));
    App.Write(sessionId, b64);
});
```

> **Note**: `btoa` works on Latin-1. For full Unicode safety with CJK characters, use `btoa(unescape(encodeURIComponent(data)))`.

### 5.5.3 Go → Terminal Output (Coalesced)

```typescript
let pending: string[] = [];
let flushing = false;

function subscribeOutput(sessionId: string, term: Terminal) {
    Events.on(`ssh:out:${sessionId}`, (payload: string) => {
        // payload is base64-encoded bytes
        const binary = atob(payload);
        pending.push(binary);

        if (!flushing) {
            flushing = true;
            requestAnimationFrame(() => {
                term.write(pending.join(""));
                pending = [];
                flushing = false;
            });
        }
    });

    Events.on(`ssh:closed:${sessionId}`, () => {
        term.write("\r\n\x1b[90m[session ended]\x1b[0m\r\n");
    });
}
```

### 5.5.4 Resize

```typescript
const resizeObserver = new ResizeObserver(() => {
    fit.fit();
    App.Resize(sessionId, term.cols, term.rows);
});
resizeObserver.observe(container);
```

### 5.5.5 Cleanup

When a tab is closed:
1. `resizeObserver.disconnect()`
2. `term.dispose()`
3. Remove the container div from the DOM
4. Call `App.CloseTab(sessionId)`

## 5.6 Frontend File Structure

```
frontend/
├── index.html
├── vite.config.ts
├── tsconfig.json
├── package.json
├── vitest.config.ts
└── src/
    ├── main.ts          // Entry point: passphrase → hosts → tabs
    ├── hosts.ts         // Host card rendering, CRUD modals, hosts:updated listener
    ├── tabs.ts          // TabManager: open/close/switch, keyboard nav
    ├── xterm.ts         // createTerminal, wireIO (rAF coalescing, resize, cleanup)
    ├── passphrase.ts    // First-run SetupDB / subsequent-run UnlockDB UI
    ├── types.ts         // Shared TypeScript types (Host, TabEntry, OPEN_TAB_EVENT)
    ├── styles.css       // Dark theme, layout, host cards, tab strip, modal
    └── test/
        └── setup.ts     // Test mocks (Terminal, FitAddon, ResizeObserver, rAF)
```

## 5.7 Wails Generated Bindings

Wails auto-generates TypeScript bindings in `frontend/wailsjs/go/main/App.js` and `frontend/wailsjs/runtime/runtime.js`. These are **not** hand-edited. The frontend imports them as:

```typescript
import { App } from "../wailsjs/go/main/App";
import { Events } from "../wailsjs/runtime/runtime";
```

## 5.8 Performance Requirements

| Metric | Target |
|--------|--------|
| Tab open (DOM + xterm.js init) | < 100 ms |
| Output render (coalesced via rAF) | 60 FPS for 1 MB/s throughput |
| Host list render (50 cards) | < 50 ms |
| Memory per tab | < 20 MB (xterm.js buffer) |

## 5.9 Accessibility

- Tab strip uses `role="tablist"` with keyboard navigation (Left/Right arrows, Enter to activate).
- Host cards are focusable and activatable via Enter/Space.
- Color indicators are supplemented with text (colorblind-friendly).
