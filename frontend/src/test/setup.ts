// Global test setup: mocks for xterm.js, FitAddon, and browser APIs
// that jsdom does not provide (ResizeObserver, controllable requestAnimationFrame).
import { vi } from 'vitest';

// Global registry of created fake Terminal instances (for test inspection).
(globalThis as unknown as Record<string, unknown>).__xtermInstances = [];

/**
 * Fake xterm.js Terminal. Records writes, focus, and dispose, and lets tests
 * drive `onData` callbacks via `emitData`.
 *
 * Also exposes an `element` (a real HTMLElement) so the right-click
 * context-menu handler can attach/detach DOM listeners, plus `paste` and
 * `clear` mirroring the real xterm API: `paste(text)` routes the text through
 * the `onData` pipeline exactly like real xterm.js does.
 */
class Terminal {
    cols = 80;
    rows = 24;
    written: string[] = [];
    focused = false;
    disposed = false;
    dataHandlers: Array<(d: string) => void> = [];
    selectionHandlers: Array<() => void> = [];
    openCalls = 0;
    selectedText = '';
    /** Records text passed to `paste()` (mirrors xterm paste → onData). */
    pasted: string[] = [];
    /** Number of times `clear()` was called. */
    clearCalls = 0;
    /** The terminal's root DOM node (present after `open()`). */
    element: HTMLElement | undefined;

    constructor(_opts?: unknown) {
        // xterm.js exposes `element` only after `open()`.
        this.element = document.createElement('div');
        this.element.className = 'xterm';
        ((globalThis as unknown as Record<string, unknown>)
            .__xtermInstances as Array<unknown>).push(this);
    }

    loadAddon(_addon?: unknown): void { /* no-op */ }
    open(_container?: HTMLElement): void { this.openCalls += 1; }
    /**
     * Route pasted text through the `onData` pipeline, mirroring real
     * xterm.js `paste()` which emits the data event.
     */
    paste(text: string): void {
        this.pasted.push(text);
        this.emitData(text);
    }
    clear(): void { this.clearCalls += 1; }
    onData(cb: (d: string) => void): { dispose: () => void } {
        this.dataHandlers.push(cb);
        const handlers = this.dataHandlers;
        return {
            dispose(): void {
                const i = handlers.indexOf(cb);
                if (i >= 0) handlers.splice(i, 1);
            },
        };
    }
    write(data: string): void { this.written.push(data); }
    focus(): void { this.focused = true; }
    dispose(): void { this.disposed = true; }
    emitData(d: string): void {
        for (const cb of this.dataHandlers) cb(d);
    }
    onSelectionChange(cb: () => void): { dispose: () => void } {
        this.selectionHandlers.push(cb);
        const handlers = this.selectionHandlers;
        return {
            dispose(): void {
                const i = handlers.indexOf(cb);
                if (i >= 0) handlers.splice(i, 1);
            },
        };
    }
    getSelection(): string {
        return this.selectedText;
    }
}

/** Fake FitAddon that records fit() calls. */
class FitAddon {
    fitted = 0;
    fit(): void { this.fitted += 1; }
}

vi.mock('@xterm/xterm', () => ({ Terminal }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon }));

// --- ResizeObserver (not in jsdom) ---
(globalThis as unknown as Record<string, unknown>).__roInstances = [];

class MockResizeObserver {
    cb: ResizeObserverCallback;
    observed: Element | null = null;
    connected = false;

    constructor(cb: ResizeObserverCallback) {
        this.cb = cb;
        ((globalThis as unknown as Record<string, unknown>)
            .__roInstances as Array<unknown>).push(this);
    }
    observe(el: Element): void { this.observed = el; this.connected = true; }
    unobserve(): void { this.observed = null; this.connected = false; }
    disconnect(): void { this.observed = null; this.connected = false; }
    /** Test helper: fire the callback. */
    trigger(): void { if (this.cb) this.cb([], undefined as unknown as ResizeObserver); }
}
(globalThis as unknown as Record<string, unknown>).ResizeObserver = MockResizeObserver;

// --- Controllable requestAnimationFrame ---
let rafCallbacks: Array<() => void> = [];
(globalThis as unknown as Record<string, unknown>).requestAnimationFrame = (
    cb: () => void,
): number => {
    rafCallbacks.push(cb);
    return rafCallbacks.length;
};
(globalThis as unknown as Record<string, unknown>).__flushRaf = (): void => {
    const cbs = rafCallbacks;
    rafCallbacks = [];
    for (const cb of cbs) cb();
};

export {};
