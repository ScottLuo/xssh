import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Host } from './types';
import { SELECT_HOST_EVENT } from './types';

function makeHost(overrides: Partial<Host> = {}): Host {
    return {
        id: 'h1',
        name: 'Prod',
        host: '10.0.0.1',
        port: 22,
        user: 'root',
        auth_type: 'key',
        auth_secret: 'secret',
        shell: '',
        init_cmds: [],
        color: '#3498db',
        created_at: '2026-10-09T00:00:00Z',
        updated_at: '2026-10-09T00:00:00Z',
        ...overrides,
    };
}

/**
 * A fake WiredTerminal that records constructor/fit/focus/dispose calls.
 * Mirrors the xterm.ts API without pulling in xterm.js.
 */
interface WiredState {
    cols: number;
    rows: number;
    sid: string;
    fitCalls: number;
    focusCalls: number;
    disposeCalls: number;
    closedCalls: number;
    term: {
        focus: () => void;
        dispose: () => void;
        /** Mutable xterm.js options, updated live by TabManager.applySettings. */
        options: { fontSize: number; scrollback: number };
    };
    termFocussed: boolean;
}
function fakeWired(
    sid: string,
    cols = 80,
    rows = 24,
    opts?: { fontSize?: number; scrollbackLines?: number },
):
    { state: WiredState; fit: { fit: () => void }; term: WiredState['term']; dispose: () => void } {
    const state: WiredState = {
        cols, rows, sid,
        fitCalls: 0, focusCalls: 0, disposeCalls: 0, closedCalls: 0,
        term: {
            focus: () => { state.focusCalls += 1; state.termFocussed = true; },
            dispose: () => { state.term.disposeCalls = (state.term.disposeCalls ?? 0) + 1; },
            options: {
                fontSize: opts?.fontSize ?? 14,
                scrollback: opts?.scrollbackLines ?? 1000,
            },
        },
        termFocussed: false,
    };
    const fit = { fit: () => { state.fitCalls += 1; } };
    const dispose = () => { state.disposeCalls += 1; };
    return { state, fit, term: state.term, dispose };
}

function setupTabsMocks(settings?: { fontSize: number; scrollbackLines: number }) {
    const OpenTab = vi.fn().mockImplementation(
        (_hostId: string, cols: number, rows: number) =>
            Promise.resolve(`sid_${cols}_${rows}_${Math.random()}`),
    );
    const CloseTab = vi.fn().mockResolvedValue(undefined);
    // Capture every EventsOn registration so tests can fire `ssh:closed:*`.
    const subs = new Map<string, () => void>();
    const EventsOn = vi.fn((event: string, cb: () => void) => {
        subs.set(event, cb);
        return vi.fn();
    });
    vi.doMock('../wailsjs/go/main/App', () => ({ OpenTab, CloseTab }));
    vi.doMock('../wailsjs/runtime/runtime', () => ({ EventsOn }));
    // Mock the settings module so initTabs can load settings without a backend.
    const loadTerminalSettings = vi.fn().mockResolvedValue({
        fontSize: settings?.fontSize ?? 14,
        scrollbackLines: settings?.scrollbackLines ?? 1000,
    });
    vi.doMock('./settings', () => ({
        loadTerminalSettings,
        saveTerminalSettings: vi.fn().mockResolvedValue(undefined),
    }));
    // Capture the settings options passed to createAndWireTerminal on each call.
    const createOpts: Array<{ fontSize?: number; scrollbackLines?: number }> = [];
    // Record the fake wired instances so tests can inspect live option mutation.
    const created: Array<{ term: { options: { fontSize: number; scrollback: number } } }> = [];
    vi.doMock('./xterm', () => ({
        createAndWireTerminal: vi.fn((_c: HTMLDivElement, sid: string, opts?: {
            fontSize?: number; scrollbackLines?: number;
        }) => {
            const wired = fakeWired(sid, 80, 24, opts);
            createOpts.push(opts ?? {});
            created.push(wired);
            return wired;
        }),
    }));
    return {
        OpenTab,
        CloseTab,
        EventsOn,
        loadTerminalSettings,
        createOpts,
        created,
        fireClosed: (sid: string) => {
            const cb = subs.get(`ssh:closed:${sid}`);
            if (cb) cb();
        },
    };
}

/** Dispatch SELECT_HOST_EVENT with the given host on document. */
function selectHost(host: Host): void {
    document.dispatchEvent(new CustomEvent(SELECT_HOST_EVENT, { detail: host }));
}

/** Helper: find a tab element by its label text. */
function findTabByLabel(container: HTMLElement, label: string): HTMLElement | null {
    const tabs = Array.from(container.querySelectorAll('.tab'));
    return tabs.find((t) => t.querySelector('.tab-label')?.textContent?.includes(label)) ?? null;
}

/** Helper: click a tab element to switch to it. */
function clickTab(el: HTMLElement): void {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

/** Helper: click the close button on a tab element. */
function closeTab(el: HTMLElement): void {
    const closeBtn = el.querySelector('.tab-close')!;
    closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

/** Helper: click the [+] add-tab button. */
function clickAdd(container: HTMLElement): void {
    const addBtn = container.querySelector('.tab-add')!;
    addBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

/** Helper: get the active (selected) tab element. */
function getActiveTab(container: HTMLElement): HTMLElement | null {
    return container.querySelector('.tab[aria-selected="true"]') ??
        container.querySelector('.tab.active');
}

describe('initTabs', () => {
    beforeEach(async () => {
        vi.resetModules();
        document.body.innerHTML = '<div id="panel"></div>';
    });

    it('renders the tab strip and terminal area', async () => {
        setupTabsMocks();
        const { initTabs } = await import('./tabs');
        const container = document.getElementById('panel')!;
        initTabs(container);

        expect(container.querySelector('.tab-strip')).not.toBeNull();
        expect(container.querySelector('.terminal-area')).not.toBeNull();
        expect(container.querySelector('.tab-add')).not.toBeNull();
    });

    it('shows the empty state when no host is selected', async () => {
        setupTabsMocks();
        const { initTabs } = await import('./tabs');
        const container = document.getElementById('panel')!;
        initTabs(container);

        const empty = container.querySelector('.empty-state')!;
        expect(empty.textContent).toContain('Select a host');
        // [+] button is disabled when no host is selected.
        expect((container.querySelector('.tab-add') as HTMLButtonElement).disabled).toBe(true);
    });

    it('selects a host and enables the [+] button', async () => {
        setupTabsMocks();
        const { initTabs } = await import('./tabs');
        const container = document.getElementById('panel')!;
        initTabs(container);

        selectHost(makeHost());

        const empty = container.querySelector('.empty-state')!;
        expect(empty.textContent).toContain('No terminal yet');
        expect((container.querySelector('.tab-add') as HTMLButtonElement).disabled).toBe(false);
    });

    it('opens a tab when [+] is clicked with an active host', async () => {
        const mocks = setupTabsMocks();
        const { initTabs } = await import('./tabs');
        const container = document.getElementById('panel')!;
        initTabs(container);

        const host = makeHost({ name: 'Prod' });
        selectHost(host);
        clickAdd(container);
        // Wait for the async OpenTab to resolve.
        await new Promise((r) => setTimeout(r, 0));

        expect(mocks.OpenTab).toHaveBeenCalledTimes(1);
        expect(container.querySelectorAll('.tab').length).toBe(1);
        const label = container.querySelector('.tab-label')!;
        expect(label.textContent).toContain('Prod');
    });

    it('opens a tab when a host card event fires via SELECT_HOST_EVENT and user clicks [+]', async () => {
        const mocks = setupTabsMocks();
        const { initTabs } = await import('./tabs');
        const container = document.getElementById('panel')!;
        initTabs(container);

        const host = makeHost({ id: 'hA', name: 'HostA' });
        selectHost(host);
        clickAdd(container);
        await new Promise((r) => setTimeout(r, 0));

        expect(mocks.OpenTab).toHaveBeenCalledWith('hA', 80, 24);
        expect(container.querySelectorAll('.tab').length).toBe(1);
    });

    it('switches tabs when a different tab is clicked', async () => {
        setupTabsMocks();
        const { initTabs } = await import('./tabs');
        const container = document.getElementById('panel')!;
        initTabs(container);

        const host = makeHost({ name: 'Prod' });
        selectHost(host);

        // Open two tabs.
        clickAdd(container);
        await new Promise((r) => setTimeout(r, 0));
        clickAdd(container);
        await new Promise((r) => setTimeout(r, 0));

        expect(container.querySelectorAll('.tab').length).toBe(2);

        // The second tab should be active by default (most recently opened).
        const activeTab = getActiveTab(container);
        expect(activeTab).not.toBeNull();

        // Click the first tab to switch to it.
        const firstTab = findTabByLabel(container, 'Prod')!;
        clickTab(firstTab);

        // The first tab should now be active.
        const newActive = getActiveTab(container);
        expect(newActive).toBe(firstTab);
    });

    it('closes a tab when the close button is clicked', async () => {
        const mocks = setupTabsMocks();
        const { initTabs } = await import('./tabs');
        const container = document.getElementById('panel')!;
        initTabs(container);

        const host = makeHost({ name: 'Prod' });
        selectHost(host);
        clickAdd(container);
        await new Promise((r) => setTimeout(r, 0));

        expect(container.querySelectorAll('.tab').length).toBe(1);
        const sid = await (mocks.OpenTab.mock.results[0].value as Promise<string>);

        // Close the tab.
        const tab = container.querySelector('.tab')!;
        closeTab(tab);

        expect(mocks.CloseTab).toHaveBeenCalledWith(sid);
        expect(container.querySelectorAll('.tab').length).toBe(0);
        // Empty state should show again.
        const empty = container.querySelector('.empty-state')!;
        expect(empty.textContent).toContain('No terminal yet');
    });

    it('switches to a remaining tab when the active tab is closed', async () => {
        setupTabsMocks();
        const { initTabs } = await import('./tabs');
        const container = document.getElementById('panel')!;
        initTabs(container);

        const host = makeHost({ name: 'Prod' });
        selectHost(host);

        // Open two tabs.
        clickAdd(container);
        await new Promise((r) => setTimeout(r, 0));
        clickAdd(container);
        await new Promise((r) => setTimeout(r, 0));

        expect(container.querySelectorAll('.tab').length).toBe(2);

        // Close the active (second) tab; the first should become active.
        const activeTab = getActiveTab(container)!;
        closeTab(activeTab);

        expect(container.querySelectorAll('.tab').length).toBe(1);
        // The remaining tab should be active.
        const remaining = container.querySelector('.tab')!;
        expect(remaining.getAttribute('aria-selected')).toBe('true');
    });

    it('shows an error tab when App.OpenTab rejects', async () => {
        const mocks = setupTabsMocks();
        mocks.OpenTab.mockRejectedValueOnce(new Error('connection refused'));
        const { initTabs } = await import('./tabs');
        const container = document.getElementById('panel')!;
        initTabs(container);

        const host = makeHost({ name: 'Prod' });
        selectHost(host);
        clickAdd(container);
        await new Promise((r) => setTimeout(r, 0));

        // An error tab with a label suffix is created.
        const label = container.querySelector('.tab-label')!;
        expect(label.textContent).toContain('(error)');
        expect(container.querySelector('.terminal-container')!.textContent)
            .toContain('Connection error');
    });

    it('navigates between tabs with ArrowRight and ArrowLeft keys', async () => {
        setupTabsMocks();
        const { initTabs } = await import('./tabs');
        const container = document.getElementById('panel')!;
        initTabs(container);

        const host = makeHost({ name: 'Prod' });
        selectHost(host);

        // Open two tabs.
        clickAdd(container);
        await new Promise((r) => setTimeout(r, 0));
        clickAdd(container);
        await new Promise((r) => setTimeout(r, 0));

        // Second tab is active by default.
        const active1 = getActiveTab(container)!;
        expect(active1).not.toBeNull();

        const tabStrip = container.querySelector('.tab-strip')!;

        // ArrowRight should wrap to the first tab.
        tabStrip.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'ArrowRight', bubbles: true, cancelable: true,
        }));
        const activeTab1 = getActiveTab(container)!;
        expect(activeTab1).not.toBeNull();
        // Should be the first tab now (wrapped).

        // ArrowLeft should go to the second tab.
        tabStrip.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'ArrowLeft', bubbles: true, cancelable: true,
        }));
        const activeTab2 = getActiveTab(container)!;
        expect(activeTab2).not.toBeNull();
        expect(activeTab2).toBe(active1);
    });

    it('per-host tab isolation: tabs from different hosts are hidden when switching', async () => {
        setupTabsMocks();
        const { initTabs } = await import('./tabs');
        const container = document.getElementById('panel')!;
        initTabs(container);

        const hostA = makeHost({ id: 'hA', name: 'HostA' });
        const hostB = makeHost({ id: 'hB', name: 'HostB' });

        // Open a tab for HostA.
        selectHost(hostA);
        clickAdd(container);
        await new Promise((r) => setTimeout(r, 0));
        expect(container.querySelectorAll('.tab').length).toBe(1);

        // Switch to HostB: HostA's tab should be hidden.
        selectHost(hostB);
        const visibleTabs = Array.from(container.querySelectorAll('.tab')).filter(
            (t) => !(t as HTMLElement).classList.contains('hidden'),
        );
        expect(visibleTabs.length).toBe(0);

        // Open a tab for HostB.
        clickAdd(container);
        await new Promise((r) => setTimeout(r, 0));
        const visibleTabs2 = Array.from(container.querySelectorAll('.tab')).filter(
            (t) => !(t as HTMLElement).classList.contains('hidden'),
        );
        expect(visibleTabs2.length).toBe(1);

        // Switch back to HostA: its tab should be visible again.
        selectHost(hostA);
        const visibleTabs3 = Array.from(container.querySelectorAll('.tab')).filter(
            (t) => !(t as HTMLElement).classList.contains('hidden'),
        );
        expect(visibleTabs3.length).toBe(1);
    });

    it('restores the last active tab when switching back to a host', async () => {
        setupTabsMocks();
        const { initTabs } = await import('./tabs');
        const container = document.getElementById('panel')!;
        initTabs(container);

        const hostA = makeHost({ id: 'hA', name: 'HostA' });
        const hostB = makeHost({ id: 'hB', name: 'HostB' });

        // Open two tabs for HostA.
        selectHost(hostA);
        clickAdd(container);
        await new Promise((r) => setTimeout(r, 0));
        clickAdd(container);
        await new Promise((r) => setTimeout(r, 0));

        // Switch to HostB.
        selectHost(hostB);

        // Switch back to HostA — should restore the last active tab.
        selectHost(hostA);
        const visibleTabs = Array.from(container.querySelectorAll('.tab')).filter(
            (t) => !(t as HTMLElement).classList.contains('hidden'),
        );
        expect(visibleTabs.length).toBe(2);
        // The active tab should be the second one (last active).
        const activeTab = getActiveTab(container)!;
        expect(activeTab).not.toBeNull();
        expect(activeTab.getAttribute('aria-selected')).toBe('true');
    });

    it('passes loaded settings to createAndWireTerminal when opening a new tab', async () => {
        const mocks = setupTabsMocks({ fontSize: 22, scrollbackLines: 5000 });
        const { initTabs } = await import('./tabs');
        const container = document.getElementById('panel')!;
        initTabs(container);

        const host = makeHost({ name: 'Prod' });
        selectHost(host);
        clickAdd(container);
        // allow initTabs' loadTerminalSettings() to resolve
        await new Promise((r) => setTimeout(r, 0));
        // allow the openTab OpenTab call to resolve
        await new Promise((r) => setTimeout(r, 0));

        expect(mocks.loadTerminalSettings).toHaveBeenCalled();
        expect(mocks.createOpts.length).toBe(1);
        expect(mocks.createOpts[0]).toEqual({ fontSize: 22, scrollbackLines: 5000 });
    });

    it('applies settings live to open terminals when SETTINGS_CHANGED_EVENT fires', async () => {
        const mocks = setupTabsMocks();
        const { initTabs } = await import('./tabs');
        const container = document.getElementById('panel')!;
        initTabs(container);

        const host = makeHost({ name: 'Prod' });
        selectHost(host);
        clickAdd(container);
        // allow initTabs' loadTerminalSettings() to resolve
        await new Promise((r) => setTimeout(r, 0));
        // allow the openTab OpenTab call to resolve
        await new Promise((r) => setTimeout(r, 0));

        // One fake wired terminal now exists; its options start at the defaults.
        expect(mocks.created.length).toBe(1);
        const wired = mocks.created[0];
        expect(wired.term.options).toEqual({ fontSize: 14, scrollback: 1000 });

        // Dispatch the settings-changed event; TabManager.applySettings should
        // mutate the open terminal's options live.
        const { SETTINGS_CHANGED_EVENT } = await import('./types');
        document.dispatchEvent(new CustomEvent(SETTINGS_CHANGED_EVENT, {
            detail: { fontSize: 30, scrollbackLines: 10000 },
        }));

        // The xterm.js option `scrollback` maps from `scrollbackLines`.
        expect(wired.term.options.fontSize).toBe(30);
        expect(wired.term.options.scrollback).toBe(10000);
    });

    it('ignores SETTINGS_CHANGED_EVENT payloads with a non-numeric fontSize', async () => {
        const mocks = setupTabsMocks();
        const { initTabs } = await import('./tabs');
        const container = document.getElementById('panel')!;
        initTabs(container);

        const host = makeHost({ name: 'Prod' });
        selectHost(host);
        clickAdd(container);
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));

        expect(mocks.created.length).toBe(1);
        const wired = mocks.created[0];
        const { SETTINGS_CHANGED_EVENT } = await import('./types');

        // Invalid payload: no numeric fontSize → listener should not apply.
        document.dispatchEvent(new CustomEvent(SETTINGS_CHANGED_EVENT, {
            detail: { scrollbackLines: 500 },
        }));
        // Options remain the initial defaults because the guard rejected the payload.
        expect(wired.term.options.fontSize).toBe(14);
        expect(wired.term.options.scrollback).toBe(1000);
    });
});
