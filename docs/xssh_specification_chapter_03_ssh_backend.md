# Chapter 03: SSH Backend (`internal/sshmgr`)

## 3.1 Package Responsibilities

The `internal/sshmgr` package is the core of the SSH subsystem. It provides:

1. **ConnectionManager** — per-host `*ssh.Client` reuse, per-tab `*ssh.Session` lifecycle.
2. **Session** — wraps a single PTY-backed terminal session with I/O pump.
3. **PTY handling** — terminal size, resize, type.
4. **Initial command execution** — writing host-configured commands to the live shell stdin.

## 3.2 Types

```go
package sshmgr

// Manager manages SSH connections and terminal sessions.
type Manager struct {
    mu       sync.Mutex
    clients  map[string]*ssh.Client // hostID → persistent SSH client
    sessions map[string]*Session    // sessionID → live tab session
}

// Session represents a single terminal tab backed by an SSH PTY session.
type Session struct {
    ID     string
    client *ssh.Client
    sess   *ssh.Session
    stdin  io.WriteCloser
    stdout io.ReadCloser
    stderr io.ReadCloser
    onOut  func(data []byte) // callback to emit Wails event
    ctx    context.Context
    cancel context.CancelFunc
}
```

## 3.3 Connection Reuse

### Design Decision

One `*ssh.Client` per host, **not** per tab. This means:
- Opening a second tab to the same host does **not** re-do the TCP+SSH handshake.
- All sessions on the same host share the underlying encrypted channel.
- When the host's connection drops, all tabs to that host show "disconnected" simultaneously.

### Implementation Requirements

| Requirement | Detail |
|-------------|--------|
| SM-01 | `clientFor(hostID, hostCfg)` returns the existing `*ssh.Client` if present and alive; otherwise dials a new one and caches it. |
| SM-02 | A health check (e.g., `client.IsClosed()` or a keepalive ping) is performed before reusing a client. |
| SM-03 | If the client is dead, it is removed from the map and a new one is dialed. |
| SM-04 | Keepalive: send a global request every 30 s; if no response within 10 s, mark the client dead. |
| SM-05 | On app shutdown, all clients are closed. |

## 3.4 Session Lifecycle

### 3.4.1 Open (`Manager.OpenTab`)

```
Input:  hostID string, hostCfg Host, cols, rows uint16, onOut func([]byte)
Output: *Session, error
```

Steps:
1. Obtain or create `*ssh.Client` for `hostID` (SM-01/SM-02).
2. `client.NewSession()` → `sess`.
3. `sess.RequestPty("xterm-256color", int(rows), int(cols), modes)`.
4. `sess.Shell()` — start an **interactive login shell**.  
   **Rationale**: Using `Shell()` (not `RequestExec`) ensures that shell builtins (`cd`, `export`, `alias`) and the user's `.bashrc`/`.zshrc` are in effect. This is what makes initial commands like `cd /work` persist.
5. `sess.StdinPipe()` / `sess.StdoutPipe()` / `sess.StderrPipe()`.
6. Register the `Session` in `Manager.sessions`.
7. Start pump goroutines (stdout + stderr), each with `sync.WaitGroup`.
8. If `hostCfg.InitCmds` is non-empty, write each command followed by `\n` to `stdin` in a goroutine (to avoid blocking the binding call).

### 3.4.2 Write (`Session.Write`)

```go
func (s *Session) Write(data []byte) error {
    n, err := s.stdin.Write(data)
    if n < len(data) {
        return io.ErrShortWrite
    }
    return err
}
```

Called from Wails binding `App.Write(sid, b64)` after base64 decode.

### 3.4.3 Resize (`Session.Resize`)

```go
func (s *Session) Resize(cols, rows uint16) error {
    return s.sess.WindowChange(int(rows), int(cols), 0, 0)
}
```

Must be called whenever the xterm.js terminal's dimensions change.

### 3.4.4 Close (`Manager.CloseTab`)

```
Input:  sessionID string
```

Steps:
1. Look up session in map; if not found, return nil (idempotent).
2. `session.cancel()` — cancels the session context.
3. `session.stdin.Close()` — signals EOF to the remote.
4. `session.sess.Close()` — closes the SSH channel.
5. Remove from `Manager.sessions`.
6. Pump goroutines detect EOF → exit → `WaitGroup.Wait()` completes.
7. **Do NOT close the host-level `*ssh.Client`** (other tabs may still use it).

### 3.4.5 Session Ended (Remote-initiated)

When the remote side closes the SSH channel:
- The pump goroutine receives `io.EOF` (or an `*ssh.Session` channel error).
- Emit Wails event `ssh:closed:<sessionID>` so the frontend can display "[session ended]".
- The session remains in the map until the user explicitly closes the tab (or auto-closes with a configurable delay).

## 3.5 I/O Pump

### Design Requirements

| Requirement | Detail |
|-------------|--------|
| PUMP-01 | Read `stdout` and `stderr` concurrently in separate goroutines. |
| PUMP-02 | Use a 32 KB buffer per pump to minimize `Read` syscalls. |
| PUMP-03 | Call `onOut(data)` for each successful read; the Wails layer base64-encodes and emits the event. |
| PUMP-04 | Both goroutines must exit when `io.EOF` or a non-recoverable error occurs. |
| PUMP-05 | Use `sync.WaitGroup` to track both goroutines; provide a `Done() chan struct{}` that closes when both exit. |
| PUMP-06 | The pump must be context-aware: if `ctx` is cancelled, stop reading. |

### Pseudocode

```go
func (s *Session) startPump() {
    wg := &sync.WaitGroup{}
    wg.Add(2)
    go func() { defer wg.Done(); s.pumpReader(s.stdout) }()
    go func() { defer wg.Done(); s.pumpReader(s.stderr) }()
    go func() {
        wg.Wait()
        s.cancel() // cancel session context when both readers done
    }()
}

func (s *Session) pumpReader(r io.Reader) {
    buf := make([]byte, 32*1024)
    for {
        select {
        case <-s.ctx.Done():
            return
        default:
        }
        n, err := r.Read(buf)
        if n > 0 && s.onOut != nil {
            s.onOut(buf[:n])
        }
        if err != nil {
            return // io.EOF or channel closed
        }
    }
}
```

## 3.6 Initial Commands

### Correctness Rule

**Initial commands must be written to the stdin of the interactive login shell**, not via `sess.Run()` / `sess.CombinedOutput()`.

| Wrong | Right |
|-------|-------|
| `sess.Run("cd /work")` — opens a transient exec channel; `cd` executes in a subshell that immediately exits; directory is lost. | `sess.Shell()` then `fmt.Fprintf(stdin, "cd /work\n")` — the command runs in the persistent login shell; `cd` changes the shell's cwd for the duration of the tab. |

### Format

- Each command in `Host.InitCmds` is a single-line string.
- Commands are sent sequentially, each followed by `\n`.
- A small delay (e.g., 100 ms) between commands is recommended to ensure the shell has processed the previous command before the next arrives. For v1, a simple sequential write is sufficient since the PTY shell reads from a FIFO.

## 3.7 Error Handling

| Scenario | Behavior |
|----------|----------|
| SSH dial timeout (10 s) | Return error to frontend; show "Connection failed" on the tab |
| Auth failure | Return error; show "Auth failed" on the tab |
| Remote host closes connection | Emit `ssh:closed` event; show "[session ended]" |
| Network error mid-session | Pump detects error; emit `ssh:closed`; user can "Reconnect" |
| PTY request rejected | Fall back to shell without PTY (degraded mode: no resize, no color); log a warning |

## 3.8 Dependencies

| Package | Purpose |
|---------|---------|
| `golang.org/x/crypto/ssh` | SSH protocol implementation |
| `golang.org/x/crypto/ssh/terminal` | PTY mode constants |
| `context` | Lifecycle management |
| `sync` | Concurrency primitives |
