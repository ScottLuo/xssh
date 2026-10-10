import { describe, it, expect, vi, beforeEach } from 'vitest';

function setupMocks() {
    const UnlockDB = vi.fn();
    const SetupDB = vi.fn();
    vi.doMock('../wailsjs/go/main/App', () => ({
        App: { UnlockDB, SetupDB },
    }));
    vi.doMock('../wailsjs/runtime/runtime', () => ({
        Events: { on: vi.fn() },
    }));
    return { UnlockDB, SetupDB };
}

/** Load the passphrase module fresh so it picks up the doMock'd App. */
async function loadPassflow() {
    return import('./passphrase');
}

/** Find the password input and submit button in the rendered passflow card. */
function findControls() {
    const input = document.querySelector(
        '.passflow-card input[type="password"]',
    ) as HTMLInputElement | null;
    const btn = document.querySelector(
        '.passflow-card .btn.primary',
    ) as HTMLButtonElement | null;
    return { input, btn };
}

describe('initPassflow', () => {
    beforeEach(async () => {
        document.body.innerHTML =
            '<div id="app"></div>';
        // Reset module registry between tests.
        vi.resetModules();
    });

    it('detects first-run mode and calls SetupDB on submit', async () => {
        const { UnlockDB, SetupDB } = setupMocks();
        // Probe with "" -> "no passphrase set" => setup mode.
        UnlockDB.mockRejectedValueOnce(new Error('no passphrase set, use SetupDB'));
        SetupDB.mockResolvedValueOnce(undefined);

        const { initPassflow } = await loadPassflow();
        await initPassflow();

        const { input, btn } = findControls();
        expect(input).not.toBeNull();
        expect(btn).not.toBeNull();
        // Title reflects setup mode.
        expect(document.querySelector('.passflow-title')!.textContent)
            .toContain('Set Passphrase');

        input!.value = 'hunter2';
        await Promise.resolve(btn!.click());

        expect(SetupDB).toHaveBeenCalledWith('hunter2');
        // On success the passflow screen is cleared.
        expect(document.querySelector('.passflow-overlay')).toBeNull();
    });

    it('detects subsequent-run mode and calls UnlockDB on submit', async () => {
        const { UnlockDB, SetupDB } = setupMocks();
        // Probe with "" -> some other error => unlock mode.
        UnlockDB.mockRejectedValueOnce(new Error('wrong passphrase'));
        UnlockDB.mockResolvedValueOnce(undefined);
        SetupDB.mockResolvedValueOnce(undefined);

        const { initPassflow } = await loadPassflow();
        await initPassflow();

        const { input, btn } = findControls();
        expect(document.querySelector('.passflow-title')!.textContent)
            .toContain('Unlock xssh');

        input!.value = 'hunter2';
        await Promise.resolve(btn!.click());

        expect(UnlockDB).toHaveBeenCalledWith('hunter2');
        expect(SetupDB).not.toHaveBeenCalled();
        expect(document.querySelector('.passflow-overlay')).toBeNull();
    });

    it('shows an error for a wrong passphrase and keeps the screen', async () => {
        const { UnlockDB } = setupMocks();
        UnlockDB.mockRejectedValueOnce(new Error('wrong passphrase')); // probe
        UnlockDB.mockRejectedValueOnce(new Error('wrong passphrase')); // submit

        const { initPassflow } = await loadPassflow();
        await initPassflow();

        const { input, btn } = findControls();
        input!.value = 'badpass';
        await Promise.resolve(btn!.click());

        const errEl = document.querySelector('.passflow-error') as HTMLElement;
        expect(errEl.textContent).toContain('Wrong passphrase');
        // Screen remains.
        expect(document.querySelector('.passflow-overlay')).not.toBeNull();
    });

    it('shows "required" when submitting an empty passphrase', async () => {
        const { UnlockDB } = setupMocks();
        UnlockDB.mockRejectedValueOnce(new Error('wrong passphrase')); // probe

        const { initPassflow } = await loadPassflow();
        await initPassflow();

        const { input, btn } = findControls();
        input!.value = '';
        await Promise.resolve(btn!.click());

        const errEl = document.querySelector('.passflow-error') as HTMLElement;
        expect(errEl.textContent).toContain('required');
    });
});
