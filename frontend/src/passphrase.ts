// passphrase.ts — First-run (Setup) and subsequent-run (Unlock) passphrase UI.
//
// Flow:
//  1. On app start, probe with UnlockDB('').
//     - Error containing "no passphrase set" → first run → Setup mode.
//     - Other error (DB exists) → Unlock mode.
//  2. Render a centered card with a password input + submit button.
//  3. On submit:
//     - Setup mode → SetupDB(passphrase)
//     - Unlock mode → UnlockDB(passphrase)
//       - Success → remove overlay, resolve true
//       - "wrong passphrase" → show error, keep input focused
//
// Returns a Promise that resolves with `true` ONLY after the user
// successfully sets or unlocks the database. This ensures `main()`
// does not build the main layout until the DB is ready.

import { UnlockDB, SetupDB } from '../wailsjs/go/main/App';

/** Probe result that determines which screen to show. */
type Mode = 'setup' | 'unlock';

/**
 * Detect whether the app is on first run (no DB/passphrase yet) or a
 * subsequent run (DB exists and needs unlocking).
 */
async function detectMode(): Promise<Mode> {
    try {
        await UnlockDB('');
        // If UnlockDB with an empty passphrase succeeds, treat as unlocked.
        return 'unlock';
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('no passphrase set')) {
            return 'setup';
        }
        return 'unlock';
    }
}

/**
 * Initialize the passphrase flow. Renders a card overlay into `#app` and
 * returns a Promise that resolves when the user successfully sets or unlocks
 * the database.
 *
 * The overlay is a child of `#app`. On success, the overlay is removed and
 * the Promise resolves with `true`. The caller (`main.ts`) then builds the
 * main layout into the now-clean `#app`.
 */
export function initPassflow(): Promise<boolean> {
    let resolveFn: (v: boolean) => void;
    const promise = new Promise<boolean>((res) => { resolveFn = res; });

    const doInit = async (): Promise<void> => {
        let appRoot = document.getElementById('app');
        if (!appRoot) {
            // Create #app if it doesn't exist (should not happen in practice).
            appRoot = document.createElement('div');
            appRoot.id = 'app';
            document.body.appendChild(appRoot);
        }

        const mode = await detectMode();

        // Build the passphrase card inside a dedicated overlay container.
        const overlay = document.createElement('div');
        overlay.className = 'passflow-overlay';

        const card = document.createElement('div');
        card.className = 'passflow-card';

        const title = document.createElement('h1');
        title.className = 'passflow-title';
        title.textContent = mode === 'setup' ? 'Set Passphrase' : 'Unlock xssh';

        const sub = document.createElement('p');
        sub.className = 'passflow-sub';
        sub.textContent = mode === 'setup'
            ? 'Choose a passphrase to protect your host data.'
            : 'Enter your passphrase to unlock the database.';

        const errorEl = document.createElement('div');
        errorEl.className = 'passflow-error';

        const input = document.createElement('input');
        input.type = 'password';
        input.autofocus = true;
        input.placeholder = mode === 'setup' ? 'New passphrase' : 'Passphrase';
        input.setAttribute('aria-label', mode === 'setup' ? 'New passphrase' : 'Passphrase');

        const btn = document.createElement('button');
        btn.className = 'btn primary';
        btn.textContent = mode === 'setup' ? 'Create Database' : 'Unlock';

        card.appendChild(title);
        card.appendChild(sub);
        card.appendChild(errorEl);
        card.appendChild(input);
        card.appendChild(btn);
        overlay.appendChild(card);
        appRoot.appendChild(overlay);

        const showError = (msg: string): void => {
            errorEl.textContent = msg;
            input.focus();
        };

        const submit = async (): Promise<void> => {
            const passphrase = input.value;
            if (!passphrase) {
                showError('Passphrase is required.');
                return;
            }
            btn.disabled = true;
            try {
                if (mode === 'setup') {
                    await SetupDB(passphrase);
                } else {
                    await UnlockDB(passphrase);
                }
                // Success: remove the overlay and resolve the Promise.
                // `main()` will then build the layout into the clean #app.
                if (overlay.parentNode) {
                    overlay.parentNode.removeChild(overlay);
                }
                resolveFn(true);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if (msg.includes('wrong passphrase')) {
                    showError('Wrong passphrase. Please try again.');
                } else {
                    showError(`Error: ${msg}`);
                }
            } finally {
                btn.disabled = false;
            }
        };

        btn.addEventListener('click', () => { void submit(); });
        input.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter') { void submit(); }
        });

        input.focus();
    };

    void doInit();
    return promise;
}
