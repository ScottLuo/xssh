// xterm.ts — xterm.js wrapper: terminal creation, I/O wiring, resize, cleanup.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { App } from '../wailsjs/go/main/App';
import { Events } from '../wailsjs/runtime/runtime';

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
 */
export function createTerminal(container: HTMLDivElement): { term: Terminal; fit: FitAddon } {
    const term = new Terminal({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        theme: {
            background: '#1e1e1e',
            foreground: '#d4d4d4',
            cursor: '#aeafad',
        },
        allowProposedApi: true,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();

    return { term, fit };
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

    const unsubOut = Events.on(`ssh:out:${sessionId}`, (payload: unknown) => {
        const b64 = payload as string;
        pending.push(atob(b64));

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
    const unsubClosed = Events.on(`ssh:closed:${sessionId}`, () => {
        if (closed) return;
        closed = true;
        // Write a dimmed "[session ended]" marker to the terminal.
        term.write('\r\n\x1b[90m[session ended]\x1b[0m\r\n');
    });

    // --- Keystrokes from terminal → Go ---
    const dataSubscription = term.onData((data: string) => {
        // Unicode-safe base64 encoding (handles CJK, emoji, etc.)
        const b64 = btoa(unescape(encodeURIComponent(data)));
        App.Write(sessionId, b64).catch(() => {
            /* session may already be closed — ignore */
        });
    });

    // --- Resize propagation ---
    const resizeObserver = new ResizeObserver(() => {
        try {
            fit.fit();
            App.Resize(sessionId, term.cols, term.rows).catch(() => {
                /* session may already be closed — ignore */
            });
        } catch {
            /* container may be detached */
        }
    });
    resizeObserver.observe(container);

    // --- Cleanup ---
    const dispose = (): void => {
        unsubOut();
        unsubClosed();
        dataSubscription.dispose();
        resizeObserver.disconnect();
        term.dispose();
    };

    return { term, fit, dispose };
}

/**
 * Create a terminal, wire its I/O to a session, and return everything needed
 * to later tear it down.
 */
export function createAndWireTerminal(
    container: HTMLDivElement,
    sessionId: string,
): WiredTerminal {
    const { term, fit } = createTerminal(container);
    const wired = wireIO(term, fit, sessionId, container);
    return wired;
}
