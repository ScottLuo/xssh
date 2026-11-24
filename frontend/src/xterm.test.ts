import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Terminal } from '@xterm/xterm';

/** A controllable in-memory event bus to drive Wails event subscriptions. */
function createEventBus() {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    return {
        on(event: string, cb: (...args: unknown[]) => void): () => void {
            if (!listeners.has(event)) listeners.set(event, new Set());
            listeners.get(event)!.add(cb);
            return () => { listeners.get(event)?.delete(cb); };
        },
        emit(event: string, ...args: unknown[]): void {
            const s = listeners.get(event);
            if (s) for (const cb of s) cb(...args);
        },
    };
}

type Bus = ReturnType<typeof createEventBus>;
type FakeTerm = Terminal & {
    written: string[];
    disposed: boolean;
    dataHandlers: Array<(d: string) => void>;
    emitData: (d: string) => void;
};

function getRo(): Array<{ observed: Element | null; connected: boolean; trigger: () => void }> {
    return (globalThis as unknown as Record<string, unknown>).__roInstances as never;
}

function flushRaf(): void {
    (globalThis as unknown as Record<string, unknown>).__flushRaf();
}

let bus: Bus;
let Write: ReturnType<typeof vi.fn>;
let Resize: ReturnType<typeof vi.fn>;

beforeEach(async () => {
    bus = createEventBus();
    vi.doMock('../wailsjs/runtime/runtime', () => ({ EventsOn: bus.on }));
    Write = vi.fn().mockResolvedValue(undefined);
    Resize = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../wailsjs/go/main/App', () => ({ Write, Resize }));
    vi.resetModules();
    // Clear the global ResizeObserver instance list for isolation.
    (globalThis as unknown as Record<string, unknown>).__roInstances = [];
});

describe('createTerminal', () => {
    it('creates and opens a terminal and loads the fit addon', async () => {
        const { createTerminal } = await import('./xterm');
        const container = document.createElement('div');
        const { term, fit } = createTerminal(container);
        expect(term).toBeDefined();
        expect(fit).toBeDefined();
        // The fake terminal records open() being called.
        const fake = term as FakeTerm;
        expect((fake as unknown as { openCalls: number }).openCalls).toBe(1);
    });
});

describe('wireIO / createAndWireTerminal', () => {
    it('sends Unicode-safe base64 keystrokes to App.Write', async () => {
        const { createAndWireTerminal } = await import('./xterm');
        const container = document.createElement('div');
        const wired = createAndWireTerminal(container, 'sid-1');
        const term = wired.term as FakeTerm;
        term.emitData('A');
        expect(Write).toHaveBeenCalledWith(
            'sid-1',
            btoa(unescape(encodeURIComponent('A'))),
        );
    });

    it('writes coalesced base64 output to the terminal after rAF flush', async () => {
        const { createAndWireTerminal } = await import('./xterm');
        const container = document.createElement('div');
        const wired = createAndWireTerminal(container, 'sid-2');
        const term = wired.term as FakeTerm;
        const msg = 'hello';
        bus.emit('ssh:out:sid-2', btoa(unescape(encodeURIComponent(msg))));
        // Nothing written yet before the rAF flush.
        expect(term.written.length).toBe(0);
        flushRaf();
        expect(term.written.length).toBe(1);
        expect(term.written[0]).toBe(msg);
    });

    it('coalesces multiple output events into a single write', async () => {
        const { createAndWireTerminal } = await import('./xterm');
        const container = document.createElement('div');
        const wired = createAndWireTerminal(container, 'sid-3');
        const term = wired.term as FakeTerm;
        bus.emit('ssh:out:sid-3', btoa('a'));
        bus.emit('ssh:out:sid-3', btoa('b'));
        bus.emit('ssh:out:sid-3', btoa('c'));
        flushRaf();
        expect(term.written.length).toBe(1);
        expect(term.written[0]).toBe('abc');
    });

    it('writes a session-ended marker when ssh:closed fires', async () => {
        const { createAndWireTerminal } = await import('./xterm');
        const container = document.createElement('div');
        const wired = createAndWireTerminal(container, 'sid-4');
        const term = wired.term as FakeTerm;
        bus.emit('ssh:closed:sid-4');
        expect(term.written.length).toBe(1);
        expect(term.written[0]).toContain('[session ended]');
        // A second close event should not write again.
        bus.emit('ssh:closed:sid-4');
        expect(term.written.length).toBe(1);
    });

    it('propagates resize to App.Resize and observes the container', async () => {
        const { createAndWireTerminal } = await import('./xterm');
        const container = document.createElement('div');
        createAndWireTerminal(container, 'sid-5');
        const ro = getRo()[0];
        expect(ro.observed).toBe(container);
        ro.trigger();
        expect(Resize).toHaveBeenCalledWith('sid-5', 80, 24);
    });

    it('dispose() tears down subscriptions, the observer, and the terminal', async () => {
        const { createAndWireTerminal } = await import('./xterm');
        const container = document.createElement('div');
        const wired = createAndWireTerminal(container, 'sid-6');
        const term = wired.term as FakeTerm;
        const ro = getRo()[0];
        const handlersBefore = term.dataHandlers.length;

        wired.dispose();

        expect(term.disposed).toBe(true);
        expect(ro.connected).toBe(false);
        expect(term.dataHandlers.length).toBeLessThan(handlersBefore);
        // After dispose, output events should no longer write to the terminal.
        bus.emit('ssh:out:sid-6', btoa('x'));
        flushRaf();
        expect(term.written.length).toBe(0);
    });
});

describe('wireIO — auto-copy on selection (debounced)', () => {
    let writeText: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        writeText = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, 'clipboard', {
            value: { writeText },
            writable: true,
            configurable: true,
        });
    });

    it('copies only the final stable selection after rapid selection changes', async () => {
        vi.useFakeTimers();
        try {
            const { createAndWireTerminal } = await import('./xterm');
            const container = document.createElement('div');
            createAndWireTerminal(container, 'sid-copy-1');
            const instances = (globalThis as unknown as Record<string, unknown>)
                .__xtermInstances as Array<FakeTerm>;
            const term = instances[instances.length - 1];

            // Simulate a drag: multiple selection changes with growing text
            (term as unknown as { selectedText: string }).selectedText = 'line1';
            term.selectionHandlers[0]();

            (term as unknown as { selectedText: string }).selectedText = 'line1\nline2';
            term.selectionHandlers[0]();

            (term as unknown as { selectedText: string }).selectedText = 'line1\nline2\nline3';
            term.selectionHandlers[0]();

            // Before the 150 ms debounce expires, clipboard should NOT have been written yet.
            expect(writeText).not.toHaveBeenCalled();

            // Advance past the debounce window.
            vi.advanceTimersByTime(150);

            // Exactly one write with the final, complete selection.
            expect(writeText).toHaveBeenCalledTimes(1);
            expect(writeText).toHaveBeenCalledWith('line1\nline2\nline3');
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not write to clipboard when selection is cleared before debounce', async () => {
        vi.useFakeTimers();
        try {
            const { createAndWireTerminal } = await import('./xterm');
            const container = document.createElement('div');
            createAndWireTerminal(container, 'sid-copy-2');
            const instances = (globalThis as unknown as Record<string, unknown>)
                .__xtermInstances as Array<FakeTerm>;
            const term = instances[instances.length - 1];

            // Set a partial selection.
            (term as unknown as { selectedText: string }).selectedText = 'partial';
            term.selectionHandlers[0]();

            // Clear the selection before the 150 ms debounce fires.
            (term as unknown as { selectedText: string }).selectedText = '';
            term.selectionHandlers[0]();

            // Advance past the debounce window.
            vi.advanceTimersByTime(200);

            // No write should have occurred.
            expect(writeText).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('dispose() clears the pending selection timer so no write occurs after teardown', async () => {
        vi.useFakeTimers();
        try {
            const { createAndWireTerminal } = await import('./xterm');
            const container = document.createElement('div');
            const wired = createAndWireTerminal(container, 'sid-copy-3');
            const instances = (globalThis as unknown as Record<string, unknown>)
                .__xtermInstances as Array<FakeTerm>;
            const term = instances[instances.length - 1];

            // Set a selection and trigger the handler.
            (term as unknown as { selectedText: string }).selectedText = 'text-to-copy';
            term.selectionHandlers[0]();

            // Dispose before the debounce fires.
            wired.dispose();

            // Advance past the debounce window.
            vi.advanceTimersByTime(200);

            // No write should have occurred after dispose.
            expect(writeText).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('falls back to execCommand when navigator.clipboard is unavailable', async () => {
        vi.useFakeTimers();
        const execCommandMock = vi.fn().mockReturnValue(true);
        document.execCommand = execCommandMock;
        try {
            // Remove clipboard API to trigger the fallback path.
            Object.defineProperty(navigator, 'clipboard', {
                value: undefined,
                writable: true,
                configurable: true,
            });

            const { createAndWireTerminal } = await import('./xterm');
            const container = document.createElement('div');
            createAndWireTerminal(container, 'sid-copy-4');
            const instances = (globalThis as unknown as Record<string, unknown>)
                .__xtermInstances as Array<FakeTerm>;
            const term = instances[instances.length - 1];

            (term as unknown as { selectedText: string }).selectedText = 'fallback text';
            term.selectionHandlers[0]();

            vi.advanceTimersByTime(150);

            // execCommand should have been called with 'copy'.
            expect(execCommandMock).toHaveBeenCalledWith('copy');
            // The navigator.clipboard.writeText mock should NOT have been called.
            expect(writeText).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
            // Restore clipboard for subsequent tests.
            Object.defineProperty(navigator, 'clipboard', {
                value: { writeText },
                writable: true,
                configurable: true,
            });
        }
    });
});

describe('wireIO — right-click context menu (Copy / Paste / Clear)', () => {
    let writeText: ReturnType<typeof vi.fn>;
    let readText: ReturnType<typeof vi.fn>;

    /** Returns the most recently created fake Terminal. */
    const lastTerm = (): FakeTerm => {
        const instances = ((globalThis as unknown as Record<string, unknown>)
            .__xtermInstances as unknown as Array<FakeTerm>);
        return instances[instances.length - 1];
    };

    /** Dispatch a `contextmenu` event on the terminal element. */
    const rightClick = (term: FakeTerm, opts: { preventDefault?: boolean } = {}): void => {
        const target = (term as unknown as { element: HTMLElement }).element;
        const e = new MouseEvent('contextmenu', {
            clientX: 120,
            clientY: 80,
            bubbles: true,
            cancelable: true,
        });
        if (opts.preventDefault === false) e.preventDefault = vi.fn();
        target.dispatchEvent(e);
    };

    const menuItem = (label: string): HTMLElement | null =>
        Array.from(document.querySelectorAll('.xssh-ctx-item'))
            .find(el => el.textContent === label) ?? null;

    const menuInDom = (): boolean => document.querySelector('.xssh-ctx-menu') !== null;

    /** Remove any menu left open so tests are isolated. */
    const dismissAllMenus = (): void => {
        document.querySelectorAll('.xssh-ctx-menu').forEach(m => m.remove());
    };

    beforeEach(async () => {
        writeText = vi.fn().mockResolvedValue(undefined);
        readText = vi.fn().mockResolvedValue('');
        Object.defineProperty(navigator, 'clipboard', {
            value: { writeText, readText },
            writable: true,
            configurable: true,
        });
    });

    afterEach(() => {
        // Remove any menu DOM node so document-wide queries in the next test
        // don't pick up stale items.
        dismissAllMenus();
    });

    it('right-click shows a menu with Copy/Paste/Clear, prevents the default, and focuses the terminal', async () => {
        const { createAndWireTerminal } = await import('./xterm');
        const container = document.createElement('div');
        createAndWireTerminal(container, 'sid-ctx-1');
        const term = lastTerm();
        const target = (term as unknown as { element: HTMLElement }).element;
        const e = new MouseEvent('contextmenu', {
            clientX: 120,
            clientY: 80,
            bubbles: true,
            cancelable: true,
        });
        const spy = vi.spyOn(e, 'preventDefault');
        target.dispatchEvent(e);

        expect(menuInDom()).toBe(true);
        expect(menuItem('Copy')).not.toBeNull();
        expect(menuItem('Paste')).not.toBeNull();
        expect(menuItem('Clear')).not.toBeNull();
        // Native menu suppressed and terminal re-focused.
        expect(spy).toHaveBeenCalled();
        expect(term.focused).toBe(true);
    });

    it('Copy copies the current selection to the clipboard', async () => {
        const { createAndWireTerminal } = await import('./xterm');
        const container = document.createElement('div');
        createAndWireTerminal(container, 'sid-ctx-2');
        const term = lastTerm();
        (term as unknown as { selectedText: string }).selectedText = 'abc';
        rightClick(term);

        menuItem('Copy')!.click();
        expect(writeText).toHaveBeenCalledWith('abc');
    });

    it('Paste routes clipboard text through term.paste to App.Write (end-to-end)', async () => {
        const { createAndWireTerminal } = await import('./xterm');
        const container = document.createElement('div');
        createAndWireTerminal(container, 'sid-ctx-3');
        const term = lastTerm();
        readText.mockResolvedValue('ls -la');
        rightClick(term);

        const writeCallsBefore = Write.mock.calls.length;
        menuItem('Paste')!.click();
        await Promise.resolve(); // let readClipboard().then(...) run

        expect(readText).toHaveBeenCalled();
        expect((term as unknown as { pasted: string[] }).pasted).toContain('ls -la');
        // The pasted text reached the Go backend via App.Write as base64.
        const base64 = btoa(unescape(encodeURIComponent('ls -la')));
        expect(Write).toHaveBeenCalledTimes(writeCallsBefore + 1);
        expect(Write).toHaveBeenLastCalledWith('sid-ctx-3', base64);
    });

    it('Paste with an empty clipboard is a no-op (no term.paste, no Write)', async () => {
        const { createAndWireTerminal } = await import('./xterm');
        const container = document.createElement('div');
        createAndWireTerminal(container, 'sid-ctx-4');
        const term = lastTerm();
        readText.mockResolvedValue('');
        rightClick(term);

        const writeCallsBefore = Write.mock.calls.length;
        menuItem('Paste')!.click();
        await Promise.resolve();

        expect((term as unknown as { pasted: string[] }).pasted).toHaveLength(0);
        expect(Write).toHaveBeenCalledTimes(writeCallsBefore);
    });

    it('Paste with an unsupported clipboard API is a no-op (no crash)', async () => {
        const { createAndWireTerminal } = await import('./xterm');
        const container = document.createElement('div');
        createAndWireTerminal(container, 'sid-ctx-5');
        const term = lastTerm();
        // readText rejects (unsupported / permission denied).
        readText.mockRejectedValue(new Error('denied'));
        rightClick(term);

        const writeCallsBefore = Write.mock.calls.length;
        menuItem('Paste')!.click();
        await Promise.resolve();

        expect((term as unknown as { pasted: string[] }).pasted).toHaveLength(0);
        expect(Write).toHaveBeenCalledTimes(writeCallsBefore);
    });

    it('Clear calls term.clear()', async () => {
        const { createAndWireTerminal } = await import('./xterm');
        const container = document.createElement('div');
        createAndWireTerminal(container, 'sid-ctx-6');
        const term = lastTerm();
        rightClick(term);

        expect((term as unknown as { clearCalls: number }).clearCalls).toBe(0);
        menuItem('Clear')!.click();
        expect((term as unknown as { clearCalls: number }).clearCalls).toBe(1);
    });

    it('clicking an outside pointer target dismisses the menu', async () => {
        const { createAndWireTerminal } = await import('./xterm');
        const container = document.createElement('div');
        createAndWireTerminal(container, 'sid-ctx-7');
        const term = lastTerm();
        rightClick(term);
        expect(menuInDom()).toBe(true);

        // Simulate a pointer interaction outside the menu. jsdom does not
        // define PointerEvent, so a MouseEvent with the same type triggers the
        // capture-phase `pointerdown` listener (the handler only reads e.target).
        document.body.dispatchEvent(
            new MouseEvent('pointerdown', { bubbles: true, cancelable: true }),
        );
        expect(menuInDom()).toBe(false);
    });

    it('Escape key dismisses the menu', async () => {
        const { createAndWireTerminal } = await import('./xterm');
        const container = document.createElement('div');
        createAndWireTerminal(container, 'sid-ctx-8');
        const term = lastTerm();
        rightClick(term);
        expect(menuInDom()).toBe(true);

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(menuInDom()).toBe(false);
    });

    it('dispose() removes the listener so a later right-click does nothing', async () => {
        const { createAndWireTerminal } = await import('./xterm');
        const container = document.createElement('div');
        const wired = createAndWireTerminal(container, 'sid-ctx-9');
        const term = lastTerm();

        // First right-click: menu appears and the terminal is focused.
        rightClick(term);
        expect(menuInDom()).toBe(true);
        expect(term.focused).toBe(true);
        dismissAllMenus();

        wired.dispose();

        // Second right-click after dispose: no menu, and focus is not re-set
        // (the handler has been detached from the element).
        term.focused = false;
        rightClick(term);
        expect(menuInDom()).toBe(false);
        expect(term.focused).toBe(false);
    });

    it('keyboard paste regression: term.emitData still writes base64 to App.Write', async () => {
        const { createAndWireTerminal } = await import('./xterm');
        const container = document.createElement('div');
        createAndWireTerminal(container, 'sid-ctx-10');
        const term = lastTerm();
        const writeCallsBefore = Write.mock.calls.length;

        term.emitData('X');

        expect(Write).toHaveBeenCalledTimes(writeCallsBefore + 1);
        expect(Write).toHaveBeenLastCalledWith('sid-ctx-10', btoa('X'));
    });
});
