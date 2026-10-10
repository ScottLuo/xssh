/**
 * Unit tests for the Wails v2 generated binding stub files.
 * Validates that:
 * - App.js exports all 11 named functions and delegates to window['go']['main']['App']
 * - runtime.js exports all event/window/log functions with correct semantics
 * - EventsOn returns a string ID, EventsOff removes by ID, EventsOnce fires once
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Helper to import a module as a record of functions (avoids TS type narrowing)
async function importAsRecord(path: string): Promise<Record<string, unknown>> {
    return await import(path) as unknown as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// App.js stub tests
// ---------------------------------------------------------------------------
describe('wailsjs/go/main/App.js', () => {
    const METHOD_NAMES = [
        'CloseTab', 'DeleteHost', 'GetHosts', 'GetSettings',
        'OpenTab', 'Resize', 'SaveHost', 'SetSetting',
        'SetupDB', 'UnlockDB', 'Write',
    ] as const;

    beforeEach(() => {
        vi.resetModules();
        // Set up a fake Wails bridge
        const bridge: Record<string, ReturnType<typeof vi.fn>> = {};
        for (const name of METHOD_NAMES) {
            bridge[name] = vi.fn().mockResolvedValue(undefined);
        }
        Object.assign(window, { go: { main: { App: bridge } } });
    });

    afterEach(() => {
        delete (window as unknown as Record<string, unknown>)['go'];
    });

    it('exports all 11 named functions', async () => {
        const mod = await importAsRecord('./go/main/App.js');
        for (const name of METHOD_NAMES) {
            expect(typeof mod[name]).toBe('function');
        }
    });

    it('does NOT export an App class', async () => {
        const mod = await importAsRecord('./go/main/App.js');
        expect(mod['App']).toBeUndefined();
        expect(mod['default']).toBeUndefined();
    });

    it('GetHosts delegates to window.go.main.App.GetHosts with no args', async () => {
        const { GetHosts } = await import('./go/main/App.js');
        const bridge = (window as unknown as Record<string, any>).go.main.App;
        bridge.GetHosts.mockResolvedValue([{ id: 'h1' }]);

        const result = await GetHosts();
        expect(bridge.GetHosts).toHaveBeenCalledTimes(1);
        expect(bridge.GetHosts).toHaveBeenCalledWith();
        expect(result).toEqual([{ id: 'h1' }]);
    });

    it('SaveHost delegates with a single argument', async () => {
        const { SaveHost } = await import('./go/main/App.js');
        const bridge = (window as unknown as Record<string, any>).go.main.App;

        await SaveHost({ id: 'h1', name: 'test' });
        expect(bridge.SaveHost).toHaveBeenCalledWith({ id: 'h1', name: 'test' });
    });

    it('OpenTab delegates with three arguments', async () => {
        const { OpenTab } = await import('./go/main/App.js');
        const bridge = (window as unknown as Record<string, any>).go.main.App;
        bridge.OpenTab.mockResolvedValue('sid-42');

        const sid = await OpenTab('host1', 80, 24);
        expect(bridge.OpenTab).toHaveBeenCalledWith('host1', 80, 24);
        expect(sid).toBe('sid-42');
    });

    it('Write delegates with two arguments', async () => {
        const { Write } = await import('./go/main/App.js');
        const bridge = (window as unknown as Record<string, any>).go.main.App;

        await Write('sid1', 'aGVsbG8=');
        expect(bridge.Write).toHaveBeenCalledWith('sid1', 'aGVsbG8=');
    });

    it('Resize delegates with three arguments', async () => {
        const { Resize } = await import('./go/main/App.js');
        const bridge = (window as unknown as Record<string, any>).go.main.App;

        await Resize('sid1', 120, 40);
        expect(bridge.Resize).toHaveBeenCalledWith('sid1', 120, 40);
    });

    it('CloseTab delegates with one argument', async () => {
        const { CloseTab } = await import('./go/main/App.js');
        const bridge = (window as unknown as Record<string, any>).go.main.App;

        await CloseTab('sid-99');
        expect(bridge.CloseTab).toHaveBeenCalledWith('sid-99');
    });

    it('UnlockDB delegates with one argument', async () => {
        const { UnlockDB } = await import('./go/main/App.js');
        const bridge = (window as unknown as Record<string, any>).go.main.App;

        await UnlockDB('secret');
        expect(bridge.UnlockDB).toHaveBeenCalledWith('secret');
    });

    it('SetupDB delegates with one argument', async () => {
        const { SetupDB } = await import('./go/main/App.js');
        const bridge = (window as unknown as Record<string, any>).go.main.App;

        await SetupDB('newpass');
        expect(bridge.SetupDB).toHaveBeenCalledWith('newpass');
    });

    it('GetSettings delegates with no arguments', async () => {
        const { GetSettings } = await import('./go/main/App.js');
        const bridge = (window as unknown as Record<string, any>).go.main.App;
        bridge.GetSettings.mockResolvedValue({ theme: 'dark' });

        const settings = await GetSettings();
        expect(bridge.GetSettings).toHaveBeenCalledWith();
        expect(settings).toEqual({ theme: 'dark' });
    });

    it('SetSetting delegates with two arguments', async () => {
        const { SetSetting } = await import('./go/main/App.js');
        const bridge = (window as unknown as Record<string, any>).go.main.App;

        await SetSetting('theme', 'light');
        expect(bridge.SetSetting).toHaveBeenCalledWith('theme', 'light');
    });

    it('DeleteHost delegates with one argument', async () => {
        const { DeleteHost } = await import('./go/main/App.js');
        const bridge = (window as unknown as Record<string, any>).go.main.App;

        await DeleteHost('h42');
        expect(bridge.DeleteHost).toHaveBeenCalledWith('h42');
    });
});

// ---------------------------------------------------------------------------
// runtime.js stub tests — event system
// ---------------------------------------------------------------------------
describe('wailsjs/runtime/runtime.js — Events', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it('EventsOn, EventsOff, EventsOnce, EventsEmit, EventsOffAll are all functions', async () => {
        const mod = await importAsRecord('./runtime/runtime.js');
        expect(typeof mod['EventsOn']).toBe('function');
        expect(typeof mod['EventsOff']).toBe('function');
        expect(typeof mod['EventsOnce']).toBe('function');
        expect(typeof mod['EventsEmit']).toBe('function');
        expect(typeof mod['EventsOffAll']).toBe('function');
    });

    it('does NOT export an Events const object', async () => {
        const mod = await importAsRecord('./runtime/runtime.js');
        expect(mod['Events']).toBeUndefined();
    });

    it('EventsOn returns a string ID', async () => {
        const { EventsOn } = await import('./runtime/runtime.js');
        const id = EventsOn('test-event', vi.fn());
        expect(typeof id).toBe('string');
        expect(id.length).toBeGreaterThan(0);
    });

    it('EventsOn returns unique IDs for successive calls', async () => {
        const { EventsOn } = await import('./runtime/runtime.js');
        const id1 = EventsOn('evt', vi.fn());
        const id2 = EventsOn('evt', vi.fn());
        expect(id1).not.toBe(id2);
    });

    it('EventsEmit invokes the registered callback', async () => {
        const { EventsOn, EventsEmit } = await import('./runtime/runtime.js');
        const cb = vi.fn();
        EventsOn('greet', cb);

        EventsEmit('greet', 'hello');
        expect(cb).toHaveBeenCalledTimes(1);
        expect(cb).toHaveBeenCalledWith('hello');
    });

    it('EventsEmit with no registered listeners does not throw', async () => {
        const { EventsEmit } = await import('./runtime/runtime.js');
        expect(() => EventsEmit('no-listener-event', 1, 2)).not.toThrow();
    });

    it('EventsEmit invokes all registered callbacks for the same event', async () => {
        const { EventsOn, EventsEmit } = await import('./runtime/runtime.js');
        const cb1 = vi.fn();
        const cb2 = vi.fn();
        EventsOn('multi', cb1);
        EventsOn('multi', cb2);

        EventsEmit('multi', 'data');
        expect(cb1).toHaveBeenCalledWith('data');
        expect(cb2).toHaveBeenCalledWith('data');
    });

    it('EventsOff removes exactly the specified listener', async () => {
        const { EventsOn, EventsOff, EventsEmit } = await import('./runtime/runtime.js');
        const cb1 = vi.fn();
        const cb2 = vi.fn();
        const id1 = EventsOn('evt', cb1);
        const id2 = EventsOn('evt', cb2);

        EventsOff('evt', id1);
        EventsEmit('evt', 'x');
        expect(cb1).not.toHaveBeenCalled();
        expect(cb2).toHaveBeenCalledWith('x');
    });

    it('EventsOff with multiple IDs removes all specified', async () => {
        const { EventsOn, EventsOff, EventsEmit } = await import('./runtime/runtime.js');
        const cb1 = vi.fn();
        const cb2 = vi.fn();
        const cb3 = vi.fn();
        const id1 = EventsOn('evt', cb1);
        const id2 = EventsOn('evt', cb2);
        const _id3 = EventsOn('evt', cb3);

        EventsOff('evt', id1, id2);
        EventsEmit('evt', 'x');
        expect(cb1).not.toHaveBeenCalled();
        expect(cb2).not.toHaveBeenCalled();
        expect(cb3).toHaveBeenCalledWith('x');
    });

    it('EventsOff for an unknown event name does not throw', async () => {
        const { EventsOff } = await import('./runtime/runtime.js');
        expect(() => EventsOff('unknown-event', 'id-99')).not.toThrow();
    });

    it('EventsOnce fires the callback exactly once', async () => {
        const { EventsOnce, EventsEmit } = await import('./runtime/runtime.js');
        const cb = vi.fn();
        EventsOnce('once-event', cb);

        EventsEmit('once-event', 1);
        EventsEmit('once-event', 2);
        expect(cb).toHaveBeenCalledTimes(1);
        expect(cb).toHaveBeenCalledWith(1);
    });

    it('EventsOnce returns a string ID', async () => {
        const { EventsOnce } = await import('./runtime/runtime.js');
        const id = EventsOnce('once', vi.fn());
        expect(typeof id).toBe('string');
    });

    it('EventsOffAll removes all listeners for all events', async () => {
        const { EventsOn, EventsOffAll, EventsEmit } = await import('./runtime/runtime.js');
        const cb1 = vi.fn();
        const cb2 = vi.fn();
        EventsOn('a', cb1);
        EventsOn('b', cb2);

        EventsOffAll();
        EventsEmit('a');
        EventsEmit('b');
        expect(cb1).not.toHaveBeenCalled();
        expect(cb2).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// runtime.js stub tests — Window functions
// ---------------------------------------------------------------------------
describe('wailsjs/runtime/runtime.js — Window', () => {
    const WINDOW_FUNCS = [
        'WindowMinimise', 'WindowMaximise', 'WindowUnmaximise',
        'WindowFullscreen', 'WindowUnfullscreen', 'WindowClose',
    ] as const;

    beforeEach(() => {
        vi.resetModules();
    });

    it('exports all Window functions', async () => {
        const mod = await importAsRecord('./runtime/runtime.js');
        for (const name of WINDOW_FUNCS) {
            expect(typeof mod[name]).toBe('function');
        }
    });

    it.each(WINDOW_FUNCS)('%s delegates to window.runtime.%s', async (name) => {
        const fn = vi.fn();
        Object.assign(window, { runtime: { [name]: fn } });
        const mod = await importAsRecord('./runtime/runtime.js');
        (mod[name] as () => void)();
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('Window functions do not throw when window.runtime is undefined', async () => {
        delete (window as unknown as Record<string, unknown>)['runtime'];
        const mod = await importAsRecord('./runtime/runtime.js');
        for (const name of WINDOW_FUNCS) {
            expect(() => (mod[name] as () => void)()).not.toThrow();
        }
    });
});

// ---------------------------------------------------------------------------
// runtime.js stub tests — Log functions
// ---------------------------------------------------------------------------
describe('wailsjs/runtime/runtime.js — Log', () => {
    const LOG_CASES: Array<[string, number]> = [
        ['LogPrint', 1],
        ['LogTrace', 0],
        ['LogDebug', 4],
        ['LogInfo', 2],
        ['LogWarning', 3],
        ['LogError', 5],
        ['LogFatal', 6],
    ];

    beforeEach(() => {
        vi.resetModules();
    });

    it.each(LOG_CASES)('%s calls window.runtime.Log(%d, message)', async (name, level) => {
        const logFn = vi.fn();
        Object.assign(window, { runtime: { Log: logFn } });
        const mod = await importAsRecord('./runtime/runtime.js');
        (mod[name] as (msg: string) => void)('test message');
        expect(logFn).toHaveBeenCalledWith(level, 'test message');
    });

    it('Log functions do not throw when window.runtime is undefined', async () => {
        delete (window as unknown as Record<string, unknown>)['runtime'];
        const mod = await importAsRecord('./runtime/runtime.js');
        for (const [name] of LOG_CASES) {
            expect(() => (mod[name] as (msg: string) => void)('msg')).not.toThrow();
        }
    });
});
