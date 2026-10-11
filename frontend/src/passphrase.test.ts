import { describe, it, expect, vi, beforeEach } from 'vitest';

function setupMocks() {
    const UnlockDB = vi.fn();
    const SetupDB = vi.fn();
    vi.doMock('../wailsjs/go/main/App', () => ({
        UnlockDB, SetupDB,
    }));
    vi.doMock('../wailsjs/runtime/runtime', () => ({
        EventsOn: vi.fn(() => 'evt-1'),
        EventsOff: vi.fn(),
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

/**
 * initPassflow() now returns a Promise that resolves only after the user
 * successfully sets/unlocks the DB. The tests must:
 *   1. Call initPassflow() and store the Promise (do NOT await it yet).
 *   2. Wait for the UI to render (microtask flush).
 *   3. Fill the input and click the button.
 *   4. Await the stored Promise to verify success.
 */
describe('initPassflow', () => {
    beforeEach(async () => {
        document.body.innerHTML = '<div id="app"></div>';
        // Reset module registry between tests.
        vi.resetModules();
    });

    /** Flush microtasks to let doInit's async chain complete. */
    function flush(): Promise<void> {
        return new Promise((r) => setTimeout(r, 0));
    }

    it('detects first-run mode and calls SetupDB on submit', async () => {
        const { UnlockDB, SetupDB } = setupMocks();
        // Probe with "" -> "no passphrase set" => setup mode.
        UnlockDB.mockRejectedValueOnce(new Error('no passphrase set, use SetupDB'));
        SetupDB.mockResolvedValueOnce(undefined);

        const { initPassflow } = await loadPassflow();
        const promise = initPassflow();
        await flush(); // Let the async init complete and render the card.

        const { input, btn } = findControls();
        expect(input).not.toBeNull();
        expect(btn).not.toBeNull();
        // Title reflects setup mode.
        expect(document.querySelector('.passflow-title')!.textContent)
            .toContain('Set Passphrase');

        input!.value = 'hunter2';
        btn!.click();
        const result = await promise;

        expect(SetupDB).toHaveBeenCalledWith('hunter2');
        expect(result).toBe(true);
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
        const promise = initPassflow();
        await flush();

        const { input, btn } = findControls();
        expect(document.querySelector('.passflow-title')!.textContent)
            .toContain('Unlock xssh');

        input!.value = 'hunter2';
        btn!.click();
        const result = await promise;

        expect(UnlockDB).toHaveBeenCalledWith('hunter2');
        expect(SetupDB).not.toHaveBeenCalled();
        expect(result).toBe(true);
        expect(document.querySelector('.passflow-overlay')).toBeNull();
    });

    it('shows an error for a wrong passphrase and keeps the screen', async () => {
        const { UnlockDB } = setupMocks();
        UnlockDB.mockRejectedValueOnce(new Error('wrong passphrase')); // probe
        UnlockDB.mockRejectedValueOnce(new Error('wrong passphrase')); // submit

        const { initPassflow } = await loadPassflow();
        const promise = initPassflow();
        await flush();

        const { input, btn } = findControls();
        input!.value = 'badpass';
        btn!.click();
        await flush(); // Let the async submit handler run.

        const errEl = document.querySelector('.passflow-error') as HTMLElement;
        expect(errEl.textContent).toContain('Wrong passphrase');
        // Screen remains.
        expect(document.querySelector('.passflow-overlay')).not.toBeNull();

        // Now try with the correct passphrase to resolve.
        UnlockDB.mockResolvedValueOnce(undefined);
        input!.value = 'goodpass';
        btn!.click();
        const result = await promise;
        expect(result).toBe(true);
    });

    it('shows "required" when submitting an empty passphrase', async () => {
        const { UnlockDB } = setupMocks();
        UnlockDB.mockRejectedValueOnce(new Error('wrong passphrase')); // probe

        const { initPassflow } = await loadPassflow();
        initPassflow();
        await flush();

        const { input, btn } = findControls();
        input!.value = '';
        btn!.click();
        await flush();

        const errEl = document.querySelector('.passflow-error') as HTMLElement;
        expect(errEl.textContent).toContain('required');
    });

    it('resolves true when Enter key is pressed with a valid passphrase', async () => {
        const { UnlockDB } = setupMocks();
        UnlockDB.mockRejectedValueOnce(new Error('wrong passphrase')); // probe
        UnlockDB.mockResolvedValueOnce(undefined); // submit

        const { initPassflow } = await loadPassflow();
        const promise = initPassflow();
        await flush();

        const { input } = findControls();
        input!.value = 'pass123';
        input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        const result = await promise;
        expect(result).toBe(true);
        expect(UnlockDB).toHaveBeenCalledWith('pass123');
    });

    it('disables the button while submitting', async () => {
        const { UnlockDB } = setupMocks();
        UnlockDB.mockRejectedValueOnce(new Error('wrong passphrase')); // probe
        // Submit: delay the response to check button state.
        let resolveUnlock: () => void;
        UnlockDB.mockImplementationOnce(() => new Promise<void>((r) => { resolveUnlock = r; }));

        const { initPassflow } = await loadPassflow();
        const promise = initPassflow();
        await flush();

        const { input, btn } = findControls();
        input!.value = 'pass';
        btn!.click();
        // Immediately after click, button should be disabled.
        await flush();
        expect(btn!.disabled).toBe(true);

        resolveUnlock!();
        await promise;
        expect(btn!.disabled).toBe(false);
    });
});
