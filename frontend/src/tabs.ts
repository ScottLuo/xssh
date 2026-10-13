// tabs.ts — Tab panel: per-host tab bar + terminal area with xterm.js integration.
import { OpenTab, CloseTab } from '../wailsjs/go/main/App';
import { EventsOn } from '../wailsjs/runtime/runtime';
import { createAndWireTerminal, type WiredTerminal } from './xterm';
import type { TerminalSettings } from './settings';
import { loadTerminalSettings } from './settings';
import type { Host, TabEntry, TabsChangedPayload } from './types';
import {
    SELECT_HOST_EVENT,
    TABS_CHANGED_EVENT,
    SETTINGS_CHANGED_EVENT,
} from './types';

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
 * TabManager manages the lifecycle of SSH terminal tabs, scoped per host.
 *
 * - openTab: calls App.OpenTab, creates an xterm.js instance, and renders the tab.
 * - closeTab: disposes the terminal, calls App.CloseTab, and removes the tab DOM.
 * - setActiveHost: switches the visible host; remembers last active tab per host.
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
    /** hostID → last active tab sid for that host. */
    private lastActivePerHost = new Map<string, string>();
    /** hostID → monotonically increasing counter for tab numbering. */
    private tabCounter = new Map<string, number>();
    /** sid → user-customized display name (if edited). */
    private customNames = new Map<string, string>();
    /** sid of the tab currently being dragged (for drag-and-drop reorder). */
    private draggingSid: string | null = null;

    private activeHostId: string | null = null;
    private activeHost: Host | null = null;
    private activeSid: string | null = null;

    /** Current terminal settings, loaded from the backend at init. */
    private settings: TerminalSettings = { fontSize: 14, scrollbackLines: 1000 };

    private tabStrip: HTMLElement;
    private terminalArea: HTMLElement;
    private emptyState: HTMLElement;
    private addBtn: HTMLButtonElement;

    constructor(tabStrip: HTMLElement, terminalArea: HTMLElement, addBtn: HTMLButtonElement) {
        this.tabStrip = tabStrip;
        this.terminalArea = terminalArea;
        this.addBtn = addBtn;

        this.tabStrip.setAttribute('role', 'tablist');
        this.tabStrip.setAttribute('aria-label', 'Terminal tabs');

        // Left/Right arrow key navigation (spec §5.9).
        this.tabStrip.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            e.preventDefault();
            const allTabs = this.visibleTabIds();
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

        // Drag-to-reorder: live-preview the drop position during dragover.
        this.tabStrip.addEventListener('dragover', (e: DragEvent) => {
            e.preventDefault();
            const dragging = this.draggingSid;
            if (!dragging) return;
            const dragEl = this.tabEls.get(dragging);
            if (!dragEl) return;
            const afterEl = this.getDragAfterElement(e.clientX, e.clientY, dragEl);
            if (afterEl) {
                this.tabStrip.insertBefore(dragEl, afterEl);
            } else {
                this.tabStrip.insertBefore(dragEl, this.addBtn);
            }
        });
        this.tabStrip.addEventListener('drop', (e: DragEvent) => {
            e.preventDefault();
        });

        this.emptyState = document.createElement('div');
        this.emptyState.className = 'empty-state';
        this.emptyState.textContent = 'Select a host to open a terminal';
        this.terminalArea.appendChild(this.emptyState);

        // [+] button: open a new tab for the active host.
        this.addBtn.addEventListener('click', () => {
            if (this.activeHost) {
                void this.openTab(this.activeHost);
            }
        });
    }

    /**
     * Set the active host. Shows/hides tabs and terminals for that host.
     * Restores the last active tab if one exists for this host.
     */
    setActiveHost(host: Host | null): void {
        // Remember the current active tab for the old host.
        if (this.activeHostId && this.activeSid) {
            this.lastActivePerHost.set(this.activeHostId, this.activeSid);
        }

        this.activeHostId = host?.id ?? null;
        this.activeHost = host;

        // Update [+] button state.
        this.addBtn.disabled = !host;

        // Show/hide tab elements and terminal containers.
        for (const [id, entry] of this.tabs) {
            const visible = host ? entry.hostID === host.id : false;
            const container = this.containers.get(id);
            if (container) container.classList.toggle('hidden', !visible || this.activeSid === null || this.activeSid !== id);
        }
        for (const id of this.errorTabs) {
            const visible = host ? this.getTabHostID(id) === host.id : false;
            const container = this.containers.get(id);
            if (container) container.classList.toggle('hidden', !visible || this.activeSid === null || this.activeSid !== id);
        }
        for (const [id, el] of this.tabEls) {
            const hostID = this.getTabHostID(id);
            el.classList.toggle('hidden', host ? hostID !== host.id : true);
        }

        // Restore the last active tab for this host, or pick the first visible one.
        if (host) {
            const lastActive = this.lastActivePerHost.get(host.id);
            if (lastActive && this.isTabValid(lastActive)) {
                this.switchTab(lastActive);
            } else {
                // No valid last active — pick the first tab for this host.
                const firstTab = this.visibleTabIds();
                if (firstTab.length > 0) {
                    this.switchTab(firstTab[0]);
                } else {
                    // No tabs at all for this host.
                    this.activeSid = null;
                    for (const [, container] of this.containers) {
                        container.classList.add('hidden');
                    }
                    this.emptyState.textContent = 'No terminal yet. Click [+] to open one.';
                    this.emptyState.style.display = 'flex';
                }
            }
        } else {
            // No host selected.
            this.activeSid = null;
            for (const [, container] of this.containers) {
                container.classList.add('hidden');
            }
            this.emptyState.textContent = 'Select a host to open a terminal';
            this.emptyState.style.display = 'flex';
        }

        this.dispatchTabsChanged();
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
            container.classList.add('hidden');
            this.terminalArea.appendChild(container);
            this.createErrorTab(genErrorId(), container, host, msg);
            return;
        }

        // Create the terminal container.
        const container = document.createElement('div');
        container.className = 'terminal-container';
        container.classList.add('hidden');
        this.terminalArea.appendChild(container);

        // Create and wire the xterm.js instance, applying the user's
        // font size / scrollback settings at creation time.
        const wired = createAndWireTerminal(container, sid, this.settings);

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

        // Create the tab DOM element (insert before the [+] button).
        const tabName = this.getTabName(host.id, host.name || host.host);
        const tabEl = this.createTabEl(sid, host, tabName);
        this.tabStrip.insertBefore(tabEl, this.addBtn);
        this.tabEls.set(sid, tabEl);

        // If the new tab's host is the active host, show it and switch to it.
        if (host.id === this.activeHostId) {
            this.switchTab(sid);
        }

        this.dispatchTabsChanged();
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

        // If this was the active tab, switch to the next available one for this host.
        if (this.activeSid === sid) {
            this.activeSid = null;
            const remaining = this.visibleTabIds();
            if (remaining.length > 0) {
                this.switchTab(remaining[remaining.length - 1]);
            } else {
                this.emptyState.textContent = 'No terminal yet. Click [+] to open one.';
                this.emptyState.style.display = 'flex';
            }
        }

        this.dispatchTabsChanged();
    }

    /** List all open tab IDs (real sessions + error tabs) for the active host. */
    private visibleTabIds(): string[] {
        if (!this.activeHostId) return [];
        const ids: string[] = [];
        for (const [id, entry] of this.tabs) {
            if (entry.hostID === this.activeHostId) ids.push(id);
        }
        for (const id of this.errorTabs) {
            if (this.getTabHostID(id) === this.activeHostId) ids.push(id);
        }
        return ids;
    }

    /** Check if a tab sid is still valid (exists in tabs or errorTabs). */
    private isTabValid(sid: string): boolean {
        return this.tabs.has(sid) || this.errorTabs.has(sid);
    }

    /** Get the hostID for a tab (handles both real and error tabs). */
    private getTabHostID(sid: string): string {
        const entry = this.tabs.get(sid);
        if (entry) return entry.hostID;
        // Error tabs: store hostID in a data attribute or derive from the tab entry.
        // We store it on the tab element's dataset.
        const el = this.tabEls.get(sid);
        if (el) {
            const hostID = el.dataset.hostId;
            if (hostID) return hostID;
        }
        // Fallback: store in a map (set during createTabEl).
        return '';
    }

    /**
     * Switch the active tab: show its terminal, hide others, fit + focus.
     * Works for both real sessions and error tabs.
     */
    switchTab(sid: string): void {
        if (!this.isTabValid(sid)) return;
        this.activeSid = sid;

        // Remember the last active tab for this host.
        if (this.activeHostId) {
            this.lastActivePerHost.set(this.activeHostId, sid);
        }

        // Hide all containers for this host, show the target.
        for (const [id, container] of this.containers) {
            container.classList.toggle('hidden', id !== sid);
        }

        // Update tab element active class (only visible tabs).
        for (const [id, el] of this.tabEls) {
            const isVisible = this.activeHostId ? this.getTabHostID(id) === this.activeHostId : false;
            el.classList.toggle('active', isVisible && id === sid);
            el.setAttribute('aria-selected', isVisible && id === sid ? 'true' : 'false');
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

    /**
     * Generate a sequential tab display name for a host (e.g., "testhost-1", "testhost-2").
     * The counter is per-host and monotonically increasing.
     */
    private getTabName(hostId: string, hostDisplayName: string): string {
        const count = (this.tabCounter.get(hostId) ?? 0) + 1;
        this.tabCounter.set(hostId, count);
        const base = shortName(hostDisplayName);
        return `${base}-${count}`;
    }

    /**
     * Create the tab DOM element with label + close button.
     * Supports double-click to edit the tab name.
     */
    private createTabEl(sid: string, host: Host, tabName?: string): HTMLElement {
        const displayName = tabName ?? shortName(host.name || host.host);
        const tab = document.createElement('div');
        tab.className = 'tab';
        tab.dataset.hostId = host.id;
        tab.dataset.sid = sid;
        tab.setAttribute('role', 'tab');
        tab.setAttribute('tabindex', '0');
        tab.setAttribute('aria-label', `${displayName} tab`);
        tab.draggable = true;

        // Drag-to-reorder: set data on dragstart, sync order on dragend.
        tab.addEventListener('dragstart', (e: DragEvent) => {
            this.draggingSid = sid;
            tab.classList.add('tab-dragging');
            // dataTransfer may be null in some environments; guard both usages.
            if (e.dataTransfer) {
                e.dataTransfer.effectAllowed = 'move';
                try {
                    e.dataTransfer.setData('text/sid', sid);
                } catch {
                    /* setData can throw in some browsers */
                }
            }
        });
        tab.addEventListener('dragend', () => {
            tab.classList.remove('tab-dragging');
            this.draggingSid = null;
            this.syncOrderFromDom();
        });

        const label = document.createElement('span');
        label.className = 'tab-label';
        label.textContent = displayName;
        label.title = 'Double-click to rename';

        const closeBtn = document.createElement('button');
        closeBtn.className = 'tab-close';
        closeBtn.textContent = '×';
        closeBtn.title = 'Close tab';
        closeBtn.setAttribute('aria-label', `Close ${displayName}`);
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

        // Double-click on label to rename the tab.
        label.addEventListener('dblclick', (e: Event) => {
            e.stopPropagation();
            this.editTabName(sid, tab, label);
        });

        tab.appendChild(label);
        tab.appendChild(closeBtn);
        return tab;
    }

    /** Replace the tab label with an inline text input for renaming. */
    private editTabName(sid: string, tabEl: HTMLElement, label: HTMLElement): void {
        // Prevent double-editing.
        if (label.querySelector('input')) return;

        const currentName = label.textContent || '';
        const input = document.createElement('input');
        input.className = 'tab-label-edit';
        input.value = currentName;
        input.setAttribute('aria-label', 'Edit tab name');

        label.textContent = '';
        label.appendChild(input);
        input.focus();
        input.select();

        const commit = (): void => {
            const newName = input.value.trim();
            if (newName && newName !== currentName) {
                this.customNames.set(sid, newName);
                label.textContent = newName;
                tabEl.setAttribute('aria-label', `${newName} tab`);
            } else {
                label.textContent = currentName;
            }
        };

        input.addEventListener('blur', commit, { once: true });
        input.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                input.blur(); // triggers commit
            } else if (e.key === 'Escape') {
                e.preventDefault();
                label.textContent = currentName;
                input.remove();
            }
        });
    }

    /** Create a tab that shows a connection error (used when OpenTab fails). */
    private createErrorTab(
        id: string,
        container: HTMLDivElement,
        host: Host,
        errorMsg: string,
    ): void {
        const tabEl = this.createTabEl(id, host);
        tabEl.classList.add('ended');
        const label = tabEl.querySelector('.tab-label');
        if (label) label.textContent = `${shortName(host.name || host.host)} (error)`;

        this.tabStrip.insertBefore(tabEl, this.addBtn);
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

        // If this host is active, show it.
        if (host.id === this.activeHostId) {
            this.switchTab(id);
        }

        this.dispatchTabsChanged();
    }

    /** Dispatch TABS_CHANGED_EVENT with the current set of hosts that have tabs. */
    private dispatchTabsChanged(): void {
        const hostsWithTabs = new Set<string>();
        for (const [, entry] of this.tabs) {
            hostsWithTabs.add(entry.hostID);
        }
        for (const id of this.errorTabs) {
            const hostID = this.getTabHostID(id);
            if (hostID) hostsWithTabs.add(hostID);
        }
        const payload: TabsChangedPayload = { hostsWithTabs };
        document.dispatchEvent(new CustomEvent<TabsChangedPayload>(TABS_CHANGED_EVENT, { detail: payload }));
    }

    /**
     * Update the cached settings and apply them live to all open terminals.
     * Font size and scrollback are mutable xterm.js options, so they can be
     * changed on a running terminal without recreating it. After updating the
     * active terminal's options we re-fit it so the new font size is reflected
     * in the layout immediately.
     */
    applySettings(s: TerminalSettings): void {
        this.settings = { ...s };
        for (const [sid, wired] of this.terminals) {
            try {
                wired.term.options.fontSize = s.fontSize;
                wired.term.options.scrollback = s.scrollbackLines;
            } catch {
                /* terminal may be disposed */
            }
            // Re-fit the active terminal so the new font size takes effect.
            if (sid === this.activeSid) {
                try {
                    wired.fit.fit();
                } catch {
                    /* container may be detached */
                }
            }
        }
    }

    /**
     * Find the tab element that should come after the pointer position.
     * Used to live-preview the drop position during dragover: returns the
     * first same-host tab whose horizontal midpoint is to the right of the
     * pointer, or null if the dragged tab should be placed at the end.
     */
    private getDragAfterElement(x: number, y: number, draggingEl: HTMLElement): HTMLElement | null {
        const siblings = Array.from(this.tabStrip.querySelectorAll<HTMLElement>('.tab'))
            .filter((t) => t !== draggingEl && !t.classList.contains('hidden'));
        for (const t of siblings) {
            const rect = t.getBoundingClientRect();
            const midX = rect.left + rect.width / 2;
            // Only consider tabs on the same vertical band and to the right of the pointer.
            if (y >= rect.top && y <= rect.bottom && x < midX) {
                return t;
            }
        }
        return null;
    }

    /**
     * Rebuild this.tabs / this.errorTabs so their insertion order matches the
     * current DOM order of the tab strip. Because Map and Set both preserve
     * insertion order, and visibleTabIds() iterates them in order, keeping the
     * DOM order in sync keeps keyboard navigation and per-host ordering
     * consistent with the user's manual arrangement.
     */
    private syncOrderFromDom(): void {
        const domOrder: string[] = Array.from(this.tabStrip.querySelectorAll<HTMLElement>('.tab'))
            .map((el) => el.dataset.sid)
            .filter((id): id is string => typeof id === 'string' && id.length > 0);

        for (const id of domOrder) {
            // Re-insert in DOM order to reorder without losing entries.
            const entry = this.tabs.get(id);
            if (entry) {
                this.tabs.delete(id);
                this.tabs.set(id, entry);
            }
            if (this.errorTabs.has(id)) {
                this.errorTabs.delete(id);
                this.errorTabs.add(id);
            }
        }
    }
}

/**
 * Initialize the tab panel.
 * - Creates the tab strip (horizontal, scrollable) + terminal area.
 * - Adds a [+] button to open new tabs for the active host.
 * - Listens for SELECT_HOST_EVENT to switch the active host view.
 *
 * @returns a cleanup function that removes all event listeners.
 */
export function initTabs(container: HTMLElement): () => void {
    container.innerHTML = '';
    container.className = 'right-panel';

    const tabStrip = document.createElement('div');
    tabStrip.className = 'tab-strip';
    container.appendChild(tabStrip);

    const addBtn = document.createElement('button');
    addBtn.className = 'tab-add';
    addBtn.textContent = '+';
    addBtn.title = 'Open new terminal for this host';
    addBtn.setAttribute('aria-label', 'Open new terminal');
    addBtn.disabled = true;
    tabStrip.appendChild(addBtn);

    const terminalArea = document.createElement('div');
    terminalArea.className = 'terminal-area';
    container.appendChild(terminalArea);

    const mgr = new TabManager(tabStrip, terminalArea, addBtn);

    // Listen for SELECT_HOST_EVENT to switch the active host.
    const onSelectHost = (e: Event): void => {
        const host = (e as CustomEvent<Host>).detail;
        if (host && typeof host.id === 'string') {
            mgr.setActiveHost(host);
        }
    };
    document.addEventListener(SELECT_HOST_EVENT, onSelectHost);

    // Load the persisted terminal settings so newly opened tabs inherit the
    // user's font size / scrollback.
    void loadTerminalSettings().then((s) => {
        mgr.applySettings(s);
    });

    // Apply settings live to all open terminals when the user saves them.
    const onSettingsChanged = (e: Event): void => {
        const s = (e as CustomEvent<TerminalSettings>).detail;
        if (s && typeof s.fontSize === 'number') {
            mgr.applySettings(s);
        }
    };
    document.addEventListener(SETTINGS_CHANGED_EVENT, onSettingsChanged);

    return () => {
        document.removeEventListener(SELECT_HOST_EVENT, onSelectHost);
        document.removeEventListener(SETTINGS_CHANGED_EVENT, onSettingsChanged);
    };
}
