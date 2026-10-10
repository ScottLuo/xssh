// Wails-generated JS bindings stub.
// In a real Wails app, this is auto-generated and calls into Go via IPC.
// For standalone builds (vite build), it provides the module structure.
import { appCall } from '../../runtime/runtime.js';

class App {
    static GetHosts() {
        return appCall('GetHosts');
    }
    static SaveHost(h) {
        return appCall('SaveHost', h);
    }
    static DeleteHost(id) {
        return appCall('DeleteHost', id);
    }
    static OpenTab(hostID, cols, rows) {
        return appCall('OpenTab', hostID, cols, rows);
    }
    static Write(sid, data) {
        return appCall('Write', sid, data);
    }
    static Resize(sid, cols, rows) {
        return appCall('Resize', sid, cols, rows);
    }
    static CloseTab(sid) {
        return appCall('CloseTab', sid);
    }
    static UnlockDB(passphrase) {
        return appCall('UnlockDB', passphrase);
    }
    static SetupDB(passphrase) {
        return appCall('SetupDB', passphrase);
    }
    static GetSettings() {
        return appCall('GetSettings');
    }
    static SetSetting(key, value) {
        return appCall('SetSetting', key, value);
    }
}

export { App };
