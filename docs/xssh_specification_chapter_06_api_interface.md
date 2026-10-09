# Chapter 06: Wails API Interface Contract

## 6.1 Overview

The Wails binding layer is the single communication channel between the Go backend and the TypeScript frontend. This chapter defines every method and event in the contract.

### Principles

1. **JS → Go** uses Wails-bound methods (synchronous calls with return values).
2. **Go → JS** uses Wails events (asynchronous, high-frequency output).
3. **All byte payloads are base64-encoded** to ensure binary safety over the JSON-based Wails bridge.
4. **Method names are PascalCase** (Wails convention for exported Go methods).
5. **Event names are lower-kebab-case** with a domain prefix.

## 6.2 Bound Methods (JS → Go)

### 6.2.1 App Struct

```go
package main

type App struct {
    ctx      context.Context
    store    *store.EncryptedDB
    hosts    *store.HostRepo
    settings *store.SettingsRepo
    mgr      *sshmgr.Manager
    dbPath   string
    salt     []byte
}
```

All methods below are on `*App` and are auto-bound by Wails.

---

### 6.2.2 Method Signatures

| Method | Signature (Go) | Signature (TS) | Description |
|--------|----------------|----------------|-------------|
| `GetHosts` | `func (a *App) GetHosts() ([]store.Host, error)` | `App.GetHosts(): Promise<Host[]>` | Return all host cards |
| `SaveHost` | `func (a *App) SaveHost(h store.Host) error` | `App.SaveHost(h: Host): Promise<void>` | Create or update a host card |
| `DeleteHost` | `func (a *App) DeleteHost(id string) error` | `App.DeleteHost(id: string): Promise<void>` | Delete a host card + close its sessions |
| `OpenTab` | `func (a *App) OpenTab(hostID string, cols, rows int) (string, error)` | `App.OpenTab(hostID: string, cols: number, rows: number): Promise<string>` | Open a new SSH session; returns sessionID |
| `Write` | `func (a *App) Write(sid string, data string) error` | `App.Write(sid: string, data: string): Promise<void>` | Write base64-encoded keystrokes to session stdin |
| `Resize` | `func (a *App) Resize(sid string, cols, rows int) error` | `App.Resize(sid: string, cols: number, rows: number): Promise<void>` | Resize the remote PTY |
| `CloseTab` | `func (a *App) CloseTab(sid string) error` | `App.CloseTab(sid: string): Promise<void>` | Close a session tab |
| `UnlockDB` | `func (a *App) UnlockDB(passphrase string) error` | `App.UnlockDB(passphrase: string): Promise<void>` | Unlock the encrypted DB |
| `SetupDB` | `func (a *App) SetupDB(passphrase string) error` | `App.SetupDB(passphrase: string): Promise<void>` | First-run: set passphrase + create DB |
| `GetSettings` | `func (a *App) GetSettings() (map[string]string, error)` | `App.GetSettings(): Promise<Record<string,string>>` | Get all app settings |
| `SetSetting` | `func (a *App) SetSetting(key, value string) error` | `App.SetSetting(key: string, value: string): Promise<void>` | Set a single app setting |

### 6.2.3 Method Details

#### `OpenTab`

```go
func (a *App) OpenTab(hostID string, cols, rows int) (string, error) {
    // 1. Look up host from store
    h, err := a.hosts.Get(a.ctx, hostID)
    if err != nil {
        return "", fmt.Errorf("get host: %w", err)
    }

    // 2. Define onOut callback that emits Wails event
    onOut := func(data []byte) {
        b64 := base64.StdEncoding.EncodeToString(data)
        runtime.EventsEmit(a.ctx, "ssh:out:"+sid, b64)
    }

    // 3. Open session via sshmgr
    sid, session, err := a.mgr.OpenTab(a.ctx, hostID, *h, uint16(cols), uint16(rows), onOut)
    if err != nil {
        return "", err
    }

    // 4. Return sessionID to frontend
    return sid, nil
}
```

**Return value**: A new ULID string (the session ID). The frontend uses this to:
- Create the xterm.js instance
- Subscribe to `ssh:out:<sid>` and `ssh:closed:<sid>` events
- Pass to `Write`, `Resize`, `CloseTab`

**Error cases**:
- Host not found → `"host not found"`
- SSH dial timeout → `"dial: i/o timeout"`
- Auth failed → `"ssh: unable to authenticate"`
- PTY rejected → session opened in degraded mode (no error, but logged)

#### `Write`

```go
func (a *App) Write(sid string, data string) error {
    // data is base64-encoded keystrokes
    raw, err := base64.StdEncoding.DecodeString(data)
    if err != nil {
        return fmt.Errorf("decode keystrokes: %w", err)
    }

    sess, ok := a.mgr.GetSession(sid)
    if !ok {
        return fmt.Errorf("session %q not found", sid)
    }

    return sess.Write(raw)
}
```

**Note**: This is called on **every keystroke**. It must be fast (< 1 ms overhead). No I/O, no locking beyond the session's internal mutex.

#### `Resize`

```go
func (a *App) Resize(sid string, cols, rows int) error {
    sess, ok := a.mgr.GetSession(sid)
    if !ok {
        return fmt.Errorf("session %q not found", sid)
    }
    return sess.Resize(uint16(cols), uint16(rows))
}
```

**Note**: Called on every window resize. The remote PTY receives a `WindowChange` SSH request.

#### `CloseTab`

```go
func (a *App) CloseTab(sid string) error {
    return a.mgr.CloseTab(a.ctx, sid)
}
```

**Idempotent**: Calling `CloseTab` on an already-closed session returns `nil`.

#### `UnlockDB`

```go
func (a *App) UnlockDB(passphrase string) error {
    key, err := store.DeriveKey([]byte(passphrase), a.salt)
    if err != nil {
        return fmt.Errorf("derive key: %w", err)
    }
    db, err := store.OpenWithKey(a.ctx, a.dbPath, key)
    if err != nil {
        return fmt.Errorf("open db: %w", err)
    }
    a.store = db
    a.hosts = store.NewHostRepo(db.DB(), key)
    return nil
}
```

**Error on wrong passphrase**: SQLCipher returns "file is not a database" — map to `"wrong passphrase"`.

## 6.3 Events (Go → JS)

### 6.3.1 Event Catalog

| Event Name | Payload | Frequency | Description |
|-----------|---------|-----------|-------------|
| `ssh:out:<sessionID>` | `string` (base64) | Very high (every 32 KB chunk or less) | Terminal output bytes |
| `ssh:closed:<sessionID>` | `null` (no payload) | Low (once per session end) | Remote closed the session |
| `hosts:updated` | `null` | Low (after CRUD ops) | Host list changed; frontend should refetch |

### 6.3.2 Event Naming Convention

```
<domain>:<action>[:<identifier>]
```

- `domain`: `ssh`, `hosts`, `app`
- `action`: `out`, `closed`, `updated`
- `identifier`: session ID (ULID) or host ID

### 6.3.3 Payload Format

| Event | Payload Type | Encoding |
|-------|-------------|----------|
| `ssh:out:<sid>` | `string` | base64 of raw terminal bytes |
| `ssh:closed:<sid>` | *(no payload)* | — |
| `hosts:updated` | *(no payload)* | — |

> **Why base64?** Terminal output contains arbitrary binary bytes (ESC sequences, NUL, high-bit bytes). Passing them as a JSON string would corrupt any byte ≥ 0x80 or = 0x0A (newline). Base64 guarantees round-trip fidelity.

## 6.4 TypeScript Type Definitions

The Wails-generated types in `frontend/wailsjs/go/main/App.d.ts` should include:

```typescript
// Auto-generated by Wails — do not edit
export class App {
    static GetHosts(): Promise<Array<Host>>;
    static SaveHost(h: Host): Promise<void>;
    static DeleteHost(id: string): Promise<void>;
    static OpenTab(hostID: string, cols: number, rows: number): Promise<string>;
    static Write(sid: string, data: string): Promise<void>;
    static Resize(sid: string, cols: number, rows: number): Promise<void>;
    static CloseTab(sid: string): Promise<void>;
    static UnlockDB(passphrase: string): Promise<void>;
    static SetupDB(passphrase: string): Promise<void>;
    static GetSettings(): Promise<Record<string, string>>;
    static SetSetting(key: string, value: string): Promise<void>;
}

export interface Host {
    id: string;
    name: string;
    host: string;
    port: number;
    user: string;
    auth_type: string;    // "key" | "password"
    auth_secret: string;  // AES-GCM encrypted, base64
    shell: string;
    init_cmds: string[];
    color: string;
    created_at: string;
    updated_at: string;
}
```

## 6.5 Error Contract

All bound methods that can fail return a `Promise` that rejects with a string error message (Wails convention). The frontend should:

1. **Display** the error in the relevant tab or modal.
2. **Not** show a generic alert for SSH errors — instead, write the error into the terminal output area (e.g., `\r\n\x1b[31mConnection error: <msg>\x1b[0m\r\n`).
3. **Distinguish** between "host not found" (UI error) and "dial timeout" (network error) for different UX.

### Error Message Format

```
<component>: <detail>
```

Examples:
- `store: host not found`
- `ssh: dial tcp 10.0.0.1:22: i/o timeout`
- `ssh: handshake failed: ssh: unable to authenticate, attempted methods [none publickey], no supported methods remain`
- `pty: request failed: ssh: channel request rejected`

## 6.6 Concurrency & Thread Safety

| Concern | Handling |
|---------|----------|
| Multiple `Write` calls in rapid succession | Serialized by the `*ssh.Session` internal write lock |
| `Resize` called concurrently with `Write` | `WindowChange` is a separate SSH channel request; safe to call concurrently |
| `CloseTab` called while `Write` is in-flight | `CloseTab` closes the session; in-flight `Write` returns an error (session closed) — frontend ignores this as expected |
| `OpenTab` called while a previous tab to same host is still open | Independent sessions; the shared `*ssh.Client` is used concurrently by multiple sessions (safe per `golang.org/x/crypto/ssh`) |

## 6.7 Wails Configuration

```go
// main.go
func main() {
    wails.Run(&options.App{
        Title:     "xssh",
        Width:     1200,
        Height:    800,
        MinWidth:  800,
        MinHeight: 500,
        BackgroundColour: &options.RGBA{R: 30, G: 30, B: 30, A: 1},
        WindowStartHidden: true,
        OnStartup:  startup,
        OnShutdown: shutdown,
        OnDomReady: onDomReady,
        Bind: []interface{}{
            &app,
        },
    })
}
```

## 6.8 Event Subscription Lifecycle

The frontend must manage event subscriptions to avoid memory leaks:

```typescript
// When creating a tab:
const unsubOut = Events.on(`ssh:out:${sid}`, handler);
const unsubClosed = Events.on(`ssh:closed:${sid}`, closedHandler);

// When closing a tab:
unsubOut();       // Remove event listener
unsubClosed();    // Remove event listener
term.dispose();   // Destroy xterm.js instance
App.CloseTab(sid); // Close the Go session
```

> **Note**: Wails `Events.on` returns an unsubscribe function. Failing to call it causes the handler to accumulate and slow down output delivery.
