import { describe, it, expect, vi, beforeEach } from 'vitest';
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
