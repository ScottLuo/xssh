# xssh — Development Requirement Specification

**Version**: 1.0  
**Last Updated**: 2025-01-01  
**Status**: Draft

---

## Project Summary

**xssh** is a cross-platform desktop SSH client built with **Go + Wails + xterm.js**. It provides a dual-pane interface: host-card list on the left, SSH terminal tabs on the right. Each tab supports direct login with configurable initial commands (e.g., switching working directory, activating virtual environments).

All host configuration and application data is persisted in an **encrypted SQLite (SQLCipher) database**.

---

## Technical Stack

| Layer | Technology |
|-------|-----------|
| Backend | Go 1.20+, `github.com/ncruces/go-sqlite3` (SQLCipher 4) |
| GUI Framework | Wails v2 (Go ↔ JS bridge) |
| Frontend | TypeScript, xterm.js |
| SSH | `golang.org/x/crypto/ssh` |
| Storage | SQLite (SQLCipher 4, AES-256) |
| Crypto | AES-GCM (field-level), scrypt (key derivation) |

---

## Document Index

| # | File | Description |
|---|------|-------------|
| 01 | `xssh_specification_chapter_01_overview.md` | Project goals, user stories, functional requirements, non-functional requirements |
| 02 | `xssh_specification_chapter_02_architecture.md` | System architecture, module boundaries, data flow, concurrency model |
| 03 | `xssh_specification_chapter_03_ssh_backend.md` | SSH connection manager, PTY, session lifecycle, initial commands, resize, reconnection |
| 04 | `xssh_specification_chapter_04_storage.md` | Encrypted SQLite schema, key management, field-level encryption, migration strategy |
| 05 | `xssh_specification_chapter_05_frontend.md` | UI layout, host cards, tab management, xterm.js integration, I/O coalescing |
| 06 | `xssh_specification_chapter_06_api_interface.md` | Wails binding contract: JS↔Go methods, event names, payload formats |

---

## File Layout (Planned)

```
xssh/
├─ main.go
├─ app.go
├─ internal/
│  ├─ host/          # Host model + persistence
│  ├─ sshmgr/        # ConnectionManager, Session, PTY, pump
│  └─ store/         # EncryptedDB, HostRepo, SettingsRepo
├─ frontend/
│  ├─ index.html
│  ├─ src/
│  │  ├─ hosts.ts
│  │  ├─ tabs.ts
│  │  └─ xterm.ts
│  └─ ...
├─ docs/
│  ├─ xssh_specification_main.md          ← this file
│  ├─ xssh_specification_chapter_01_overview.md
│  ├─ xssh_specification_chapter_02_architecture.md
│  ├─ xssh_specification_chapter_03_ssh_backend.md
│  ├─ xssh_specification_chapter_04_storage.md
│  ├─ xssh_specification_chapter_05_frontend.md
│  └─ xssh_specification_chapter_06_api_interface.md
└─ go.mod
```
