// hosts.ts — Left panel: host card rendering and CRUD modals.
import { GetHosts, SaveHost, DeleteHost } from '../wailsjs/go/main/App';
import { EventsOn, EventsOff } from '../wailsjs/runtime/runtime';
import type { Host, HostFormData } from './types';
import { OPEN_TAB_EVENT } from './types';

/** Preset color swatches offered in the host form. */
const COLOR_PRESETS = [
    '#22c55e', // green
    '#ef4444', // red
    '#3b82f6', // blue
    '#eab308', // yellow
    '#a855f7', // purple
    '#06b6d4', // cyan
    '#f97316', // orange
    '#6b7280', // gray (default)
];

/** Truncate a name to at most `max` characters with an ellipsis. */
export function truncateName(name: string, max = 20): string {
    if (name.length <= max) return name;
    return `${name.slice(0, max - 1)}…`;
}

/**
 * Render a single host card element.
 * - Left color stripe uses `host.color` (or gray fallback).
 * - Clicking (or pressing Enter/Space) dispatches OPEN_TAB_EVENT on `document`.
 * - Hover reveals edit (✎) and delete (×) buttons.
 */
export function renderHostCard(host: Host): HTMLElement {
    const card = document.createElement('div');
    card.className = 'host-card';
    card.setAttribute('tabindex', '0');
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `Open ${host.name}`);

    const stripe = document.createElement('div');
    stripe.className = 'stripe';
    stripe.style.background = host.color || '#6b7280';

    const body = document.createElement('div');
    body.className = 'card-body';

    const name = document.createElement('div');
    name.className = 'card-name';
    name.textContent = truncateName(host.name || host.host || 'unnamed');

    const meta = document.createElement('div');
    meta.className = 'card-meta';
    meta.textContent = `${host.user}@${host.host}:${host.port}`;

    body.appendChild(name);
    body.appendChild(meta);

    const openTab = (): void => {
        document.dispatchEvent(new CustomEvent(OPEN_TAB_EVENT, { detail: host }));
    };
    card.addEventListener('click', openTab);
    card.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openTab();
        }
    });

    const actions = document.createElement('div');
    actions.className = 'card-actions';

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.textContent = '✎';
    editBtn.title = 'Edit host';
    editBtn.addEventListener('click', async (e: MouseEvent) => {
        e.stopPropagation();
        const updated = await showHostModal(host);
        if (updated) {
            await SaveHost(updated).catch(() => { /* refetch via event */ });
        }
    });

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'delete';
    delBtn.textContent = '×';
    delBtn.title = 'Delete host';
    delBtn.addEventListener('click', async (e: MouseEvent) => {
        e.stopPropagation();
        const ok = await confirmDelete(host);
        if (ok) {
            await DeleteHost(host.id).catch(() => { /* refetch via event */ });
        }
    });

    actions.appendChild(editBtn);
    actions.appendChild(delBtn);

    card.appendChild(stripe);
    card.appendChild(body);
    card.appendChild(actions);
    return card;
}

/**
 * Show a modal form to add or edit a host.
 * Resolves with the completed Host object, or `null` if the user cancelled.
 */
export function showHostModal(existing?: Host): Promise<Host | null> {
    return new Promise<Host | null>((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        const card = document.createElement('div');
        card.className = 'modal-card';
        const isEdit = Boolean(existing);

        // Hoisted so listeners registered below can reference them safely.
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
        title.textContent = existing ? 'Edit Host' : 'Add Host';
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

        const nameInput = document.createElement('input');
        nameInput.value = existing?.name ?? '';
        nameInput.setAttribute('aria-label', 'Name');
        nameInput.placeholder = 'e.g. web-01';

        const hostInput = document.createElement('input');
        hostInput.value = existing?.host ?? '';
        hostInput.setAttribute('aria-label', 'Host address');
        hostInput.placeholder = '10.0.0.1 or host.example.com';

        const portInput = document.createElement('input');
        portInput.type = 'number';
        portInput.value = String(existing?.port ?? 22);
        portInput.setAttribute('aria-label', 'Port');

        const userInput = document.createElement('input');
        userInput.value = existing?.user ?? '';
        userInput.setAttribute('aria-label', 'User');
        userInput.placeholder = 'root';

        const authTypeSelect = document.createElement('select');
        authTypeSelect.setAttribute('aria-label', 'Auth type');
        const keyOpt = document.createElement('option');
        keyOpt.value = 'key';
        keyOpt.textContent = 'SSH Key';
        const passOpt = document.createElement('option');
        passOpt.value = 'password';
        passOpt.textContent = 'Password';
        authTypeSelect.appendChild(keyOpt);
        authTypeSelect.appendChild(passOpt);
        authTypeSelect.value = existing?.auth_type ?? 'password';

        const authSecretInput = document.createElement('input');
        authSecretInput.type = 'text';
        authSecretInput.value = existing?.auth_secret ?? '';
        authSecretInput.setAttribute('aria-label', 'Auth secret');
        authSecretInput.placeholder = 'Path to key file or password';

        const shellInput = document.createElement('input');
        shellInput.value = existing?.shell ?? '';
        shellInput.setAttribute('aria-label', 'Shell');
        shellInput.placeholder = '/bin/bash (optional)';

        const initCmdsInput = document.createElement('textarea');
        initCmdsInput.value = (existing?.init_cmds ?? []).join('\n');
        initCmdsInput.setAttribute('aria-label', 'Init commands');
        initCmdsInput.placeholder = 'One command per line, e.g. cd /work';

        // Color swatches.
        const colorRow = document.createElement('div');
        colorRow.className = 'form-row';
        const colorLbl = document.createElement('label');
        colorLbl.textContent = 'Color';
        colorRow.appendChild(colorLbl);
        const swatchWrap = document.createElement('div');
        swatchWrap.className = 'color-swatches';
        let selectedColor = existing?.color ?? COLOR_PRESETS[0];
        COLOR_PRESETS.forEach((c) => {
            const sw = document.createElement('div');
            sw.className = 'color-swatch';
            sw.style.background = c;
            sw.setAttribute('role', 'radio');
            sw.setAttribute('aria-label', `Color ${c}`);
            if (c === selectedColor) sw.classList.add('selected');
            sw.addEventListener('click', () => {
                selectedColor = c;
                swatchWrap.querySelectorAll('.color-swatch')
                    .forEach((n) => n.classList.remove('selected'));
                sw.classList.add('selected');
            });
            swatchWrap.appendChild(sw);
        });
        colorRow.appendChild(swatchWrap);

        card.appendChild(makeField('Name', nameInput));
        card.appendChild(makeField('Host', hostInput));
        card.appendChild(makeField('Port', portInput));
        card.appendChild(makeField('User', userInput));
        card.appendChild(makeField('Auth Type', authTypeSelect));
        card.appendChild(makeField('Auth Secret', authSecretInput));
        card.appendChild(makeField('Shell', shellInput));
        card.appendChild(makeField(
            'Init Commands',
            initCmdsInput,
            'One command per line',
        ));
        card.appendChild(colorRow);

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
        saveBtn.textContent = isEdit ? 'Save' : 'Create';
        saveBtn.addEventListener('click', () => {
            const host = buildHost(existing, {
                name: nameInput.value.trim(),
                host: hostInput.value.trim(),
                port: Number(portInput.value) || 22,
                user: userInput.value.trim(),
                auth_type: authTypeSelect.value,
                auth_secret: authSecretInput.value,
                shell: shellInput.value.trim(),
                init_cmds: initCmdsInput.value
                    .split('\n')
                    .map((s) => s.trim())
                    .filter(Boolean),
                color: selectedColor,
            });
            cleanup();
            resolve(host);
        });

        actions.appendChild(cancelBtn);
        actions.appendChild(saveBtn);
        card.appendChild(actions);
        overlay.appendChild(card);
        document.body.appendChild(overlay);
        document.addEventListener('keydown', onKeydown, true);
        nameInput.focus();
    });
}

/**
 * Show a delete-confirmation dialog.
 * Resolves `true` if the user confirmed, `false` otherwise.
 */
export function confirmDelete(host: Host): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
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
                resolve(false);
            }
        }

        const title = document.createElement('h2');
        title.className = 'modal-title';
        title.textContent = 'Delete Host';
        card.appendChild(title);

        const msg = document.createElement('p');
        msg.textContent = `Delete "${truncateName(host.name || host.host)}"? `
            + 'Open sessions to this host will be closed.';
        card.appendChild(msg);

        const actions = document.createElement('div');
        actions.className = 'modal-actions';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => {
            cleanup();
            resolve(false);
        });

        const delBtn = document.createElement('button');
        delBtn.className = 'btn primary';
        delBtn.style.background = '#ef4444';
        delBtn.style.borderColor = '#ef4444';
        delBtn.textContent = 'Delete';
        delBtn.addEventListener('click', () => {
            cleanup();
            resolve(true);
        });

        actions.appendChild(cancelBtn);
        actions.appendChild(delBtn);
        card.appendChild(actions);
        overlay.appendChild(card);
        document.body.appendChild(overlay);
        document.addEventListener('keydown', onKeydown, true);
    });
}

/** Build a full Host object from form data, generating id/timestamps if new. */
function buildHost(existing: Host | undefined, data: HostFormData): Host {
    const now = new Date().toISOString();
    if (existing) {
        return {
            ...existing,
            ...data,
            updated_at: now,
        };
    }
    return {
        id: generateId(),
        ...data,
        created_at: now,
        updated_at: now,
    };
}

/** Generate a time-sortable unique ID on the client (ULID-like). */
function generateId(): string {
    const ts = Date.now().toString(36).toUpperCase();
    let rand = '';
    const chars = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    for (let i = 0; i < 16; i++) {
        rand += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return `xssh-${ts}${rand}`;
}

/**
 * Initialize the host panel.
 * - Renders the header ("Hosts" + "+" button) and the scrollable card list.
 * - Fetches hosts from Go and renders them.
 * - Subscribes to `hosts:updated` to re-fetch after CRUD operations.
 *
 * @returns a cleanup function that removes the `hosts:updated` subscription.
 */
export async function initHosts(container: HTMLElement): Promise<() => void> {
    container.innerHTML = '';
    container.className = 'left-panel';

    const header = document.createElement('div');
    header.className = 'panel-header';

    const label = document.createElement('span');
    label.textContent = 'Hosts';

    const addBtn = document.createElement('button');
    addBtn.className = 'btn-icon';
    addBtn.textContent = '+';
    addBtn.title = 'Add host';
    addBtn.setAttribute('aria-label', 'Add host');
    addBtn.addEventListener('click', async () => {
        const host = await showHostModal();
        if (host) {
            await SaveHost(host).catch(() => { /* refetch via event */ });
        }
    });

    header.appendChild(label);
    header.appendChild(addBtn);
    container.appendChild(header);

    const list = document.createElement('div');
    list.className = 'host-list';
    container.appendChild(list);

    const render = async (): Promise<void> => {
        list.innerHTML = '';
        let hosts: Host[] = [];
        try {
            hosts = await GetHosts();
        } catch {
            hosts = [];
        }
        if (hosts.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'host-empty';
            empty.textContent = 'No hosts yet. Click + to add one.';
            list.appendChild(empty);
            return;
        }
        for (const h of hosts) {
            list.appendChild(renderHostCard(h));
        }
    };

    await render();

    const hostEvtId = EventsOn('hosts:updated', () => {
        void render();
    });

    return () => { EventsOff('hosts:updated', hostEvtId); };
}
