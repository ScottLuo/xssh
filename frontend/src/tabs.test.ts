import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Host } from './types';
import { OPEN_TAB_EVENT } from './types';

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

/** Build a fake WiredTerminal matching what xterm.ts returns. */
function fakeWired() {
    const term = { focused: false, focus: () => { term.focused = true; } };
    const fit = { fitted: 0, fit: () => { fit.fitted += 1; } };
    const disposed = { value: false, dispose: () => { disposed.value = true; } };
    return {
        term,
        fit,
        dispose: disposed.dispose,
        state: { term, fit, disposed },
    };
}

let wiredFactory: ReturnType<typeof fakeWired>;
let OpenTab: ReturnType<typeof vi.fn>;
let CloseTab: ReturnType<typeof vi.fn>;

function setupTabsMocks() {
    OpenTab = vi.fn();
    CloseTab = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../wailsjs/go/main/App', () => ({ OpenTab, CloseTab }));
    vi.doMock('../wailsjs/runtime/runtime', () => ({
        EventsOn: vi.fn(() => vi.fn()),
    }));
    vi.doMock('./xterm', () => ({
        createAndWireTerminal: vi.fn(() => wiredFactory),
    }));
}

async function loadTabs() {
    return import('./tabs');
}

beforeEach(async () => {
    vi.resetModules();
    document.body.innerHTML = '<div id="panel"></div>';
});

describe('initTabs', () => {
    it('renders the tab strip and terminal area', async () => {
        setupTabsMocks();
        const { initTabs } = await loadTabs();
        const container = document.getElementById('panel')!;
        initTabs(container);

        expect(container.querySelector('.tab-strip')).not.toBeNull();
        expect(container.querySelector('.terminal-area')).not.toBeNull();
        // Empty state is visible when there are no tabs.
        expect(container.querySelector('.empty-state')).not.toBeNull();
    });

    it('opens a terminal tab when an open-tab event fires', async () => {
        setupTabsMocks();
        wiredFactory = fakeWired();
        OpenTab.mockResolvedValue('sid-1');

        const { initTabs } = await loadTabs();
        const container = document.getElementById('panel')!;
        initTabs(container);

        const host = makeHost();
        document.dispatchEvent(new CustomEvent(OPEN_TAB_EVENT, { detail: host }));
        await new Promise((r) => setTimeout(r, 0));

        expect(OpenTab).toHaveBeenCalledWith('h1', 80, 24);
        // A tab element was created.
        expect(container.querySelector('.tab')).not.toBeNull();
        expect(container.querySelector('.tab-label')!.textContent).toContain('Prod');
        // The terminal container was added to the terminal area.
        expect(container.querySelector('.terminal-container')).not.toBeNull();
    });

    it('closes the tab and calls CloseTab when the close button is clicked', async () => {
        setupTabsMocks();
        wiredFactory = fakeWired();
        OpenTab.mockResolvedValue('sid-2');

        const { initTabs } = await loadTabs();
        const container = document.getElementById('panel')!;
        initTabs(container);

        document.dispatchEvent(
            new CustomEvent(OPEN_TAB_EVENT, { detail: makeHost() }),
        );
        await new Promise((r) => setTimeout(r, 0));
        expect(container.querySelector('.tab')).not.toBeNull();

        // Click the close button on the tab.
        const closeBtn = container.querySelector('.tab-close')!;
        closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));

        expect(CloseTab).toHaveBeenCalledWith('sid-2');
        expect(container.querySelector('.tab')).toBeNull();
        expect(wiredFactory.state.disposed.value).toBe(true);
    });

    it('switches between two open tabs and focuses the active one', async () => {
        setupTabsMocks();
        OpenTab.mockResolvedValueOnce('sid-A').mockResolvedValueOnce('sid-B');
        const wiredA = fakeWired();
        const wiredB = fakeWired();
        const create = vi.fn()
            .mockReturnValueOnce(wiredA)
            .mockReturnValueOnce(wiredB);
        vi.doMock('./xterm', () => ({
            createAndWireTerminal: create,
        }));

        const { initTabs } = await loadTabs();
        const container = document.getElementById('panel')!;
        initTabs(container);

        document.dispatchEvent(new CustomEvent(OPEN_TAB_EVENT, {
            detail: makeHost({ id: 'hA', name: 'HostA' }),
        }));
        await new Promise((r) => setTimeout(r, 0));
        document.dispatchEvent(new CustomEvent(OPEN_TAB_EVENT, {
            detail: makeHost({ id: 'hB', name: 'HostB' }),
        }));
        await new Promise((r) => setTimeout(r, 0));

        expect(container.querySelectorAll('.tab').length).toBe(2);
        // Tab B is now active; only its container is visible.
        const activeTab = container.querySelector('.tab.active')!;
        expect(activeTab.querySelector('.tab-label')!.textContent)
            .toContain('HostB');
        const hidden = container.querySelectorAll('.terminal-container.hidden');
        expect(hidden.length).toBe(1);
        expect(wiredB.state.term.focused).toBe(true);
        // Switch back to tab A by clicking it.
        const tabA = [...container.querySelectorAll('.tab')]
            .find((t) => t.querySelector('.tab-label')!.textContent!
                .includes('HostA'))!;
        tabA.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(tabA.classList.contains('active')).toBe(true);
        expect(wiredA.state.term.focused).toBe(true);
    });

    it('switches to a remaining tab when the active tab is closed', async () => {
        setupTabsMocks();
        OpenTab.mockResolvedValueOnce('sid-C')
            .mockResolvedValueOnce('sid-D');
        const wiredC = fakeWired();
        const wiredD = fakeWired();
        const create = vi.fn()
            .mockReturnValueOnce(wiredC)
            .mockReturnValueOnce(wiredD);
        vi.doMock('./xterm', () => ({
            createAndWireTerminal: create,
        }));

        const { initTabs } = await loadTabs();
        const container = document.getElementById('panel')!;
        initTabs(container);

        document.dispatchEvent(new CustomEvent(OPEN_TAB_EVENT, {
            detail: makeHost({ id: 'hC', name: 'HostC' }),
        }));
        await new Promise((r) => setTimeout(r, 0));
        document.dispatchEvent(new CustomEvent(OPEN_TAB_EVENT, {
            detail: makeHost({ id: 'hD', name: 'HostD' }),
        }));
        await new Promise((r) => setTimeout(r, 0));

        // Close the active tab (HostD); HostC should become active.
        const activeTab = container.querySelector('.tab.active')!;
        activeTab.querySelector('.tab-close')!
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));

        const remaining = container.querySelector('.tab')!;
        expect(remaining.querySelector('.tab-label')!.textContent)
            .toContain('HostC');
        expect(remaining.classList.contains('active')).toBe(true);
    });

    it('shows an error tab when App.OpenTab rejects', async () => {
        setupTabsMocks();
        wiredFactory = fakeWired();
        OpenTab.mockRejectedValue(new Error('connection refused'));

        const { initTabs } = await loadTabs();
        const container = document.getElementById('panel')!;
        initTabs(container);

        document.dispatchEvent(
            new CustomEvent(OPEN_TAB_EVENT, { detail: makeHost() }),
        );
        await new Promise((r) => setTimeout(r, 0));

        // An error tab with a label suffix is created.
        const label = container.querySelector('.tab-label')!.textContent;
        expect(label).toContain('(error)');
        expect(container.querySelector('.terminal-container')!.textContent)
            .toContain('connection refused');
    });

    it('navigates between tabs with ArrowRight and ArrowLeft keys', async () => {
        setupTabsMocks();
        OpenTab.mockResolvedValueOnce('sid-K1').mockResolvedValueOnce('sid-K2')
            .mockResolvedValueOnce('sid-K3');
        const wiredK1 = fakeWired();
        const wiredK2 = fakeWired();
        const wiredK3 = fakeWired();
        const create = vi.fn()
            .mockReturnValueOnce(wiredK1)
            .mockReturnValueOnce(wiredK2)
            .mockReturnValueOnce(wiredK3);
        vi.doMock('./xterm', () => ({
            createAndWireTerminal: create,
        }));

        const { initTabs } = await loadTabs();
        const container = document.getElementById('panel')!;
        initTabs(container);

        document.dispatchEvent(new CustomEvent(OPEN_TAB_EVENT, {
            detail: makeHost({ id: 'hK1', name: 'Alpha' }),
        }));
        await new Promise((r) => setTimeout(r, 0));
        document.dispatchEvent(new CustomEvent(OPEN_TAB_EVENT, {
            detail: makeHost({ id: 'hK2', name: 'Beta' }),
        }));
        await new Promise((r) => setTimeout(r, 0));
        document.dispatchEvent(new CustomEvent(OPEN_TAB_EVENT, {
            detail: makeHost({ id: 'hK3', name: 'Gamma' }),
        }));
        await new Promise((r) => setTimeout(r, 0));

        const tabStrip = container.querySelector('.tab-strip')!;

        // Currently Gamma (last opened) is active.
        // Press ArrowLeft → Beta should become active.
        tabStrip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
        const activeTab1 = container.querySelector('.tab.active')!;
        expect(activeTab1.querySelector('.tab-label')!.textContent).toContain('Beta');
        expect(wiredK2.state.term.focused).toBe(true);

        // Press ArrowRight → Gamma should become active again.
        tabStrip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        const activeTab2 = container.querySelector('.tab.active')!;
        expect(activeTab2.querySelector('.tab-label')!.textContent).toContain('Gamma');
        expect(wiredK3.state.term.focused).toBe(true);

        // Press ArrowLeft twice → should wrap around to Alpha (first tab).
        tabStrip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
        // Now Beta is active again.
        tabStrip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
        const activeTab3 = container.querySelector('.tab.active')!;
        expect(activeTab3.querySelector('.tab-label')!.textContent).toContain('Alpha');
        expect(wiredK1.state.term.focused).toBe(true);
    });

    it('wraps around when pressing ArrowRight on the last tab', async () => {
        setupTabsMocks();
        OpenTab.mockResolvedValueOnce('sid-W1').mockResolvedValueOnce('sid-W2');
        const wiredW1 = fakeWired();
        const wiredW2 = fakeWired();
        const create = vi.fn()
            .mockReturnValueOnce(wiredW1)
            .mockReturnValueOnce(wiredW2);
        vi.doMock('./xterm', () => ({
            createAndWireTerminal: create,
        }));

        const { initTabs } = await loadTabs();
        const container = document.getElementById('panel')!;
        initTabs(container);

        document.dispatchEvent(new CustomEvent(OPEN_TAB_EVENT, {
            detail: makeHost({ id: 'hW1', name: 'First' }),
        }));
        await new Promise((r) => setTimeout(r, 0));
        document.dispatchEvent(new CustomEvent(OPEN_TAB_EVENT, {
            detail: makeHost({ id: 'hW2', name: 'Second' }),
        }));
        await new Promise((r) => setTimeout(r, 0));

        const tabStrip = container.querySelector('.tab-strip')!;
        // Currently "Second" is active (last opened).
        // ArrowRight should wrap to "First".
        tabStrip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        const activeTab = container.querySelector('.tab.active')!;
        expect(activeTab.querySelector('.tab-label')!.textContent).toContain('First');
        expect(wiredW1.state.term.focused).toBe(true);
    });
});
