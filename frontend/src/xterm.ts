// xterm.ts — xterm.js wrapper: terminal creation, I/O wiring, resize, cleanup.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Write, Resize } from '../wailsjs/go/main/App';
import { EventsOn } from '../wailsjs/runtime/runtime';
import type { TerminalSettings } from './settings';

/**
 * Options for the xterm.js terminal, derived from the user's settings.
 * Only the subset that maps directly to xterm.js constructor options is
 * applied at creation time; live updates are applied via `term.options`.
 */
export type TerminalOptions = Partial<TerminalSettings>;

/** The result of wiring a terminal to a session. */
export interface WiredTerminal {
    /** The xterm.js Terminal instance. */
    term: Terminal;
    /** The FitAddon instance. */
    fit: FitAddon;
    /** Call to tear down all subscriptions, the ResizeObserver, and the terminal. */
    dispose: () => void;
}

/**
 * Create an xterm.js Terminal instance inside the given container,
 * load the FitAddon, and open the terminal.
 *
 * `opts` optionally carries font size and scrollback lines from the user's
 * settings; when omitted, xterm.js defaults (and the defaults mirrored in
 * settings.ts) are used.
 */
export function createTerminal(
    container: HTMLDivElement,
    opts: TerminalOptions = {},
): { term: Terminal; fit: FitAddon } {
    const term = new Terminal({
        cursorBlink: true,
        // Defaults mirror settings.ts so a missing value degrades gracefully.
        fontSize: opts.fontSize ?? 14,
        scrollback: opts.scrollbackLines ?? 1000,
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        theme: {
            background: '#1e1e1e',
            foreground: '#d4d4d4',
            cursor: '#aeafad',
        },
        allowProposedApi: true,
        rightClickSelectsWord: true,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();

    return { term, fit };
}

/**
 * Copy text to the system clipboard.
 *
 * Uses the async Clipboard API when available, falling back to a hidden
 * textarea + `execCommand('copy')` for older webviews. Failures are
 * swallowed (e.g. the clipboard is unavailable in an insecure context).
 * This is the single source of truth for clipboard writes so the auto-copy
 * path and the right-click menu share identical behavior.
 */
function copyToClipboard(text: string): void {
    if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).catch(() => {
            /* clipboard may be unavailable (e.g., insecure context) */
        });
    } else {
        // Fallback: hidden textarea + execCommand.
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
    }
}

/**
 * Read text from the system clipboard.
 *
 * `navigator.clipboard.readText` requires a user activation; a right-click
 * provides one on the Wails webviews. Resolves to the clipboard text, or
 * rejects when the API is unsupported so callers treat the paste as a no-op.
 */
function readClipboard(): Promise<string> {
    return navigator.clipboard?.readText
        ? navigator.clipboard.readText()
        : Promise.reject(new Error('clipboard.readText unsupported'));
}

/**
 * Wire up I/O between an xterm.js instance and a Go SSH session.
 *
 * - Keystrokes from the terminal are base64-encoded and sent to Go via App.Write.
 * - Terminal output from Go is received via `ssh:out:<sid>` events and written
 *   to the terminal using requestAnimationFrame coalescing for performance.
 * - When the session closes (`ssh:closed:<sid>`), a marker is written to the terminal.
 * - A ResizeObserver watches the container and propagates resize events to Go.
 *
 * Returns a WiredTerminal with a `dispose()` method that cleans up everything.
 */
export function wireIO(
    term: Terminal,
    fit: FitAddon,
    sessionId: string,
    container: HTMLDivElement,
): WiredTerminal {
    // --- Output from Go (coalesced via rAF) ---
    let pending: string[] = [];
    let flushing = false;
    // Streaming TextDecoder to correctly handle multi-byte UTF-8 sequences
    // that may be split across chunk boundaries.
    const decoder = new TextDecoder('utf-8');

    const unsubOut = EventsOn(`ssh:out:${sessionId}`, (payload: unknown) => {
        const b64 = payload as string;
        const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        pending.push(decoder.decode(bytes));

        if (!flushing) {
            flushing = true;
            requestAnimationFrame(() => {
                term.write(pending.join(''));
                pending = [];
                flushing = false;
            });
        }
    });

    // --- Session closed event ---
    let closed = false;
    const unsubClosed = EventsOn(`ssh:closed:${sessionId}`, () => {
        if (closed) return;
        closed = true;
        // Write a dimmed "[session ended]" marker to the terminal.
        term.write('\r\n\x1b[90m[session ended]\x1b[0m\r\n');
    });

    // --- Keystrokes from terminal → Go ---
    const dataSubscription = term.onData((data: string) => {
        // Unicode-safe base64 encoding (handles CJK, emoji, etc.)
        const b64 = btoa(unescape(encodeURIComponent(data)));
        Write(sessionId, b64).catch(() => {
            /* session may already be closed — ignore */
        });
    });

    // --- Auto-copy on selection (standard terminal behavior) ---
    // Debounce the clipboard write to avoid racing multiple async
    // writeText calls during a mouse-drag selection. During a drag,
    // onSelectionChange fires on every mouse-move event (~16 ms apart),
    // producing dozens of in-flight writeText Promises. Without debouncing,
    // an earlier (partial) write may resolve after a later (complete) write,
    // leaving the clipboard with only a subset of the selection.
    const DEBOUNCE_MS = 150;
    let selectionTimer: ReturnType<typeof setTimeout> | null = null;
    let lastSelection = '';

    const flushSelection = (): void => {
        if (!lastSelection) return;
        const text = lastSelection;
        lastSelection = '';
        copyToClipboard(text);
    };

    const selectionSub = term.onSelectionChange(() => {
        const selection = term.getSelection();
        // Cancel any pending write from a previous (incomplete) selection.
        if (selectionTimer !== null) {
            clearTimeout(selectionTimer);
            selectionTimer = null;
        }
        if (selection) {
            lastSelection = selection;
            selectionTimer = setTimeout(() => {
                selectionTimer = null;
                flushSelection();
            }, DEBOUNCE_MS);
        } else {
            // Selection cleared — reset so we don't re-write an old value.
            lastSelection = '';
        }
    });

    // --- Right-click context menu (Copy / Paste / Clear) ---
    // xterm.js does not draw its own OS context menu, and
    // `rightClickSelectsWord` (set in createTerminal) hijacks right-click to
    // select the word under the cursor. We therefore attach our own
    // `contextmenu` handler to the terminal element that suppresses the native
    // menu, re-focuses the terminal (so keyboard paste is reliable afterwards),
    // and shows a small Copy / Paste / Clear menu at the cursor.
    //
    // Paste reads the clipboard and routes the text through `term.paste()`,
    // which emits xterm's native `onData` event → the base64 pipeline above →
    // App.Write. No other I/O code changes are required.
    let ctxMenu: HTMLElement | null = null;
    let onDocPointerDown: ((e: PointerEvent) => void) | null = null;
    let onDocKeydown: ((e: KeyboardEvent) => void) | null = null;

    const dismissContextMenu = (): void => {
        if (onDocPointerDown) {
            document.removeEventListener('pointerdown', onDocPointerDown);
            onDocPointerDown = null;
        }
        if (onDocKeydown) {
            document.removeEventListener('keydown', onDocKeydown);
            onDocKeydown = null;
        }
        if (ctxMenu && ctxMenu.parentNode) {
            ctxMenu.parentNode.removeChild(ctxMenu);
        }
        ctxMenu = null;
    };

    const makeMenuItem = (label: string, onActivate: () => void): HTMLElement => {
        const item = document.createElement('div');
        item.className = 'xssh-ctx-item';
        item.textContent = label;
        item.addEventListener('click', (e: MouseEvent) => {
            e.stopPropagation();
            dismissContextMenu();
            onActivate();
        });
        return item;
    };

    const showContextMenu = (x: number, y: number): void => {
        dismissContextMenu();

        const menu = document.createElement('div');
        menu.className = 'xssh-ctx-menu';

        // Copy: current selection (consistent with the auto-copy path).
        menu.appendChild(makeMenuItem('Copy', () => {
            const sel = term.getSelection();
            if (sel) copyToClipboard(sel);
        }));
        // Paste: read clipboard → term.paste → onData → App.Write.
        menu.appendChild(makeMenuItem('Paste', () => {
            readClipboard()
                .then(text => {
                    if (text) term.paste(text);
                })
                .catch(() => {
                    /* clipboard read failed or unsupported — no-op */
                });
        }));
        // Clear: reset the visible terminal buffer.
        menu.appendChild(makeMenuItem('Clear', () => {
            term.clear();
        }));

        document.body.appendChild(menu);

        // Position at the cursor, clamped so the menu stays in the viewport.
        const menuW = menu.offsetWidth || 120;
        const menuH = menu.offsetHeight || 90;
        const left = Math.min(x, window.innerWidth - menuW - 2);
        const top = Math.min(y, window.innerHeight - menuH - 2);
        menu.style.left = `${Math.max(0, left)}px`;
        menu.style.top = `${Math.max(0, top)}px`;

        ctxMenu = menu;

        // Dismiss on any outside pointer interaction or the Escape key.
        onDocPointerDown = (e: PointerEvent) => {
            if (ctxMenu && !ctxMenu.contains(e.target as Node)) {
                dismissContextMenu();
            }
        };
        onDocKeydown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') dismissContextMenu();
        };
        document.addEventListener('pointerdown', onDocPointerDown, true);
        document.addEventListener('keydown', onDocKeydown, true);
    };

    const onContextMenu = (e: MouseEvent): void => {
        e.preventDefault(); // suppress the native menu
        term.focus();       // re-acquire focus so paste is reliable
        showContextMenu(e.clientX, e.clientY);
    };

    const ctxTarget = term.element ?? container;
    ctxTarget.addEventListener('contextmenu', onContextMenu);

    // --- Resize propagation ---
    const resizeObserver = new ResizeObserver(() => {
        try {
            fit.fit();
            Resize(sessionId, term.cols, term.rows).catch(() => {
                /* session may already be closed — ignore */
            });
        } catch {
            /* container may be detached */
        }
    });
    resizeObserver.observe(container);

    // --- Cleanup ---
    const dispose = (): void => {
        if (selectionTimer !== null) {
            clearTimeout(selectionTimer);
            selectionTimer = null;
        }
        // Remove the context-menu listener and any open menu.
        ctxTarget.removeEventListener('contextmenu', onContextMenu);
        dismissContextMenu();
        unsubOut();
        unsubClosed();
        dataSubscription.dispose();
        selectionSub.dispose();
        resizeObserver.disconnect();
        term.dispose();
    };

    return { term, fit, dispose };
}

/**
 * Create a terminal, wire its I/O to a session, and return everything needed
 * to later tear it down.
 *
 * `opts` optionally carries font size and scrollback lines from the user's
 * settings; they are applied at creation time.
 */
export function createAndWireTerminal(
    container: HTMLDivElement,
    sessionId: string,
    opts: TerminalOptions = {},
): WiredTerminal {
    const { term, fit } = createTerminal(container, opts);
    const wired = wireIO(term, fit, sessionId, container);
    return wired;
}
