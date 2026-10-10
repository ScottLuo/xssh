// @ts-check
// Cynan
let __eventId = 0;
const __listeners = new Map(); // name -> Map<id, cb>

export function EventsOn(eventName, callback) {
  const id = String(++__eventId);
  if (!__listeners.has(eventName)) __listeners.set(eventName, new Map());
  __listeners.get(eventName).set(id, callback);
  return id;
}

export function EventsOff(eventName, ...eventIDs) {
  const m = __listeners.get(eventName);
  if (!m) return;
  for (const id of eventIDs) m.delete(id);
}

export function EventsOnce(eventName, callback) {
  const id = EventsOn(eventName, (...a) => {
    EventsOff(eventName, id);
    callback(...a);
  });
  return id;
}

export function EventsEmit(eventName, ...data) {
  const m = __listeners.get(eventName);
  if (!m) return;
  for (const cb of m.values()) cb(...data);
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
