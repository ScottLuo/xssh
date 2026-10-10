// Wails runtime stub for standalone builds.
// In a real Wails app, this is auto-generated and communicates with Go via IPC.
// For `vite build`, it provides the module structure and no-op stubs.

const eventListeners = new Map();

export function on(event, callback) {
    if (!eventListeners.has(event)) {
        eventListeners.set(event, new Set());
    }
    eventListeners.get(event).add(callback);
    return () => {
        const set = eventListeners.get(event);
        if (set) set.delete(callback);
    };
}

export function off(event, callback) {
    const set = eventListeners.get(event);
    if (set) set.delete(callback);
}

export function emit(event, ...args) {
    const set = eventListeners.get(event);
    if (set) {
        for (const cb of set) {
            cb(...args);
        }
    }
}

export function appCall(method, ...args) {
    // In a real Wails app, this would call into Go via the embedded runtime.
    // For standalone builds, resolve immediately (useful for preview).
    return Promise.resolve();
}

export const Events = { on, off, emit };

export const Window = {
    Minimise() {},
    Maximise() {},
    Unmaximise() {},
    Fullscreen() {},
    Unfullscreen() {},
    Close() {},
};

export const Log = {
    log: (msg) => console.log('[log]', msg),
    info: (msg) => console.info('[info]', msg),
    warn: (msg) => console.warn('[warn]', msg),
    error: (msg) => console.error('[error]', msg),
    debug: (msg) => console.debug('[debug]', msg),
};
