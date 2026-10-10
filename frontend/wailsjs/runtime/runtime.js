// @ts-check
// Cynan
/**
 * In-memory event registry matching Wails v2 runtime semantics.
 * EventsOn returns an unsubscribe closure (removes just that listener).
 * EventsOff removes ALL listeners for the given event name(s).
 */
const __listeners = new Map(); // eventName -> Set<callback>

export function EventsOn(eventName, callback) {
  if (!__listeners.has(eventName)) __listeners.set(eventName, new Set());
  __listeners.get(eventName).add(callback);
  return () => {
    __listeners.get(eventName)?.delete(callback);
  };
}

export function EventsOnce(eventName, callback) {
  let unsub;
  const wrapper = (...args) => {
    unsub();
    callback(...args);
  };
  unsub = EventsOn(eventName, wrapper);
  return unsub;
}

export function EventsOff(...eventNames) {
  for (const name of eventNames) {
    __listeners.delete(name);
  }
}

export function EventsEmit(eventName, ...data) {
  const set = __listeners.get(eventName);
  if (!set) return;
  for (const cb of set) cb(...data);
}

export function EventsOffAll() {
  __listeners.clear();
}

export function WindowMinimise() { window['runtime'] && window['runtime']['WindowMinimise'] && window['runtime']['WindowMinimise'](); }
export function WindowMaximise() { window['runtime'] && window['runtime']['WindowMaximise'] && window['runtime']['WindowMaximise'](); }
export function WindowUnmaximise() { window['runtime'] && window['runtime']['WindowUnmaximise'] && window['runtime']['WindowUnmaximise'](); }
export function WindowFullscreen() { window['runtime'] && window['runtime']['WindowFullscreen'] && window['runtime']['WindowFullscreen'](); }
export function WindowUnfullscreen() { window['runtime'] && window['runtime']['WindowUnfullscreen'] && window['runtime']['WindowUnfullscreen'](); }
export function WindowClose() { window['runtime'] && window['runtime']['WindowClose'] && window['runtime']['WindowClose'](); }

export function LogPrint(message) { window['runtime'] && window['runtime']['Log'] && window['runtime']['Log'](1, message); }
export function LogTrace(message) { window['runtime'] && window['runtime']['Log'] && window['runtime']['Log'](0, message); }
export function LogDebug(message) { window['runtime'] && window['runtime']['Log'] && window['runtime']['Log'](4, message); }
export function LogInfo(message) { window['runtime'] && window['runtime']['Log'] && window['runtime']['Log'](2, message); }
export function LogWarning(message) { window['runtime'] && window['runtime']['Log'] && window['runtime']['Log'](3, message); }
export function LogError(message) { window['runtime'] && window['runtime']['Log'] && window['runtime']['Log'](5, message); }
export function LogFatal(message) { window['runtime'] && window['runtime']['Log'] && window['runtime']['Log'](6, message); }
