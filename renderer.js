const { ipcRenderer } = require('electron');
const os = require('os');
const path = require('path');

class FlashTerminal {
    constructor() {
        this.tabs = [];
        this.activeTabId = null;
        this.tabCounter = 0;
        this.usedTabNumbers = new Set();
        this.commandHistory = [];
        this.historyIndex = -1;
        this.macros = {};
        this.awaitingConfirmation = null;
        this.awaitingPackageManager = null;
        
        this.init();
    }

    async init() {
        this.setupEventListeners();
        await this.loadMacros();
        this.createTab();
        this.showStartupAnimation();
    }

    setupEventListeners() {
        document.getElementById('newTabBtn').addEventListener('click', () => this.createTab());
        document.getElementById('minimizeBtn').addEventListener('click', () => {
            ipcRenderer.send('window-minimize');
        });
        document.getElementById('maximizeBtn').addEventListener('click', () => {
            ipcRenderer.send('window-maximize');
        });
        document.getElementById('closeBtn').addEventListener('click', () => {
            ipcRenderer.send('window-close');
        });
        
        document.addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.key === 't') {
                e.preventDefault();
                this.createTab();
            } else if (e.ctrlKey && e.key === 'w') {
                e.preventDefault();
                if (this.activeTabId) this.closeTab(this.activeTabId);
            } else if (e.ctrlKey && e.key === 'l') {
                e.preventDefault();
                this.clearTerminal();
            }
        });

        document.addEventListener('click', () => {
            this.hideContextMenu();
        });

        this.setupContextMenu();
    }

    setupContextMenu() {
        const contextMenu = document.getElementById('contextMenu');
        
        contextMenu.addEventListener('click', (e) => {
            e.stopPropagation();
            const item = e.target.closest('.context-menu-item');
            if (!item) return;

            const action = item.dataset.action;
            const tabId = contextMenu.dataset.tabId;

            switch(action) {
                case 'rename':
                    this.renameTab(tabId);
                    break;
                case 'duplicate':
                    this.duplicateTab(tabId);
                    break;
                case 'close':
                    this.closeTab(tabId);
                    break;
            }

            this.hideContextMenu();
        });
    }

    showContextMenu(tabId, x, y) {
        const contextMenu = document.getElementById('contextMenu');
        contextMenu.dataset.tabId = tabId;
        contextMenu.classList.add('active');
        
        const menuRect = contextMenu.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        
        let left = x;
        let top = y;
        
        if (x + menuRect.width > viewportWidth) {
            left = viewportWidth - menuRect.width - 10;
        }
        
        if (y + menuRect.height > viewportHeight) {
            top = viewportHeight - menuRect.height - 10;
        }
        
        contextMenu.style.left = left + 'px';
        contextMenu.style.top = top + 'px';
    }

    hideContextMenu() {
        const contextMenu = document.getElementById('contextMenu');
        contextMenu.classList.remove('active');
    }

    renameTab(tabId) {
        const tab = this.tabs.find(t => t.id === tabId);
        if (!tab) return;

        const tabBtn = tab.button;
        const titleSpan = tabBtn.querySelector('.tab-title span') || tabBtn.querySelector('.tab-title');
        const input = document.createElement('input');
    
        input.value = titleSpan.textContent;
        input.className = 'tab-rename-input';
    
        titleSpan.replaceWith(input);
        input.focus();
        input.select();
    
        const finish = () => {
            const newTitle = input.value.trim() || titleSpan.textContent;
            const newSpan = document.createElement('span');
            newSpan.textContent = newTitle;
            input.replaceWith(newSpan);
        };
    
        input.addEventListener('blur', finish);
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter') finish();
            else if (e.key === 'Escape') finish();
        });
    }

    duplicateTab(tabId) {
        const tab = this.tabs.find(t => t.id === tabId);
        if (!tab) return;

        const titleSpan = tab.button.querySelector('.tab-title span') || tab.button.querySelector('.tab-title');
        this.createTab(titleSpan.textContent + ' (Copy)');
    }

    getNextAvailableTabNumber() {
        let num = 1;
        while (this.usedTabNumbers.has(num)) {
            num++;
        }
        return num;
    }

    createTab(name = null) {
        const tabNumber = this.getNextAvailableTabNumber();
        this.usedTabNumbers.add(tabNumber);
        this.tabCounter++;
        const tabId = `tab-${this.tabCounter}`;
        const tabName = name || `Terminal ${tabNumber}`;

        const tabBtn = document.createElement('div');
        tabBtn.className = 'tab';
        tabBtn.dataset.tabId = tabId;
        tabBtn.dataset.tabNumber = tabNumber;
        tabBtn.innerHTML = `
            <div class="tab-title">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="4 17 10 11 4 5"></polyline>
                    <line x1="12" y1="19" x2="20" y2="19"></line>
                </svg>
                <span>${tabName}</span>
            </div>
            <button class="tab-close">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
            </button>
        `;

        const panel = document.createElement('div');
        panel.className = 'terminal-panel';
        panel.dataset.tabId = tabId;
        panel.innerHTML = `
            <div class="terminal-output"></div>
            <div class="terminal-input-container">
                <span class="prompt">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
                    </svg>
                </span>
                <input type="text" class="terminal-input" placeholder="Type a command..." autocomplete="off" spellcheck="false" />
            </div>
        `;

        const tabBar = document.querySelector('.tab-bar');
        const newTabBtn = document.getElementById('newTabBtn');
        tabBar.insertBefore(tabBtn, newTabBtn);
        document.getElementById('terminalContainer').appendChild(panel);

        this.tabs.push({
            id: tabId,
            name: tabName,
            button: tabBtn,
            panel: panel,
            output: panel.querySelector('.terminal-output'),
            input: panel.querySelector('.terminal-input'),
            sessionId: tabId,
            tabNumber: tabNumber
        });

        tabBtn.addEventListener('click', (e) => {
            if (!e.target.classList.contains('tab-close') && !e.target.closest('.tab-close')) {
                this.switchTab(tabId);
            }
        });

        tabBtn.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this.showContextMenu(tabId, e.clientX, e.clientY);
        });

        tabBtn.querySelector('.tab-close').addEventListener('click', (e) => {
            e.stopPropagation();
            this.closeTab(tabId);
        });

        tabBtn.addEventListener('dblclick', () => {
            this.renameTab(tabId);
        });

        const input = panel.querySelector('.terminal-input');
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                this.executeCommand(tabId, input.value);
                input.value = '';
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                this.historyUp(input);
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                this.historyDown(input);
            }
        });

        this.switchTab(tabId);
    }

    switchTab(tabId) {
        this.tabs.forEach(tab => {
            tab.button.classList.remove('active');
            tab.panel.classList.remove('active');
        });

        const tab = this.tabs.find(t => t.id === tabId);
        if (tab) {
            tab.button.classList.add('active');
            tab.panel.classList.add('active');
            tab.input.focus();
            this.activeTabId = tabId;
        }
    }

    closeTab(tabId) {
        const tabIndex = this.tabs.findIndex(t => t.id === tabId);
        if (tabIndex === -1) return;

        const tab = this.tabs[tabIndex];
        this.usedTabNumbers.delete(tab.tabNumber);
        tab.button.remove();
        tab.panel.remove();
        this.tabs.splice(tabIndex, 1);

        if (this.activeTabId === tabId && this.tabs.length > 0) {
            this.switchTab(this.tabs[0].id);
        } else if (this.tabs.length === 0) {
            this.createTab();
        }
    }

    clearTerminal() {
        const tab = this.tabs.find(t => t.id === this.activeTabId);
        if (tab) {
            tab.output.innerHTML = '';
        }
    }

    printLine(tabId, text, className = '') {
        const tab = this.tabs.find(t => t.id === tabId);
        if (!tab) return;

        const line = document.createElement('div');
        line.className = `output-line ${className} fade-in`;
        line.textContent = text;
        tab.output.appendChild(line);
        tab.output.scrollTop = tab.output.scrollHeight;
    }

    async loadMacros() {
        this.macros = await ipcRenderer.invoke('load-macros');
    }

    async saveMacro(name, commands) {
        await ipcRenderer.invoke('save-macro', { name, commands });
        this.macros[name] = commands;
    }

    async deleteMacro(name) {
        await ipcRenderer.invoke('delete-macro', name);
        delete this.macros[name];
    }

    async executeCommand(tabId, command) {
        if (!command.trim()) return;

        if (this.awaitingPackageManager) {
            const response = command.trim().toLowerCase();
            if (response === 'p') {
                const project = this.awaitingPackageManager;
                this.printLine(tabId, 'Installing with pip...', 'info');
                await this.executeCommandLive(tabId, `pip install ${project}`);
            } else if (response === 'n') {
                const project = this.awaitingPackageManager;
                this.printLine(tabId, 'Installing with npm...', 'info');
                await this.executeCommandLive(tabId, `npm install ${project}`);
            } else {
                this.printLine(tabId, 'Invalid option. Cancelled.', 'error');
            }
            this.awaitingPackageManager = null;
            return;
        }

        if (this.awaitingConfirmation) {
            const response = command.trim().toLowerCase();
            if (response === 'y' || response === 'yes') {
                const macroName = this.awaitingConfirmation;
                await this.deleteMacro(macroName);
                this.printLine(tabId, `Macro '${macroName}' deleted successfully.`, 'success');
            } else {
                this.printLine(tabId, 'Deletion cancelled.', 'warning');
            }
            this.awaitingConfirmation = null;
            return;
        }

        this.commandHistory.push(command);
        this.historyIndex = this.commandHistory.length;

        this.printLine(tabId, `> ${command}`, 'command');

        const tab = this.tabs.find(t => t.id === tabId);
        if (!tab) return;

        if (command.trim().startsWith('flash')) {
            await this.handleFlashCommand(tabId, command.trim());
            return;
        }

        if (command.trim() === 'clear' || command.trim() === 'cls') {
            tab.output.innerHTML = '';
            return;
        }

        if (command.trim() === 'exit') {
            this.closeTab(tabId);
            return;
        }

        if (command.trim() === 'help') {
            this.showHelp(tabId);
            return;
        }

        if (command.trim() === 'macros' || command.trim() === 'flash macros') {
            this.listMacros(tabId);
            return;
        }

        if (command.trim() === 'history') {
            this.showHistory(tabId);
            return;
        }

        await this.executeCommandLive(tabId, command);
    }

    async executeCommandLive(tabId, command) {
        const tab = this.tabs.find(t => t.id === tabId);
        if (!tab) return;

        try {
            ipcRenderer.on(`command-output-${tabId}`, (event, data) => {
                if (data.stdout) {
                    this.printLine(tabId, data.stdout, '');
                }
                if (data.stderr) {
                    this.printLine(tabId, data.stderr, 'error');
                }
            });

            const result = await ipcRenderer.invoke('execute-command-live', {
                command,
                sessionId: tab.sessionId,
                tabId: tabId
            });

            ipcRenderer.removeAllListeners(`command-output-${tabId}`);

            if (result.cwd) {
                const prompt = tab.panel.querySelector('.prompt');
                const shortPath = path.basename(result.cwd);
                prompt.innerHTML = `
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
                    </svg>
                    <span>${shortPath}</span>
                `;
            }
        } catch (error) {
            this.printLine(tabId, `Error: ${error.message}`, 'error');
        }
    }

    async handleFlashCommand(tabId, command) {
        const parts = command.split(' ').filter(p => p);
        
        if (parts.length < 2) {
            this.printLine(tabId, 'Usage: flash <subcommand> [args]', 'error');
            return;
        }

        const subcommand = parts[1];

        if (subcommand === 'language') {
            if (parts.length < 3) {
                this.printLine(tabId, 'Usage: flash language <language>', 'error');
                return;
            }
            const language = parts[2];
            this.printLine(tabId, `Setting up ${language} environment...`, 'info');
            // Add language setup logic here
            return;
        }

        if (subcommand === 'install') {
            if (parts.length < 3) {
                this.printLine(tabId, 'Usage: flash install <project>', 'error');
                return;
            }
            const project = parts.slice(2).join(' ');
            await this.detectAndInstall(tabId, project);
            return;
        }

        if (subcommand === 'macro') {
            await this.handleMacroCommand(tabId, command);
            return;
        }

        this.printLine(tabId, `Unknown flash command: ${subcommand}`, 'error');
    }

    async detectAndInstall(tabId, project) {
        const tab = this.tabs.find(t => t.id === tabId);
        if (!tab) return;

        try {
            const cwd = await ipcRenderer.invoke('get-cwd', tab.sessionId);
            const fs = require('fs');
            const path = require('path');

            if (fs.existsSync(path.join(cwd, 'package.json'))) {
                this.printLine(tabId, 'Detected Node.js project, installing with npm...', 'info');
                await this.executeCommandLive(tabId, `npm install ${project}`);
            } else if (fs.existsSync(path.join(cwd, 'requirements.txt')) || fs.existsSync(path.join(cwd, 'setup.py'))) {
                this.printLine(tabId, 'Detected Python project, installing with pip...', 'info');
                await this.executeCommandLive(tabId, `pip install ${project}`);
            } else {
                this.printLine(tabId, "Sorry we couldn't detect the language needed", 'warning');
                this.printLine(tabId, "Is this p:Pip or n:Npm", 'confirmation-prompt');
                this.awaitingPackageManager = project;
            }
        } catch (error) {
            this.printLine(tabId, "Sorry we couldn't detect the language needed", 'warning');
            this.printLine(tabId, "Is this p:Pip or n:Npm", 'confirmation-prompt');
            this.awaitingPackageManager = project;
        }
    }

    async handleMacroCommand(tabId, command) {
        const parts = command.split(' ').filter(p => p);
        
        if (parts.length < 3) {
            this.printLine(tabId, 'Usage:', 'warning');
            this.printLine(tabId, '  flash macro create <name> <number>', 'info');
            this.printLine(tabId, '  flash macro list', 'info');
            this.printLine(tabId, '  flash macro <name>', 'info');
            this.printLine(tabId, '  flash macro delete <name>', 'info');
            return;
        }

        const action = parts[2];

        if (action === 'list') {
            this.listMacrosDetailed(tabId);
            return;
        }

        if (action === 'create') {
            if (parts.length < 5) {
                this.printLine(tabId, 'Usage: flash macro create <name> <number>', 'error');
                this.printLine(tabId, 'Example: flash macro create deploy 5', 'info');
                return;
            }

            const macroName = parts[3];
            const count = parseInt(parts[4]);

            if (isNaN(count) || count < 1) {
                this.printLine(tabId, 'Error: Number must be a positive integer.', 'error');
                return;
            }

            if (count > this.commandHistory.length) {
                this.printLine(tabId, `Error: Only ${this.commandHistory.length} commands in history.`, 'error');
                return;
            }

            const commands = this.commandHistory.slice(-count);
            await this.saveMacro(macroName, commands);
            
            this.printLine(tabId, '', '');
            this.printLine(tabId, `Macro '${macroName}' created with ${count} commands:`, 'success');
            commands.forEach((cmd, i) => {
                this.printLine(tabId, `  ${i + 1}. ${cmd}`, 'info');
            });
            this.printLine(tabId, '', '');
            this.printLine(tabId, `Run with: flash macro ${macroName}`, 'accent');
        } 
        else if (action === 'delete') {
            if (parts.length < 4) {
                this.printLine(tabId, 'Usage: flash macro delete <name>', 'error');
                return;
            }

            const macroName = parts[3];

            if (!this.macros[macroName]) {
                this.printLine(tabId, `Macro '${macroName}' not found.`, 'error');
                return;
            }

            this.printLine(tabId, `Delete macro '${macroName}'? (y/n)`, 'confirmation-prompt');
            this.awaitingConfirmation = macroName;
        }
        else {
            const macroName = action;

            if (!this.macros[macroName]) {
                this.printLine(tabId, `Macro '${macroName}' not found.`, 'error');
                this.printLine(tabId, `Use 'flash macro list' to see available macros.`, 'info');
                return;
            }

            this.printLine(tabId, '', '');
            this.printLine(tabId, `Executing macro '${macroName}'...`, 'macro-indicator');
            this.printLine(tabId, '━'.repeat(60), 'secondary');

            for (const cmd of this.macros[macroName]) {
                this.printLine(tabId, `> ${cmd}`, 'command');
                await this.executeCommandLive(tabId, cmd);
                await this.delay(300);
            }

            this.printLine(tabId, '━'.repeat(60), 'secondary');
            this.printLine(tabId, `Macro '${macroName}' completed.`, 'success');
            this.printLine(tabId, '', '');
        }
    }

    listMacrosDetailed(tabId) {
        const macroNames = Object.keys(this.macros);
        
        if (macroNames.length === 0) {
            this.printLine(tabId, '', '');
            this.printLine(tabId, 'No macros saved yet.', 'warning');
            this.printLine(tabId, '', '');
            this.printLine(tabId, 'Create one with: flash macro create <name> <number>', 'info');
            this.printLine(tabId, '', '');
            return;
        }

        this.printLine(tabId, '', '');
        this.printLine(tabId, 'SAVED MACROS', 'accent');
        this.printLine(tabId, '━'.repeat(60), 'secondary');
        
        macroNames.forEach(name => {
            const commands = this.macros[name];
            this.printLine(tabId, '', '');
            this.printLine(tabId, `${name} (${commands.length} commands)`, 'macro-indicator');
            commands.forEach((cmd, i) => {
                this.printLine(tabId, `  ${i + 1}. ${cmd}`, 'info');
            });
        });
        
        this.printLine(tabId, '', '');
        this.printLine(tabId, '━'.repeat(60), 'secondary');
        this.printLine(tabId, '', '');
    }

    listMacros(tabId) {
        const macroNames = Object.keys(this.macros);
        
        if (macroNames.length === 0) {
            this.printLine(tabId, '', '');
            this.printLine(tabId, 'No macros saved yet.', 'warning');
            this.printLine(tabId, '', '');
            this.printLine(tabId, 'Create one with: flash macro create <name> <number>', 'info');
            this.printLine(tabId, '', '');
            return;
        }

        this.printLine(tabId, '', '');
        this.printLine(tabId, 'SAVED MACROS', 'accent');
        this.printLine(tabId, '━'.repeat(60), 'secondary');
        
        macroNames.forEach(name => {
            const commands = this.macros[name];
            this.printLine(tabId, `  ${name} (${commands.length} commands)`, 'macro-indicator');
        });
        
        this.printLine(tabId, '', '');
        this.printLine(tabId, `Use 'flash macro list' for detailed view`, 'info');
        this.printLine(tabId, '━'.repeat(60), 'secondary');
        this.printLine(tabId, '', '');
    }

    showHistory(tabId) {
        if (this.commandHistory.length === 0) {
            this.printLine(tabId, 'No command history yet.', 'warning');
            return;
        }

        this.printLine(tabId, '', '');
        this.printLine(tabId, 'COMMAND HISTORY', 'accent');
        this.printLine(tabId, '━'.repeat(60), 'secondary');
        
        const recentCommands = this.commandHistory.slice(-20);
        recentCommands.forEach((cmd, i) => {
            const index = this.commandHistory.length - recentCommands.length + i + 1;
            this.printLine(tabId, `${index}. ${cmd}`, 'info');
        });
        
        this.printLine(tabId, '━'.repeat(60), 'secondary');
        this.printLine(tabId, '', '');
    }

    showHelp(tabId) {
        this.printLine(tabId, '');
        this.printLine(tabId, 'FLASH TERMINAL v2.0.0 - ENHANCED EDITION', 'accent');
        this.printLine(tabId, '━'.repeat(60), 'secondary');
        this.printLine(tabId, '');
        this.printLine(tabId, 'MACRO COMMANDS:', 'accent');
        this.printLine(tabId, '  flash macro create <name> <number> - Create macro from last N commands', 'info');
        this.printLine(tabId, '  flash macro list                   - List all macros with commands', 'info');
        this.printLine(tabId, '  flash macro <name>                 - Execute saved macro', 'info');
        this.printLine(tabId, '  flash macro delete <name>          - Delete a macro', 'info');
        this.printLine(tabId, '  macros                             - Quick list of macros', 'info');
        this.printLine(tabId, '');
        this.printLine(tabId, 'PACKAGES:', 'accent');
        this.printLine(tabId, '  flash language <language>  - Set up language environment', 'info');
        this.printLine(tabId, '  flash install <project>    - Auto-detect and install package', 'info');
        this.printLine(tabId, '');
        this.printLine(tabId, 'SYSTEM COMMANDS:', 'accent');
        this.printLine(tabId, '  File: dir, ls, mkdir, del, copy, move, type', 'info');
        this.printLine(tabId, '  Network: ping, ipconfig, netstat, curl', 'info');
        this.printLine(tabId, '  Dev: python, node, npm, git, pip', 'info');
        this.printLine(tabId, '  System: tasklist, systeminfo, echo', 'info');
        this.printLine(tabId, '');
        this.printLine(tabId, 'TERMINAL COMMANDS:', 'accent');
        this.printLine(tabId, '  clear / cls    - Clear screen', 'info');
        this.printLine(tabId, '  history        - Show command history', 'info');
        this.printLine(tabId, '  help           - Show this help', 'info');
        this.printLine(tabId, '  exit           - Close current tab', 'info');
        this.printLine(tabId, '');
        this.printLine(tabId, 'SHORTCUTS:', 'accent');
        this.printLine(tabId, '  Ctrl+T - New tab    |  Ctrl+W - Close tab', 'info');
        this.printLine(tabId, '  Ctrl+L - Clear      |  Up/Down - History', 'info');
        this.printLine(tabId, '');
    }

    async showStartupAnimation() {
        if (this.tabs.length === 0) return;
        
        const tabId = this.tabs[0].id;
        
        await this.delay(100);
        this.printLine(tabId, 'Flash Terminal', 'accent');
        await this.delay(150);
        this.printLine(tabId, '━'.repeat(60), 'secondary');
        await this.delay(150);
        this.printLine(tabId, 'Native desktop application', 'success');
        await this.delay(150);
        this.printLine(tabId, 'Live console output', 'success');
        await this.delay(150);
        this.printLine(tabId, 'Macro system enabled', 'success');
        await this.delay(150);
        this.printLine(tabId, 'Smart package detection', 'success');
        await this.delay(150);
        this.printLine(tabId, 'Multi-tab sessions', 'success');
        await this.delay(200);
        this.printLine(tabId, '', '');
        this.printLine(tabId, "Type 'help' for available commands", 'warning');
        this.printLine(tabId, '━'.repeat(60), 'secondary');
        this.printLine(tabId, '', '');
    }

    historyUp(input) {
        if (this.historyIndex > 0) {
            this.historyIndex--;
            input.value = this.commandHistory[this.historyIndex];
        }
    }

    historyDown(input) {
        if (this.historyIndex < this.commandHistory.length - 1) {
            this.historyIndex++;
            input.value = this.commandHistory[this.historyIndex];
        } else {
            this.historyIndex = this.commandHistory.length;
            input.value = '';
        }
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

const terminal = new FlashTerminal();