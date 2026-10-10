// passphrase.ts — First-run (Setup) and subsequent-run (Unlock) passphrase UI.
//
// Flow:
//  1. On app start, probe with App.UnlockDB('').
//     - Error containing "no passphrase set" → first run → Setup mode.
//     - Other error (DB exists) → Unlock mode.
//  2. Render a centered card with a password input + submit button.
//  3. On submit:
//     - Setup mode → App.SetupDB(passphrase)
//     - Unlock mode → App.UnlockDB(passphrase)
//       - Success → resolve true
//       - "wrong passphrase" → show error, keep input focused
//
// Returns true when the DB is ready (main UI should render), false otherwise.

import { App } from '../wailsjs/go/main/App';

/** Probe result that determines which screen to show. */
type Mode = 'setup' | 'unlock';

/**
 * Detect whether the app is on first run (no DB/passphrase yet) or a
 * subsequent run (DB exists and needs unlocking).
 */
async function detectMode(): Promise<Mode> {
    try {
        await App.UnlockDB('');
        // If UnlockDB with an empty passphrase succeeds, there's no encryption.
        // In practice this should not happen, but treat as unlocked.
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
 * Initialize the passphrase flow. Renders a card into `#app` and waits for
 * the user to set/unlock the DB.
 *
 * @returns `true` when the DB is unlocked and the main UI should render;
 *          `false` if the user dismissed the screen (not currently possible,
 *          but kept for future "skip" UX).
 */
export async function initPassflow(): Promise<boolean> {
    const appRoot = document.getElementById('app');
    if (!appRoot) {
        throw new Error('initPassflow: #app element not found');
    }

    const mode = await detectMode();

    // Build the passphrase card.
    appRoot.innerHTML = '';
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
                await App.SetupDB(passphrase);
            } else {
                await App.UnlockDB(passphrase);
            }
            // Success: clear the passphrase screen.
            appRoot.innerHTML = '';
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
    return true;
}
