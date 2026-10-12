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

function setupHostsMocks() {
    const GetHosts = vi.fn();
    const SaveHost = vi.fn().mockResolvedValue(undefined);
    const DeleteHost = vi.fn().mockResolvedValue(undefined);
    const GetSettings = vi.fn().mockResolvedValue({});
    const SetSetting = vi.fn().mockResolvedValue(undefined);
    // Capture the EventsOn callback so tests can fire the `hosts:updated`
    // broadcast and assert the panel re-renders.
    let updateCb: (() => void) | null = null;
    const unsub = vi.fn();
    const EventsOn = vi.fn((_event: string, cb: () => void) => {
        updateCb = cb;
        return unsub;
    });
    vi.doMock('../wailsjs/go/main/App', () => ({
        GetHosts, SaveHost, DeleteHost, GetSettings, SetSetting,
    }));
    vi.doMock('../wailsjs/runtime/runtime', () => ({
        EventsOn,
    }));
    return {
        GetHosts,
        SaveHost,
        DeleteHost,
        GetSettings,
        SetSetting,
        unsub,
        fireUpdate: () => { if (updateCb) updateCb(); },
    };
}

/** Query an input/textarea/select by its aria-label. */
function byLabel(label: string): HTMLElement {
    return document.querySelector(
        `[aria-label="${label}"]`,
    ) as HTMLElement;
}

describe('initHosts', () => {
    beforeEach(async () => {
        vi.resetModules();
        document.body.innerHTML = '<div id="panel"></div>';
    });

    it('renders the host panel with a header and add button', async () => {
        const { GetHosts } = setupHostsMocks();
        GetHosts.mockResolvedValue([]);
        const { initHosts } = await import('./hosts');
        const container = document.getElementById('panel')!;
        await initHosts(container);

        expect(container.querySelector('.panel-header')).not.toBeNull();
        expect(container.querySelector('[aria-label="Add host"]')!.textContent).toBe('+');
        // Empty state is shown when there are no hosts.
        expect(container.querySelector('.host-empty')).not.toBeNull();
    });

    it('renders a card per host with color stripe, name and address', async () => {
        const { GetHosts } = setupHostsMocks();
        GetHosts.mockResolvedValue([makeHost()]);
        const { initHosts } = await import('./hosts');
        const container = document.getElementById('panel')!;
        await initHosts(container);

        const card = container.querySelector('.host-card') as HTMLElement;
        expect(card).not.toBeNull();
        // jsdom normalizes the hex color to an rgb() string.
        const stripe = card.querySelector('.stripe') as HTMLElement;
        expect(stripe.style.background).toBe('rgb(52, 152, 219)');
        expect(card.querySelector('.card-name')!.textContent).toContain('Prod');
        expect(card.querySelector('.card-meta')!.textContent)
            .toContain('root@10.0.0.1:22');
    });

    it('dispatches SELECT_HOST_EVENT when a card is clicked', async () => {
        const { GetHosts } = setupHostsMocks();
        GetHosts.mockResolvedValue([makeHost({ id: 'abc', name: 'Prod' })]);
        const { initHosts } = await import('./hosts');
        const container = document.getElementById('panel')!;
        await initHosts(container);

        let dispatched: unknown = null;
        const listener = (e: Event) => { dispatched = e; };
        document.addEventListener(SELECT_HOST_EVENT, listener as EventListener);
        const card = container.querySelector('.host-card')!;
        card.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        document.removeEventListener(SELECT_HOST_EVENT, listener as EventListener);

        expect(dispatched).not.toBeNull();
        const detail = (dispatched as CustomEvent).detail as Host;
        expect(detail.id).toBe('abc');
        expect(detail.name).toBe('Prod');
    });

    it('re-renders when the hosts:updated event fires', async () => {
        const { GetHosts, fireUpdate } = setupHostsMocks();
        // Initial load: one host.
        GetHosts.mockResolvedValueOnce([makeHost()]);
        // After the broadcast the backend now returns two hosts.
        GetHosts.mockResolvedValue([
            makeHost(),
            makeHost({ id: 'h2', name: 'Prod2' }),
        ]);

        const { initHosts } = await import('./hosts');
        const container = document.getElementById('panel')!;
        const unsub = await initHosts(container);
        expect(container.querySelectorAll('.host-card').length).toBe(1);

        // Simulate the backend broadcasting an update; the panel re-fetches.
        fireUpdate();
        await new Promise((r) => setTimeout(r, 0));
        expect(container.querySelectorAll('.host-card').length).toBe(2);
        expect(typeof unsub).toBe('function');
    });

    it('opens the host modal when the add button is clicked', async () => {
        const { GetHosts } = setupHostsMocks();
        GetHosts.mockResolvedValue([]);
        const { initHosts } = await import('./hosts');
        const container = document.getElementById('panel')!;
        await initHosts(container);

        const addBtn = container.querySelector('[aria-label="Add host"]')!;
        addBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));

        expect(document.querySelector('.modal-overlay')).not.toBeNull();
        // Clean up the modal.
        document.querySelector('.modal-overlay .btn')!
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(document.querySelector('.modal-overlay')).toBeNull();
    });

    it('opens the settings modal when the settings button is clicked', async () => {
        const { GetHosts, SetSetting } = setupHostsMocks();
        GetHosts.mockResolvedValue([]);
        const { initHosts } = await import('./hosts');
        const container = document.getElementById('panel')!;
        await initHosts(container);

        // A settings (gear) button with the expected aria-label exists.
        const settingsBtn = container.querySelector('[aria-label="Settings"]')!;
        expect(settingsBtn.textContent).toBe('⚙');

        // Clicking it loads the current settings (async) then opens the modal
        // with two number inputs.
        settingsBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        // The click handler awaits loadTerminalSettings() before opening the
        // modal, so let the microtask queue drain.
        await new Promise((r) => setTimeout(r, 0));
        const overlay = document.querySelector('.modal-overlay')!;
        expect(overlay.querySelector('.modal-title')!.textContent).toBe('Settings');
        const numberInputs = overlay.querySelectorAll('input[type="number"]');
        expect(numberInputs.length).toBe(2);

        // Edit the values and save; SetSetting is called for both keys and the
        // settings-changed event is dispatched to open terminals.
        const [fsInput, sbInput] = Array.from(numberInputs) as HTMLInputElement[];
        fsInput.value = '20';
        sbInput.value = '5000';
        let detail: unknown = null;
        const listener = (e: Event) => { detail = e; };
        document.addEventListener('xssh:settingschanged', listener as EventListener);
        overlay.querySelector('.btn.primary')!
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));
        // Save handler awaits saveTerminalSettings() (two SetSetting calls).
        await new Promise((r) => setTimeout(r, 0));
        document.removeEventListener('xssh:settingschanged', listener as EventListener);

        expect(SetSetting).toHaveBeenCalledTimes(2);
        expect(SetSetting).toHaveBeenCalledWith('terminal.fontSize', '20');
        expect(SetSetting).toHaveBeenCalledWith('terminal.scrollbackLines', '5000');
        expect(document.querySelector('.modal-overlay')).toBeNull();
        expect(detail).not.toBeNull();
        expect((detail as CustomEvent).detail).toEqual({
            fontSize: 20,
            scrollbackLines: 5000,
        });
    });
});

describe('showHostModal', () => {
    beforeEach(async () => {
        vi.resetModules();
        document.body.innerHTML = '<div id="root"></div>';
    });

    it('resolves a new host with parsed form fields on save', async () => {
        setupHostsMocks();
        const { showHostModal } = await import('./hosts');

        const p = showHostModal();
        byLabel('Name').value = 'Prod';
        byLabel('Host address').value = '10.0.0.1';
        (byLabel('Port') as HTMLInputElement).value = '2222';
        byLabel('User').value = 'root';
        byLabel('Auth secret').value = 'secret';
        (byLabel('Init commands') as HTMLTextAreaElement).value =
            'cd /tmp\necho hi\n\n';
        // Click the "Create" (primary) button.
        document.querySelector('.modal-overlay .btn.primary')!
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const host = await p;

        expect(host).not.toBeNull();
        expect(host!.name).toBe('Prod');
        expect(host!.host).toBe('10.0.0.1');
        expect(host!.port).toBe(2222);
        expect(host!.user).toBe('root');
        expect(host!.auth_secret).toBe('secret');
        // Blank lines are filtered out.
        expect(host!.init_cmds).toEqual(['cd /tmp', 'echo hi']);
        expect(host!.id).toBeTruthy();
        expect(host!.created_at).toBeTruthy();
        // Default color is the first preset when none is selected.
        expect(host!.color).toBe('#22c55e');
        // Modal closed.
        expect(document.querySelector('.modal-overlay')).toBeNull();
    });

    it('pre-fills the form when editing an existing host', async () => {
        setupHostsMocks();
        const { showHostModal } = await import('./hosts');

        const existing = makeHost({
            id: 'edit1',
            name: 'Dev',
            port: 222,
            color: '#ef4444',
            shell: '/bin/zsh',
        });
        const p = showHostModal(existing);

        expect(byLabel('Name').value).toBe('Dev');
        expect(byLabel('Host address').value).toBe('10.0.0.1');
        expect((byLabel('Port') as HTMLInputElement).value).toBe('222');
        expect(byLabel('Shell').value).toBe('/bin/zsh');
        // The title reflects edit mode.
        expect(document.querySelector('.modal-title')!.textContent)
            .toBe('Edit Host');

        document.querySelector('.modal-overlay .btn.primary')!
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const host = await p;
        // Edit preserves the original id.
        expect(host!.id).toBe('edit1');
        expect(host!.color).toBe('#ef4444');
    });

    it('uses the selected color swatch for the host color', async () => {
        setupHostsMocks();
        const { showHostModal } = await import('./hosts');

        const p = showHostModal();
        // Click the red (#ef4444) preset swatch.
        const swatch = document.querySelector(
            '[aria-label="Color #ef4444"]',
        )!;
        swatch.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        document.querySelector('.modal-overlay .btn.primary')!
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const host = await p;
        expect(host!.color).toBe('#ef4444');
    });

    it('resolves null when the cancel button is clicked', async () => {
        setupHostsMocks();
        const { showHostModal } = await import('./hosts');

        const p = showHostModal();
        document.querySelector('.modal-overlay .btn')!
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const host = await p;
        expect(host).toBeNull();
    });

    it('resolves null when the Escape key is pressed', async () => {
        setupHostsMocks();
        const { showHostModal } = await import('./hosts');

        const p = showHostModal();
        document.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }),
        );
        const host = await p;
        expect(host).toBeNull();
        expect(document.querySelector('.modal-overlay')).toBeNull();
    });
});

describe('confirmDelete', () => {
    beforeEach(async () => {
        vi.resetModules();
        document.body.innerHTML = '<div id="root"></div>';
    });

    it('resolves true when the Delete button is clicked', async () => {
        setupHostsMocks();
        const { confirmDelete } = await import('./hosts');

        const p = confirmDelete(makeHost({ name: 'Prod' }));
        expect(document.querySelector('.modal-overlay')).not.toBeNull();
        document.querySelector('.modal-overlay .btn.primary')!
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const ok = await p;
        expect(ok).toBe(true);
        expect(document.querySelector('.modal-overlay')).toBeNull();
    });

    it('resolves false when the Cancel button is clicked', async () => {
        setupHostsMocks();
        const { confirmDelete } = await import('./hosts');

        const p = confirmDelete(makeHost({ name: 'Prod' }));
        document.querySelector('.modal-overlay .btn')!
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const ok = await p;
        expect(ok).toBe(false);
    });
});

describe('truncateName', () => {
    it('returns the name unchanged when within the limit', async () => {
        const { truncateName } = await import('./hosts');
        expect(truncateName('Prod')).toBe('Prod');
    });

    it('truncates long names with an ellipsis', async () => {
        const { truncateName } = await import('./hosts');
        const out = truncateName('a'.repeat(40), 20);
        // max-1 characters plus the ellipsis = exactly `max` in length.
        expect(out.length).toBe(20);
        expect(out.endsWith('…')).toBe(true);
        expect(out.startsWith('a'.repeat(19))).toBe(true);
    });
});
