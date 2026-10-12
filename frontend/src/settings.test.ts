import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Settings tests. The Go backend (App.GetSettings / App.SetSetting) is mocked
 * per-test; the DOM behaviour of the settings modal is exercised in jsdom.
 */

function setupSettingsMocks() {
    const GetSettings = vi.fn();
    const SetSetting = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../wailsjs/go/main/App', () => ({ GetSettings, SetSetting }));
    vi.doMock('../wailsjs/runtime/runtime', () => ({ EventsOn: vi.fn() }));
    return { GetSettings, SetSetting };
}

describe('loadTerminalSettings', () => {
    beforeEach(async () => {
        vi.resetModules();
    });

    it('parses persisted values', async () => {
        const { GetSettings } = setupSettingsMocks();
        GetSettings.mockResolvedValue({
            'terminal.fontSize': '20',
            'terminal.scrollbackLines': '5000',
        });
        const { loadTerminalSettings } = await import('./settings');
        await expect(loadTerminalSettings()).resolves.toEqual({
            fontSize: 20,
            scrollbackLines: 5000,
        });
    });

    it('falls back to defaults when nothing is stored', async () => {
        const { GetSettings } = setupSettingsMocks();
        GetSettings.mockResolvedValue({});
        const { loadTerminalSettings, DEFAULT_FONT_SIZE, DEFAULT_SCROLLBACK } =
            await import('./settings');
        await expect(loadTerminalSettings()).resolves.toEqual({
            fontSize: DEFAULT_FONT_SIZE,
            scrollbackLines: DEFAULT_SCROLLBACK,
        });
    });

    it('clamps out-of-range values', async () => {
        const { GetSettings } = setupSettingsMocks();
        GetSettings.mockResolvedValue({
            'terminal.fontSize': '999',
            'terminal.scrollbackLines': '999999',
        });
        const {
            loadTerminalSettings, FONT_SIZE_MAX, SCROLLBACK_MAX,
        } = await import('./settings');
        const s = await loadTerminalSettings();
        expect(s.fontSize).toBe(FONT_SIZE_MAX);
        expect(s.scrollbackLines).toBe(SCROLLBACK_MAX);
    });

    it('uses defaults when the backend rejects', async () => {
        const { GetSettings } = setupSettingsMocks();
        GetSettings.mockRejectedValue(new Error('db locked'));
        const { loadTerminalSettings, DEFAULT_FONT_SIZE } = await import('./settings');
        await expect(loadTerminalSettings()).resolves.toMatchObject({
            fontSize: DEFAULT_FONT_SIZE,
        });
    });
});

describe('saveTerminalSettings', () => {
    beforeEach(async () => {
        vi.resetModules();
    });

    it('persists both keys as strings', async () => {
        const { SetSetting } = setupSettingsMocks();
        const { saveTerminalSettings } = await import('./settings');
        await saveTerminalSettings({ fontSize: 18, scrollbackLines: 2000 });
        expect(SetSetting).toHaveBeenCalledTimes(2);
        expect(SetSetting).toHaveBeenCalledWith('terminal.fontSize', '18');
        expect(SetSetting).toHaveBeenCalledWith('terminal.scrollbackLines', '2000');
    });

    it('clamps values before persisting', async () => {
        const { SetSetting } = setupSettingsMocks();
        const {
            saveTerminalSettings, FONT_SIZE_MIN, FONT_SIZE_MAX, SCROLLBACK_MAX,
        } = await import('./settings');
        await saveTerminalSettings({ fontSize: -5, scrollbackLines: 999999 });
        expect(SetSetting).toHaveBeenCalledWith('terminal.fontSize', String(FONT_SIZE_MIN));
        expect(SetSetting).toHaveBeenCalledWith(
            'terminal.scrollbackLines',
            String(SCROLLBACK_MAX),
        );
        // FONT_SIZE_MAX is only referenced to keep the import used in tests.
        expect(FONT_SIZE_MAX).toBeGreaterThan(FONT_SIZE_MIN);
    });
});

describe('showSettingsModal', () => {
    beforeEach(async () => {
        vi.resetModules();
        document.body.innerHTML = '<div id="root"></div>';
    });

    it('renders a titled modal with two number inputs pre-filled', async () => {
        setupSettingsMocks();
        const { showSettingsModal } = await import('./settings');
        const p = showSettingsModal({ fontSize: 20, scrollbackLines: 5000 });
        const overlay = document.querySelector('.modal-overlay')!;
        expect(overlay.querySelector('.modal-title')!.textContent).toBe('Settings');
        const inputs = Array.from(
            overlay.querySelectorAll('input[type="number"]'),
        ) as HTMLInputElement[];
        expect(inputs.length).toBe(2);
        expect(inputs[0].value).toBe('20');
        expect(inputs[1].value).toBe('5000');
        // Cancel so the promise doesn't stay open.
        document.querySelector('.modal-overlay .btn')!
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await p;
    });

    it('resolves with the new values when Save is clicked', async () => {
        setupSettingsMocks();
        const { showSettingsModal } = await import('./settings');
        const p = showSettingsModal({ fontSize: 14, scrollbackLines: 1000 });
        const inputs = Array.from(
            document.querySelectorAll('.modal-overlay input[type="number"]'),
        ) as HTMLInputElement[];
        inputs[0].value = '24';
        inputs[1].value = '3000';
        document.querySelector('.modal-overlay .btn.primary')!
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await expect(p).resolves.toEqual({ fontSize: 24, scrollbackLines: 3000 });
        expect(document.querySelector('.modal-overlay')).toBeNull();
    });

    it('resolves null when Cancel is clicked', async () => {
        setupSettingsMocks();
        const { showSettingsModal } = await import('./settings');
        const p = showSettingsModal({ fontSize: 14, scrollbackLines: 1000 });
        document.querySelector('.modal-overlay .btn')!
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await expect(p).resolves.toBeNull();
    });

    it('resolves null when Escape is pressed', async () => {
        setupSettingsMocks();
        const { showSettingsModal } = await import('./settings');
        const p = showSettingsModal({ fontSize: 14, scrollbackLines: 1000 });
        document.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }),
        );
        await expect(p).resolves.toBeNull();
        expect(document.querySelector('.modal-overlay')).toBeNull();
    });
});
