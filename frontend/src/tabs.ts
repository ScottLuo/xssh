// tabs.ts — Tab panel: tab bar + terminal area with xterm.js integration.
import { OpenTab, CloseTab } from '../wailsjs/go/main/App';
import { EventsOn } from '../wailsjs/runtime/runtime';
import { createAndWireTerminal, type WiredTerminal } from './xterm';
import type { Host, TabEntry } from './types';
import { OPEN_TAB_EVENT } from './types';

/** Truncate a host name to 12 characters for tab labels. */
function shortName(name: string, max = 12): string {
    if (name.length <= max) return name;
    return `${name.slice(0, max - 1)}…`;
}

/**
 * Generate a unique client-side identifier for error tabs (which never get a
 * real session ID from Go).
 */
function genErrorId(): string {
    try {
        return `err-${crypto.randomUUID()}`;
    } catch {
        return `err-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }
}

/**
 * TabManager manages the lifecycle of SSH terminal tabs.
 *
 * - openTab: calls App.OpenTab, creates an xterm.js instance, and renders the tab.
 * - closeTab: disposes the terminal, calls App.CloseTab, and removes the tab DOM.
 * - switchTab: hides all terminals except the target, calls fit + focus.
 */
class TabManager {
    private tabs = new Map<string, TabEntry>();
    private terminals = new Map<string, WiredTerminal>();
    private containers = new Map<string, HTMLDivElement>();
    private closedUnsubs = new Map<string, () => void>();
    private tabEls = new Map<string, HTMLElement>();
    /** IDs of tabs that represent a connection error (no real Go session). */
    private errorTabs = new Set<string>();
    private activeSid: string | null = null;

    private tabStrip: HTMLElement;
    private terminalArea: HTMLElement;
    private emptyState: HTMLElement;

    constructor(tabStrip: HTMLElement, terminalArea: HTMLElement) {
        this.tabStrip = tabStrip;
        this.terminalArea = terminalArea;

        this.tabStrip.setAttribute('role', 'tablist');
        this.tabStrip.setAttribute('aria-label', 'Terminal tabs');

        // Left/Right arrow key navigation (spec §5.9).
        this.tabStrip.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            e.preventDefault();
            const allTabs = this.allTabIds();
            if (allTabs.length === 0) return;
            const currentIdx = this.activeSid ? allTabs.indexOf(this.activeSid) : -1;
            let nextIdx: number;
            if (e.key === 'ArrowRight') {
                nextIdx = (currentIdx + 1) % allTabs.length;
            } else {
                nextIdx = currentIdx <= 0 ? allTabs.length - 1 : currentIdx - 1;
            }
            const targetSid = allTabs[nextIdx];
            const targetEl = this.tabEls.get(targetSid);
            if (targetEl) targetEl.focus();
            this.switchTab(targetSid);
        });

        this.emptyState = document.createElement('div');
        this.emptyState.className = 'empty-state';
        this.emptyState.textContent = 'Select a host to open a terminal';
        this.terminalArea.appendChild(this.emptyState);
    }

    /**
     * Open a new tab for the given host.
     */
    async openTab(host: Host): Promise<void> {
        const cols = 80;
        const rows = 24;
        let sid: string;
        try {
            sid = await OpenTab(host.id, cols, rows);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // Show the error in a dedicated (non-terminal) tab so the user
            // can see what went wrong and close it when done.
            const container = document.createElement('div');
            container.className = 'terminal-container';
            this.terminalArea.appendChild(container);
            this.createErrorTab(genErrorId(), container, host.name || host.host, msg);
            return;
        }

        // Create the terminal container.
        const container = document.createElement('div');
        container.className = 'terminal-container';
        this.terminalArea.appendChild(container);

        // Create and wire the xterm.js instance.
        const wired = createAndWireTerminal(container, sid);

        this.tabs.set(sid, {
            sid,
            hostID: host.id,
            hostName: host.name || host.host,
            ended: false,
        });
        this.terminals.set(sid, wired);
        this.containers.set(sid, container);

        // Subscribe to session-closed to update tab UI (beyond what wireIO does).
        this.closedUnsubs.set(sid, EventsOn(`ssh:closed:${sid}`, () => {
            this.markEnded(sid);
        }));

        // Create the tab DOM element.
        const tabEl = this.createTabEl(sid, host.name || host.host);
        this.tabStrip.appendChild(tabEl);
        this.tabEls.set(sid, tabEl);

        this.switchTab(sid);
    }

    /**
     * Close a tab: dispose terminal, call App.CloseTab, remove DOM.
     * Works for both real sessions and error tabs.
     */
    closeTab(sid: string): void {
        const isError = this.errorTabs.has(sid);

        // Unsubscribe the session-closed listener (real tabs only).
        const unsub = this.closedUnsubs.get(sid);
        if (unsub) unsub();
        this.closedUnsubs.delete(sid);

        // Dispose xterm.js (real tabs only).
        const wired = this.terminals.get(sid);
        if (wired) wired.dispose();
        this.terminals.delete(sid);

        // Remove the container from DOM.
        const container = this.containers.get(sid);
        if (container && container.parentNode) {
            container.parentNode.removeChild(container);
        }
        this.containers.delete(sid);

        // Call Go to close the session (real tabs only — no session on the Go
        // side for error tabs).
        if (!isError) {
            CloseTab(sid).catch(() => { /* already closed */ });
            this.tabs.delete(sid);
        } else {
            this.errorTabs.delete(sid);
        }

        // Remove tab DOM element.
        const tabEl = this.tabEls.get(sid);
        if (tabEl && tabEl.parentNode) {
            tabEl.parentNode.removeChild(tabEl);
        }
        this.tabEls.delete(sid);

        // If this was the active tab, switch to the next available one.
        if (this.activeSid === sid) {
            this.activeSid = null;
            const remaining = this.allTabIds();
            if (remaining.length > 0) {
                this.switchTab(remaining[remaining.length - 1]);
            } else {
                this.emptyState.style.display = 'flex';
            }
        }
    }

    /** List all open tab IDs (real sessions + error tabs). */
    private allTabIds(): string[] {
        return [...this.tabs.keys(), ...this.errorTabs];
    }

    /**
     * Switch the active tab: show its terminal, hide others, fit + focus.
     * Works for both real sessions and error tabs.
     */
    switchTab(sid: string): void {
        if (!this.tabs.has(sid) && !this.errorTabs.has(sid)) return;
        this.activeSid = sid;

        // Hide all containers, show the target.
        for (const [id, container] of this.containers) {
            container.classList.toggle('hidden', id !== sid);
        }

        // Update tab element active class.
        for (const [id, el] of this.tabEls) {
            el.classList.toggle('active', id === sid);
            el.setAttribute('aria-selected', id === sid ? 'true' : 'false');
        }

        // Hide the empty state.
        this.emptyState.style.display = 'none';

        // Fit and focus the active terminal.
        const wired = this.terminals.get(sid);
        if (wired) {
            try {
                wired.fit.fit();
            } catch { /* may be detached */ }
            wired.term.focus();
        }
    }

    /** Mark a tab as ended (session closed by remote). */
    private markEnded(sid: string): void {
        const entry = this.tabs.get(sid);
        if (!entry || entry.ended) return;
        entry.ended = true;

        const tabEl = this.tabEls.get(sid);
        if (tabEl) {
            tabEl.classList.add('ended');
            const label = tabEl.querySelector('.tab-label');
            if (label) {
                label.textContent = `${label.textContent} (closed)`;
            }
        }
    }

    /** Create the tab DOM element with label + close button. */
    private createTabEl(sid: string, hostName: string): HTMLElement {
        const tab = document.createElement('div');
        tab.className = 'tab';
        tab.setAttribute('role', 'tab');
        tab.setAttribute('tabindex', '0');

        const label = document.createElement('span');
        label.className = 'tab-label';
        label.textContent = shortName(hostName);

        const closeBtn = document.createElement('button');
        closeBtn.className = 'tab-close';
        closeBtn.textContent = '×';
        closeBtn.title = 'Close tab';
        closeBtn.setAttribute('aria-label', `Close ${hostName}`);
        closeBtn.addEventListener('click', (e: Event) => {
            e.stopPropagation();
            this.closeTab(sid);
        });

        tab.addEventListener('click', () => this.switchTab(sid));
        tab.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter') this.switchTab(sid);
        });
        // Middle-click closes the tab.
        tab.addEventListener('auxclick', (e: MouseEvent) => {
            if (e.button === 1) {
                e.preventDefault();
                this.closeTab(sid);
            }
        });

        tab.appendChild(label);
        tab.appendChild(closeBtn);
        return tab;
    }

    /** Create a tab that shows a connection error (used when OpenTab fails). */
    private createErrorTab(
        id: string,
        container: HTMLDivElement,
        hostName: string,
        errorMsg: string,
    ): void {
        const tabEl = this.createTabEl(id, hostName);
        tabEl.classList.add('ended');
        const label = tabEl.querySelector('.tab-label');
        if (label) label.textContent = `${shortName(hostName)} (error)`;

        this.tabStrip.appendChild(tabEl);
        this.tabEls.set(id, tabEl);
        this.errorTabs.add(id);
        this.containers.set(id, container);

        // Show error in the terminal container.
        const errorEl = document.createElement('div');
        errorEl.style.color = '#ef4444';
        errorEl.style.fontFamily = 'monospace';
        errorEl.style.padding = '12px';
        errorEl.textContent = `Connection error: ${errorMsg}`;
        container.appendChild(errorEl);

        this.switchTab(id);
    }
}

/**
 * Initialize the tab panel.
 * - Creates the tab strip (horizontal, scrollable) + terminal area.
 * - Listens for OPEN_TAB_EVENT on `document` to open new tabs.
 *
 * @returns a cleanup function that removes the event listener.
 */
export function initTabs(container: HTMLElement): () => void {
    container.innerHTML = '';
    container.className = 'right-panel';

    const tabStrip = document.createElement('div');
    tabStrip.className = 'tab-strip';
    container.appendChild(tabStrip);

    const terminalArea = document.createElement('div');
    terminalArea.className = 'terminal-area';
    container.appendChild(terminalArea);

    const mgr = new TabManager(tabStrip, terminalArea);

    // Listen for host-card clicks to open tabs.
    const onNewTab = (e: Event): void => {
        const host = (e as CustomEvent<Host>).detail;
        if (host && typeof host.id === 'string') {
            void mgr.openTab(host);
        }
    };
    document.addEventListener(OPEN_TAB_EVENT, onNewTab);

    return () => {
        document.removeEventListener(OPEN_TAB_EVENT, onNewTab);
    };
}
