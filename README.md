# xssh

A cross-platform desktop SSH client built with **Go**, **Wails v2**, and **xterm.js**.

## Features (Planned)

- Dual-pane interface: host-card list (left) + SSH terminal tabs (right)
- Each tab: direct login with configurable initial commands
- All data persisted in encrypted SQLite (SQLCipher 4)

## Prerequisites

- Go 1.20+
- Node.js 18+
- Wails CLI: `go install github.com/wails-cli/wails/v2/cmd/wails@latest`

## Build & Run

```bash
# Development mode (hot reload)
make dev

# Production build
make build

# Run unit tests
make test

# Clean build artifacts
make clean
```

The production binary is output to `build/bin/xssh`.

## Project Structure

```
xssh/
├── main.go                 # Wails bootstrap
├── app.go                  # App struct with binding methods
├── wails.json              # Wails project configuration
├── Makefile                # Build targets
├── go.mod / go.sum
├── internal/
│   ├── store/              # Encrypted SQLite persistence
│   └── sshmgr/             # SSH connection & session management
├── frontend/
│   ├── index.html          # HTML entry
│   ├── package.json
│   ├── tsconfig.json
│   ├── vite.config.ts
│   ├── assets.go           # Go embed for built assets
│   ├── dist/               # Vite build output (embedded)
│   └── src/
│       └── main.ts         # Frontend entry point
├── docs/                   # Specification documents
└── README.md
```

## Architecture

```
frontend (TypeScript/xterm.js)
    ↕  Wails Bridge (JS ↔ Go)
app.go (binding methods)
    ↕
internal/sshmgr (SSH connections, PTY sessions)
    ↕
internal/store (encrypted SQLite, SQLCipher 4)
```
