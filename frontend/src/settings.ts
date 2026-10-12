// settings.ts — Global terminal settings (font size, scrollback lines).
//
// Settings are persisted on the Go backend via the key-value settings store
// (App.GetSettings / App.SetSetting). This module is responsible for:
//   - loading the persisted terminal settings (with sane defaults),
//   - saving edited settings back to the backend, and
//   - rendering a modal form for the user to edit them.
//
// Keys are namespaced with the "terminal." prefix so future app-wide settings
// can coexist in the same table without collisions.

import { GetSettings, SetSetting } from '../wailsjs/go/main/App';

/** Settings keys (Go settings table). */
export const FONT_SIZE_KEY = 'terminal.fontSize';
export const SCROLLBACK_KEY = 'terminal.scrollbackLines';

/** Defaults applied when a value is missing or invalid. */
export const DEFAULT_FONT_SIZE = 14;
export const DEFAULT_SCROLLBACK = 1000;

/** Inclusive bounds clamped to when saving. */
export const FONT_SIZE_MIN = 8;
export const FONT_SIZE_MAX = 48;
export const SCROLLBACK_MIN = 0;
export const SCROLLBACK_MAX = 100000;

/** The subset of settings that affect the xterm.js terminal. */
export interface TerminalSettings {
    fontSize: number;
    scrollbackLines: number;
}

/** Parse a positive integer, falling back to `fallback` on any bad input. */
function toPositiveInt(value: string | undefined, fallback: number): number {
    if (value === undefined) return fallback;
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n)) return fallback;
    return n;
}

/**
 * Load the persisted terminal settings from the backend, applying defaults for
 * any missing or malformed values. Never rejects: a backend failure yields the
 * defaults so the UI remains usable.
 */
export async function loadTerminalSettings(): Promise<TerminalSettings> {
    let raw: Record<string, string> = {};
    try {
        raw = await GetSettings();
    } catch {
        raw = {};
    }
    const fs = toPositiveInt(raw[FONT_SIZE_KEY], DEFAULT_FONT_SIZE);
    const sb = toPositiveInt(raw[SCROLLBACK_KEY], DEFAULT_SCROLLBACK);
    return {
        fontSize: clamp(fs, FONT_SIZE_MIN, FONT_SIZE_MAX),
        scrollbackLines: clamp(sb, SCROLLBACK_MIN, SCROLLBACK_MAX),
    };
}

/** Persist the given settings to the backend. */
export async function saveTerminalSettings(s: TerminalSettings): Promise<void> {
    const fontSize = clamp(s.fontSize, FONT_SIZE_MIN, FONT_SIZE_MAX);
    const scrollbackLines = clamp(s.scrollbackLines, SCROLLBACK_MIN, SCROLLBACK_MAX);
    await SetSetting(FONT_SIZE_KEY, String(fontSize));
    await SetSetting(SCROLLBACK_KEY, String(scrollbackLines));
}

/** Clamp a number into the inclusive [min, max] range. */
function clamp(n: number, min: number, max: number): number {
    if (Number.isNaN(n)) return min;
    return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * Show the settings modal pre-populated with `current`.
 *
 * Resolves with the new `TerminalSettings` when the user saves, or `null` when
 * the user cancels (Cancel button or Escape).
 */
export function showSettingsModal(current: TerminalSettings):
    Promise<TerminalSettings | null> {
    return new Promise<TerminalSettings | null>((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        const card = document.createElement('div');
        card.className = 'modal-card';

        function cleanup(): void {
            document.removeEventListener('keydown', onKeydown, true);
            if (overlay.parentNode) {
                overlay.parentNode.removeChild(overlay);
            }
        }
        function onKeydown(e: KeyboardEvent): void {
            if (e.key === 'Escape') {
                e.stopPropagation();
                cleanup();
                resolve(null);
            }
        }

        const title = document.createElement('h2');
        title.className = 'modal-title';
        title.textContent = 'Settings';
        card.appendChild(title);

        const makeField = (
            label: string,
            input: HTMLElement,
            hint?: string,
        ): HTMLElement => {
            const row = document.createElement('div');
            row.className = 'form-row';
            const lbl = document.createElement('label');
            lbl.textContent = label;
            row.appendChild(lbl);
            row.appendChild(input);
            if (hint) {
                const h = document.createElement('div');
                h.className = 'hint';
                h.textContent = hint;
                row.appendChild(h);
            }
            return row;
        };

        const fontSizeInput = document.createElement('input');
        fontSizeInput.type = 'number';
        fontSizeInput.min = String(FONT_SIZE_MIN);
        fontSizeInput.max = String(FONT_SIZE_MAX);
        fontSizeInput.value = String(current.fontSize);
        fontSizeInput.setAttribute('aria-label', 'Font size');

        const scrollbackInput = document.createElement('input');
        scrollbackInput.type = 'number';
        scrollbackInput.min = String(SCROLLBACK_MIN);
        scrollbackInput.max = String(SCROLLBACK_MAX);
        scrollbackInput.value = String(current.scrollbackLines);
        scrollbackInput.setAttribute('aria-label', 'Scrollback lines');

        card.appendChild(makeField(
            'Font size',
            fontSizeInput,
            `Terminal font size in px (${FONT_SIZE_MIN}–${FONT_SIZE_MAX})`,
        ));
        card.appendChild(makeField(
            'Scrollback lines',
            scrollbackInput,
            `How many lines of history to keep (0–${SCROLLBACK_MAX})`,
        ));

        const actions = document.createElement('div');
        actions.className = 'modal-actions';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => {
            cleanup();
            resolve(null);
        });

        const saveBtn = document.createElement('button');
        saveBtn.className = 'btn primary';
        saveBtn.textContent = 'Save';
        saveBtn.addEventListener('click', () => {
            const result: TerminalSettings = {
                fontSize: toPositiveInt(
                    fontSizeInput.value,
                    current.fontSize,
                ),
                scrollbackLines: toPositiveInt(
                    scrollbackInput.value,
                    current.scrollbackLines,
                ),
            };
            cleanup();
            resolve(result);
        });

        actions.appendChild(cancelBtn);
        actions.appendChild(saveBtn);
        card.appendChild(actions);
        overlay.appendChild(card);
        document.body.appendChild(overlay);
        document.addEventListener('keydown', onKeydown, true);
        fontSizeInput.focus();
        fontSizeInput.select();
    });
}
