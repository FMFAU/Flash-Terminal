const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');



let mainWindow;
const sessions = new Map();

class TerminalSession {
    constructor() {
        this.cwd = process.cwd();
        this.env = { ...process.env };
    }
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 800,
        minHeight: 600,
        backgroundColor: '#0c0c0c',
        frame: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            enableRemoteModule: true
        },
        icon: path.join(__dirname, 'Assets/zap.png')
    });

    mainWindow.loadFile('index.html');

    // mainWindow.webContents.openDevTools(); // Debugging
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

ipcMain.on('window-minimize', () => {
    mainWindow.minimize();
});

ipcMain.on('window-maximize', () => {
    if (mainWindow.isMaximized()) {
        mainWindow.unmaximize();
    } else {
        mainWindow.maximize();
    }
});

ipcMain.on('window-close', () => {
    mainWindow.close();
});

ipcMain.handle('execute-command', async (event, { command, sessionId }) => {
    if (!sessions.has(sessionId)) {
        sessions.set(sessionId, new TerminalSession());
    }

    const session = sessions.get(sessionId);

    return new Promise((resolve) => {
        if (command.trim().toLowerCase().startsWith('cd ')) {
            let targetPath = command.trim().substring(3).trim().replace(/^["']|["']$/g, '');

            if (!targetPath) {
                targetPath = os.homedir();
            }
            else if (targetPath.toLowerCase() === 'desktop') {
                targetPath = path.join(os.homedir(), 'Desktop');
            }
            else if (targetPath.toLowerCase() === 'documents') {
                targetPath = path.join(os.homedir(), 'Documents');
            }
            else if (targetPath.toLowerCase() === 'downloads') {
                targetPath = path.join(os.homedir(), 'Downloads');
            }
            else if (targetPath === '~') {
                targetPath = os.homedir();
            }
            else if (targetPath === '..') {
                targetPath = path.dirname(session.cwd);
            }
            else if (!path.isAbsolute(targetPath)) {
                const relativePath = path.join(session.cwd, targetPath);
                
                if (!fs.existsSync(relativePath)) {
                    const commonLocations = [
                        path.join(os.homedir(), targetPath),
                        path.join(os.homedir(), 'Desktop', targetPath),
                        path.join(os.homedir(), 'Documents', targetPath),
                        path.join('C:\\', targetPath)
                    ];

                    let found = false;
                    for (const loc of commonLocations) {
                        if (fs.existsSync(loc) && fs.statSync(loc).isDirectory()) {
                            targetPath = loc;
                            found = true;
                            break;
                        }
                    }

                    if (!found) {
                        targetPath = relativePath;
                    }
                } else {
                    targetPath = relativePath;
                }
            }

            targetPath = path.normalize(targetPath);

            if (fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory()) {
                session.cwd = targetPath;
                process.chdir(targetPath);
                resolve({
                    stdout: `Changed directory to: ${targetPath}`,
                    stderr: '',
                    returncode: 0,
                    cwd: session.cwd
                });
            } else {
                resolve({
                    stdout: '',
                    stderr: `The system cannot find the path specified: ${targetPath}`,
                    returncode: 1,
                    cwd: session.cwd
                });
            }
            return;
        }

        let stdout = '';
        let stderr = '';

        const isWindows = process.platform === 'win32';
        const shell = isWindows ? 'cmd.exe' : '/bin/sh';
        const shellArgs = isWindows ? ['/c', command] : ['-c', command];

        const child = spawn(shell, shellArgs, {
            cwd: session.cwd,
            env: session.env,
            windowsHide: true
        });

        child.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        child.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        child.on('close', (code) => {
            resolve({
                stdout: stdout,
                stderr: stderr,
                returncode: code,
                cwd: session.cwd
            });
        });

        child.on('error', (error) => {
            resolve({
                stdout: '',
                stderr: error.message,
                returncode: 1,
                cwd: session.cwd
            });
        });

        setTimeout(() => {
            child.kill();
            resolve({
                stdout: stdout,
                stderr: stderr + '\nCommand timed out after 60 seconds',
                returncode: -1,
                cwd: session.cwd
            });
        }, 60000);
    });
});

ipcMain.handle('execute-command-live', (e, data) => {
    const { command, sessionId, tabId } = data

    if (!sessions.has(sessionId)) {
        sessions.set(sessionId, new TerminalSession())
    }

    const session = sessions.get(sessionId)

    return new Promise(resolve => {
        const child = spawn(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', 
            process.platform === 'win32' ? ['/c', command] : ['-c', command],
            {
                cwd: session.cwd,
                env: session.env,
                windowsHide: true
            }
        )

        child.stdout.on('data', v => {
            e.sender.send(`command-output-${tabId}`, { stdout: v.toString() })
        })

        child.stderr.on('data', v => {
            e.sender.send(`command-output-${tabId}`, { stderr: v.toString() })
        })

        child.on('close', () => {
            resolve({ cwd: session.cwd })
        })

        child.on('error', err => {
            e.sender.send(`command-output-${tabId}`, { stderr: err.message })
            resolve({ cwd: session.cwd })
        })
    })
})


ipcMain.handle('get-cwd', () => {
    return process.cwd();
});

ipcMain.handle('save-macro', async (event, { name, commands }) => {
    const savesDir = path.join(app.getPath('userData'), 'Saves');
    const macrosFile = path.join(savesDir, 'macros.json');
    
    if (!fs.existsSync(savesDir)) {
        fs.mkdirSync(savesDir, { recursive: true });
    }
    
    let macros = {};
    if (fs.existsSync(macrosFile)) {
        macros = JSON.parse(fs.readFileSync(macrosFile, 'utf8'));
    }
    
    macros[name] = commands;
    fs.writeFileSync(macrosFile, JSON.stringify(macros, null, 2));
    
    return { success: true };
});

ipcMain.handle('load-macros', async () => {
    const savesDir = path.join(app.getPath('userData'), 'Saves');
    const macrosFile = path.join(savesDir, 'macros.json');
    
    if (fs.existsSync(macrosFile)) {
        return JSON.parse(fs.readFileSync(macrosFile, 'utf8'));
    }
    
    return {};
});

ipcMain.handle('delete-macro', async (event, name) => {
    const savesDir = path.join(app.getPath('userData'), 'Saves');
    const macrosFile = path.join(savesDir, 'macros.json');
    
    if (fs.existsSync(macrosFile)) {
        const macros = JSON.parse(fs.readFileSync(macrosFile, 'utf8'));
        delete macros[name];
        fs.writeFileSync(macrosFile, JSON.stringify(macros, null, 2));
        return { success: true };
    }
    
    return { success: false };
});