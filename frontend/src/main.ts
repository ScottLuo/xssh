// main.ts — xssh frontend entry point.
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { initPassflow } from './passphrase';
import { initHosts } from './hosts';
import { initTabs } from './tabs';

async function main(): Promise<void> {
    // 1. Passphrase flow: setup (first run) or unlock (subsequent runs).
    const ok = await initPassflow();
    if (!ok) return;

    // 2. Build the main layout: left panel + right panel.
    const appRoot = document.getElementById('app');
    if (!appRoot) {
        throw new Error('main: #app element not found');
    }

    const leftPanel = document.createElement('div');
    leftPanel.id = 'left-panel';

    const rightPanel = document.createElement('div');
    rightPanel.id = 'right-panel';

    appRoot.appendChild(leftPanel);
    appRoot.appendChild(rightPanel);

    // 3. Initialize host panel (left).
    await initHosts(leftPanel);

    // 4. Initialize tab panel (right).
    initTabs(rightPanel);
}

main();
