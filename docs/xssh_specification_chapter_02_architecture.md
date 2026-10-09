# Chapter 02: System Architecture

## 2.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Wails Desktop App                             │
│                                                                     │
│  ┌──────────────────────────┐       ┌────────────────────────────┐ │
│  │  FRONTEND (TS/JS)        │       │  BACKEND (Go)              │ │
│  │                          │       │                            │ │
│  │  ┌────────────────────┐  │       │  ┌──────────────────────┐  │ │
│  │  │ Host Panel         │  │       │  │ Wails App            │  │ │
│  │  │  - host cards      │──┼───────┼─▶│  (binding methods)   │  │ │
│  │  │  - add/edit/delete │  │ JS→Go │  │  OpenTab/Write/     │  │ │
│  │  └────────────────────┘  │       │  │  Resize/CloseTab    │  │ │
│  │                          │       │  └──────────┬───────────┘  │ │
│  │  ┌────────────────────┐  │       │             │               │ │
│  │  │ Tab Panel          │  │       │  ┌──────────▼───────────┐  │ │
│  │  │  - xterm.js x N   │──┼───────┼─▶│ ConnectionManager    │  │ │
│  │  │  - one per tab    │  │       │  │  (sshmgr package)    │  │ │
│  │  └────────────────────┘  │       │  │  - client reuse     │  │ │
│  │                          │       │  │  - session per tab  │  │ │
│  │  Events.on(...) ◀───────┼───────┼──│  - PTY + pump       │  │ │
│  │  (ssh:out:<sid>)        │ Go→JS │  └──────────────────────┘  │ │
│  │                          │       │                            │ │
│  └──────────────────────────┘       │  ┌──────────────────────┐  │ │
│                                     │  │ Store                │  │ │
│                                     │  │  (store package)     │  │ │
│                                     │  │  - EncryptedDB      │  │ │
│                                     │  │  - HostRepo         │  │ │
│                                     │  │  - SettingsRepo     │  │ │
│                                     │  └──────────────────────┘  │ │
│                                     └────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

## 2.2 Module Boundaries

| Module | Responsibility | Depends On |
|--------|---------------|------------|
| `internal/store` | Encrypted SQLite: open/close, key derivation, CRUD for hosts & settings | `ncruces/go-sqlite3`, `crypto/*` |
| `internal/sshmgr` | SSH connection management: client reuse, session lifecycle, PTY, I/O pump | `golang.org/x/crypto/ssh`, `store` |
| `app.go` (root) | Wails App struct: binding methods that the frontend calls; wires `store` + `sshmgr` | `store`, `sshmgr`, `wails` |
| `main.go` (root) | Wails bootstrap, window config, startup sequence | `app.go`, `wails` |
| `frontend/` | UI rendering: host cards, tab management, xterm.js instances, I/O coalescing | Wails JS runtime (auto-generated bindings) |

### Dependency Rule

```
frontend  →  app.go  →  sshmgr  →  store
             (Wails)   (SSH)    (DB)
```

No reverse dependencies. `store` knows nothing about SSH; `sshmgr` reads host config from `store` but never writes to it (only the Wails layer does, via `HostRepo`).

## 2.3 Concurrency Model

```
Goroutine Layout at Runtime:

main goroutine
 └── Wails event loop
      ├── App.OpenTab() → spawns pump goroutines
      │    ├── pump stdout goroutine (per session)
      │    └── pump stderr goroutine (per session)
      ├── App.Write()   → synchronous write to session stdin
      ├── App.Resize()  → synchronous WindowChange request
      └── App.CloseTab() → closes session, pump goroutines exit
```

### Concurrency Invariants

1. `ConnectionManager.mu` guards `clients` and `sessions` maps.
2. Each `Session` is safe for concurrent use: `stdin` writes are serialized by `*ssh.Session` internals; pump goroutines read from `stdout`/`stderr` independently.
3. Wails binding methods are called from a single goroutine (the Wails event loop), so `App` methods don't need their own locking beyond what `sshmgr` provides.
4. On tab close: close stdin pipe → pump goroutines detect EOF → exit → no leaks.

## 2.4 Data Flow

### Opening a Tab

```
User clicks host card
  → frontend calls App.OpenTab(hostID, cols, rows)
    → Go: look up Host from store
    → Go: get-or-create *ssh.Client for that host
    → Go: open *ssh.Session, request PTY, start Shell()
    → Go: register Session in Manager, start pump goroutines
    → Go: write initial commands to stdin (if configured)
    → Go: return new sessionID to frontend
  → frontend creates xterm.js instance, subscribes to Events
```

### Terminal I/O (Steady State)

```
User types in xterm.js
  → term.onData(data) → btoa(data) → App.Write(sid, b64)
    → Go: base64 decode → Session.stdin.Write(bytes)

Remote sends output
  → pump goroutine reads stdout → base64 encode
    → runtime.EventsEmit(ctx, "ssh:out:"+sid, b64)
      → frontend Events.on("ssh:out:"+sid) → atob(payload)
        → requestAnimationFrame → term.write(decoded)
```

### Closing a Tab

```
User clicks tab close button
  → App.CloseTab(sid)
    → Go: close Session.stdin
    → Go: Session.sess.Close()
    → Go: remove from Manager.sessions
    → pump goroutines detect EOF → exit
  → frontend destroys xterm.js instance, removes tab DOM
```

## 2.5 Startup Sequence

```
main.go
  → wails.Run(App: &App{...})
    → App.Startup(ctx)
      → resolve data directory (platform-specific)
      → check if DB file exists
        → NO: show "set passphrase" UI → create DB with key
        → YES: show "enter passphrase" UI → unlock DB
      → load hosts from store → emit initial host list to frontend
      → ready
```

## 2.6 Shutdown Sequence

```
App.Shutdown(ctx)
  → close all sessions (for each sessionID in Manager)
  → close all *ssh.Client connections
  → close SQLite DB
  → zero the in-memory key (optional, best-effort)
```
