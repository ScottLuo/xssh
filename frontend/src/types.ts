// Shared TypeScript types for the xssh frontend.
// Field names match the Go JSON tags in internal/store/host.go (snake_case).

/** A saved SSH host card. */
export interface Host {
    id: string;
    name: string;
    host: string;
    port: number;
    user: string;
    auth_type: string;    // "key" | "password"
    auth_secret: string;  // AES-GCM encrypted, base64
    shell: string;
    init_cmds: string[];
    color: string;
    created_at: string;
    updated_at: string;
}

/** Form data for creating or editing a host (excludes server-managed fields). */
export interface HostFormData {
    name: string;
    host: string;
    port: number;
    user: string;
    auth_type: string;
    auth_secret: string;
    shell: string;
    init_cmds: string[];
    color: string;
}

/** Bookkeeping for an open terminal tab. */
export interface TabEntry {
    sid: string;
    hostID: string;
    hostName: string;
    ended: boolean;
}

/** Custom DOM event dispatched when a host card is clicked (open a tab). */
export const OPEN_TAB_EVENT = 'xssh:newtab';
