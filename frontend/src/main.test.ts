import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Flush pending microtasks so the auto-run main() can complete. */
async function flush(): Promise<void> {
    for (let i = 0; i < 10; i += 1) {
        await Promise.resolve();
    }
}

describe('main entry point', () => {
    let initPassflow: ReturnType<typeof vi.fn>;
    let initHosts: ReturnType<typeof vi.fn>;
    let initTabs: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        vi.resetModules();
        document.body.innerHTML = '<div id="app"></div>';

        initPassflow = vi.fn();
        initHosts = vi.fn().mockResolvedValue(() => {});
        initTabs = vi.fn().mockReturnValue(() => {});

        vi.doMock('./passphrase', () => ({ initPassflow }));
        vi.doMock('./hosts', () => ({ initHosts }));
        vi.doMock('./tabs', () => ({ initTabs }));
        // CSS imports resolve to no-op modules in the test environment.
        vi.doMock('./styles.css', () => ({}));
        vi.doMock('@xterm/xterm/css/xterm.css', () => ({}));
    });

    it('builds the layout and initializes both panels on unlock', async () => {
        initPassflow.mockResolvedValue(true);
        await import('./main');
        await flush();

        expect(initPassflow).toHaveBeenCalled();
        expect(initHosts).toHaveBeenCalledTimes(1);
        expect(initTabs).toHaveBeenCalledTimes(1);
        // Left and right panels are appended to #app.
        expect(document.getElementById('left-panel')).not.toBeNull();
        expect(document.getElementById('right-panel')).not.toBeNull();
    });

    it('skips the main UI when the passphrase flow does not complete', async () => {
        initPassflow.mockResolvedValue(false);
        await import('./main');
        await flush();

        expect(initPassflow).toHaveBeenCalled();
        expect(initHosts).not.toHaveBeenCalled();
        expect(initTabs).not.toHaveBeenCalled();
        expect(document.getElementById('left-panel')).toBeNull();
    });
});
