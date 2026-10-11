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

// sshClient wraps an *ssh.Client plus liveness tracking. x/crypto exposes no
// keepalive or health check on *ssh.Client, so a keepalive goroutine pings the
// connection on an interval and marks it dead when the ping fails (SM-04).
type sshClient struct {
    client *ssh.Client
    dead   chan struct{} // closed once the connection is determined dead
    stop   chan struct{} // closed to stop the keepalive goroutine
}

// Manager manages SSH connections and terminal sessions.
type Manager struct {
    mu       sync.Mutex
    clients  map[string]*sshClient // hostID → persistent SSH client
    sessions map[string]*Session   // sessionID → live tab session
}

// Session represents a single terminal tab backed by an SSH PTY session.
type Session struct {
    ID       string
    hostID   string
    client   *ssh.Client
    sess     *ssh.Session
    stdin    io.WriteCloser
    stdout   io.Reader
    stderr   io.Reader
    onOut    func(data []byte) // callback to emit Wails event
    onClosed func()            // invoked when both pump goroutines exit
    ctx      context.Context
    cancel   context.CancelFunc
    wg       *sync.WaitGroup
    done     chan struct{}    // closed when both pump goroutines have exited
    closeOnce sync.Once       // makes Close idempotent
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
Input:  ctx context.Context, hostID string, hostCfg Host, cols, rows uint16, onOut func([]byte)
Output: (sid string, sess *Session, err error)
```

The session ID is a ULID generated inside `OpenTab` (time-ordered, sortable), via
`github.com/oklog/ulid/v2`.

Steps:
1. Obtain or create `*sshClient` for `hostID` (SM-01/SM-02/SM-03/SM-05).
2. `client.NewSession()` → `sess`.
3. `sess.RequestPty("xterm-256color", int(rows), int(cols), modes)`.
4. `sess.StdinPipe()` / `sess.StdoutPipe()` / `sess.StderrPipe()`.
   **Note**: x/crypto requires the pipes to be requested **before** the session
   process starts; `StdinPipe()` after `Shell()` returns `ErrProcessStarted`.
5. `sess.Shell()` — start an **interactive login shell**.  
   **Rationale**: Using `Shell()` (not `RequestExec`) ensures that shell builtins (`cd`, `export`, `alias`) and the user's `.bashrc`/`.zshrc` are in effect. This is what makes initial commands like `cd /work` persist.
6. Generate a ULID session ID.
7. Register the `Session` in `Manager.sessions`.
8. Start pump goroutines (stdout + stderr + watcher) via `startPump`, which
   stores a `*sync.WaitGroup` and a `done` channel on the `Session`.
9. If `hostCfg.InitCmds` is non-empty, write each command followed by `\n` to
   `stdin` in a goroutine after a 100 ms delay (to avoid blocking the binding
   call and to let the shell prompt be ready).

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
    return s.sess.WindowChange(int(rows), int(cols))
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
// startPump is launched once per Session from Manager.OpenTab. It stores the
// WaitGroup and done channel on the Session so Manager.CloseTab can wait for
// the pumps to drain.
func startPump(s *Session) {
    s.wg = &sync.WaitGroup{}
    s.done = make(chan struct{})
    s.wg.Add(2)
    go func() { defer s.wg.Done(); pumpReader(s, s.stdout) }()
    go func() { defer s.wg.Done(); pumpReader(s, s.stderr) }()
    go func() {
        s.wg.Wait()
        close(s.done)
        if s.onClosed != nil {
            s.onClosed() // emit ssh:closed:<sid> so the UI shows "[session ended]"
        }
    }()
}

func pumpReader(s *Session, r io.Reader) {
    buf := make([]byte, pumpBufSize) // 32*1024
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
| PTY request rejected | `OpenTab` returns an error (a PTY is required for an interactive terminal); the SSH channel is closed on failure. |
| Unparseable private key (key auth) | Fall back to password auth with the raw secret; the dial surfaces a descriptive error. |

## 3.8 Dependencies

| Package | Purpose |
|---------|---------|
| `golang.org/x/crypto/ssh` | SSH protocol implementation |
| `github.com/oklog/ulid/v2` | ULID session ID generation |
| `crypto/rand` | Entropy source for ULID generation |
| `context` | Lifecycle management |
| `sync` | Concurrency primitives |
