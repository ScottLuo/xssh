# Chapter 01: Overview & Requirements

## 1.1 Project Goals

xssh is a **single-user desktop SSH terminal** that provides:

1. **Host card management** — a visual list of pre-configured SSH hosts (name, address, port, user, auth method, color).
2. **One-click login** — clicking a host card opens a new terminal tab with a persistent SSH session.
3. **Initial commands** — per-host configurable commands executed immediately after login (e.g., `cd /work`, `source venv/bin/activate`).
4. **Multi-tab SSH sessions** — multiple concurrent terminal tabs per host, each with independent PTY.
5. **Encrypted local storage** — all host config and app data stored in an encrypted SQLite database.

### Non-Goals (v1)

- SFTP / file transfer
- Port forwarding / tunnels
- SSH config file import (`~/.ssh/config`)
- Multi-user / collaborative sessions
- Plugin system

---

## 1.2 User Stories

| ID | As a… | I want to… | So that… |
|----|--------|-----------|----------|
| US-01 | developer | add a new host card with name, host, port, user, key path, initial commands | I can quickly connect to my frequently-used servers |
| US-02 | developer | click a host card to open a new SSH terminal tab | I can start working without typing `ssh user@host` |
| US-03 | developer | configure initial commands (e.g. `cd /work`) on the host card | My shell starts in the right directory every time |
| US-04 | developer | open multiple tabs to the same host simultaneously | I can work on different directories/projects in parallel |
| US-05 | developer | close a tab without disconnecting the underlying host connection | Fast tab switching without re-authentication overhead |
| US-06 | developer | see a clear "session ended" indicator when the remote side closes the connection | I know when to reconnect |
| US-07 | developer | set a master passphrase that encrypts my host configs at rest | My credentials are not stored in plaintext |
| US-08 | developer | resize the terminal window and have the remote PTY resize accordingly | `vim`/`htop`/`less` work correctly |

---

## 1.3 Functional Requirements

### FR-01: Host Card Management

| Requirement | Detail |
|-------------|--------|
| FR-01.1 | User can **create** a host card with: name, host (IP/hostname), port (default 22), user, auth type (key/password), auth credential, optional shell, optional initial commands (string array), optional color. |
| FR-01.2 | User can **edit** an existing host card. |
| FR-01.3 | User can **delete** a host card (cascades: close all open sessions to that host). |
| FR-01.4 | Host cards are persisted in encrypted SQLite. |
| FR-01.5 | Host card list is displayed on the left panel as color-coded cards. |

### FR-02: SSH Terminal Session

| Requirement | Detail |
|-------------|--------|
| FR-02.1 | Clicking a host card opens a new tab with a new SSH session (PTY + interactive login shell). |
| FR-02.2 | Multiple tabs can exist for the same host; each has an independent PTY. |
| FR-02.3 | The SSH `*ssh.Client` (TCP+SSH handshake) is **reused** across tabs for the same host; a new `*ssh.Session` is opened per tab. |
| FR-02.4 | After login, initial commands (if configured) are written to the live shell's stdin, so `cd`/`export`/`source` persist. |
| FR-02.5 | Terminal resize propagates to the remote PTY via `WindowChange` request. |
| FR-02.6 | When the remote closes the session, the tab displays "[session ended]" and optionally offers "Reconnect". |
| FR-02.7 | Closing a tab closes the SSH session (not necessarily the host-level client). |

### FR-03: Encrypted Storage

| Requirement | Detail |
|-------------|--------|
| FR-03.1 | All host configs and app settings are stored in a single encrypted SQLite file (SQLCipher 4). |
| FR-03.2 | The database file is encrypted with a 32-byte key derived from a user-supplied master passphrase via scrypt. |
| FR-03.3 | Sensitive fields (passwords, key content) are additionally encrypted with AES-GCM (field-level, defense-in-depth). |
| FR-03.4 | On first launch, user is prompted to set a master passphrase. |
| FR-03.5 | On subsequent launches, user must provide the master passphrase to unlock the DB. |
| FR-03.6 | The scrypt salt is stored in a separate small metadata file next to the DB. |

### FR-04: Terminal Rendering

| Requirement | Detail |
|-------------|--------|
| FR-04.1 | Each tab renders an xterm.js instance. |
| FR-04.2 | Terminal output bytes are base64-encoded and delivered via Wails events (binary-safe). |
| FR-04.3 | Output writes are coalesced via `requestAnimationFrame` to avoid excessive re-renders. |
| FR-04.4 | Keystrokes from xterm.js are base64-encoded and sent to Go for writing to the PTY stdin. |

---

## 1.4 Non-Functional Requirements

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-01 | **Performance** | Tab open latency < 500 ms on local network; terminal output throughput ≥ 1 MB/s without visible lag |
| NFR-02 | **Security** | DB file unreadable without the passphrase; password fields double-encrypted; key zeroed on app exit |
| NFR-03 | **Portability** | Cross-compilable to Windows, macOS, Linux via Wails; no CGO dependency in default build (use `ncruces/go-sqlite3` pure-Go driver) |
| NFR-04 | **Reliability** | No goroutine leaks on tab close; session pump exits cleanly on EOF/error; reconnection available on remote disconnect |
| NFR-05 | **Extensibility** | Clean separation of layers: `store` → `sshmgr` → `Wails binding` → `frontend`; easy to add features like SFTP, port-forward later |
| NFR-06 | **Code quality** | Pass `golangci-lint`; unit tests with `go test`; integration tests tagged `//go:build integration` |

---

## 1.5 Operating Environment

| Aspect | Detail |
|--------|--------|
| Target platforms | Windows 10+, macOS 12+, Ubuntu 20.04+ / any modern Linux |
| Minimum hardware | 4 GB RAM, 2 CPU cores |
| Network | Direct SSH access to target hosts (no proxy in v1) |
| Concurrency | Single-user, local process; no distributed concerns |
