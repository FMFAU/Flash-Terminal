// main.js
const { app, BrowserWindow, ipcMain } = require("electron");
const { spawn } = require("child_process");
const { Client } = require("ssh2");

const path = require("path");
const os = require("os");
const fs = require("fs");

process.on("uncaughtException", (error) => {
  console.error(`[DEBUG] ========== UNCAUGHT EXCEPTION ==========`);
  console.error(`[DEBUG] Error:`, error);
  console.error(`[DEBUG] Error message: ${error.message}`);
  console.error(`[DEBUG] Error stack:`, error.stack);
  console.error(`[DEBUG] ========================================`);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error(`[DEBUG] ========== UNHANDLED REJECTION ==========`);
  console.error(`[DEBUG] Reason:`, reason);
  console.error(`[DEBUG] Promise:`, promise);
  console.error(`[DEBUG] =========================================`);
});

process.on("error", (error) => {
  console.error(`[DEBUG] ========== PROCESS ERROR ==========`);
  console.error(`[DEBUG] Error:`, error);
  console.error(`[DEBUG] ===================================`);
});

let mainWindow;
const sessions = new Map();
const sshSessions = new Map();
const shellProcesses = new Map();

class TerminalSession {
  constructor() {
    this.cwd = process.cwd();
    this.env = { ...process.env };
    this.shellProcess = null;
    this.isSSH = false;
    this.sshConnection = null;
    this.sshStream = null;
    this.commandQueue = [];
    this.isProcessing = false;
  }

  destroy() {
    if (this.shellProcess) {
      try {
        this.shellProcess.kill();
      } catch (e) {
        console.error("Error killing shell process:", e);
      }
      this.shellProcess = null;
    }
    if (this.sshConnection) {
      try {
        this.sshConnection.end();
      } catch (e) {}
      this.sshConnection = null;
    }
    if (this.sshStream) {
      try {
        this.sshStream.destroy();
      } catch (e) {}
      this.sshStream = null;
    }
  }
}

function createWindow() {
  console.log(`[DEBUG] Creating main window...`);
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: "#0a0a0a",
    frame: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true,
    },
    icon: path.join(__dirname, "Assets/zap.png"),
  });

  console.log(`[DEBUG] Main window created, loading index.html...`);
  mainWindow.loadFile("index.html");

  // mainWindow.webContents.openDevTools();

  mainWindow.webContents.on("did-finish-load", () => {
    console.log(`[DEBUG] Main window finished loading`);
  });

  mainWindow.webContents.on("crashed", (event, killed) => {
    console.error(`[DEBUG] ========== RENDERER PROCESS CRASHED ==========`);
    console.error(`[DEBUG] Killed: ${killed}`);
    console.error(`[DEBUG] ===============================================`);
  });

  mainWindow.on("closed", () => {
    console.log(`[DEBUG] Main window closed`);
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  console.log(`[DEBUG] App ready, creating window...`);
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

ipcMain.on("window-minimize", () => mainWindow.minimize());
ipcMain.on("window-maximize", () =>
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()
);
ipcMain.on("window-close", () => mainWindow.close());

function getSession(sessionId) {
  console.log(`[DEBUG] getSession called - sessionId: ${sessionId}`);
  if (!sessions.has(sessionId)) {
    console.log(`[DEBUG] Creating new session for ${sessionId}`);
    sessions.set(sessionId, new TerminalSession());
  } else {
    console.log(`[DEBUG] Reusing existing session for ${sessionId}`);
  }
  const session = sessions.get(sessionId);
  console.log(`[DEBUG] Session state - cwd: ${session.cwd}, hasShellProcess: ${!!session.shellProcess}, isSSH: ${session.isSSH}`);
  return session;
}

function createShell(sessionId, tabId) {
  console.log(`[DEBUG] createShell called - sessionId: ${sessionId}, tabId: ${tabId}`);
  const session = getSession(sessionId);

  if (session.shellProcess && !session.shellProcess.killed) {
    console.log(`[DEBUG] Reusing existing shell process for session ${sessionId}`);
    console.log(`[DEBUG] Shell process state - killed: ${session.shellProcess.killed}, exitCode: ${session.shellProcess.exitCode}, pid: ${session.shellProcess.pid}`);
    return session.shellProcess;
  }

  const isWindows = process.platform === "win32";

  const shell = isWindows ? "powershell.exe" : os.userInfo().shell || "/bin/bash";

  const shellArgs = isWindows ? ["-NoExit", "-Command", "-"] : [];

  const isPowerShell = isWindows && shell.toLowerCase().includes("powershell");

    console.log(`[DEBUG] Creating new shell - shell: ${shell}, args: ${JSON.stringify(shellArgs)}, cwd: ${session.cwd}, isPowerShell: ${isPowerShell}`);

  try {
    console.log(`[DEBUG] Spawning shell process...`);
    const shellProcess = spawn(shell, shellArgs, {
      cwd: session.cwd,
      env: { ...session.env, FORCE_COLOR: "1", TERM: "xterm-256color" },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false
    });

    shellProcess._isPowerShell = isPowerShell;

    console.log(`[DEBUG] Shell process spawned - pid: ${shellProcess.pid}, killed: ${shellProcess.killed}, exitCode: ${shellProcess.exitCode}`);
    console.log(`[DEBUG] Shell stdin state - exists: ${!!shellProcess.stdin}, destroyed: ${shellProcess.stdin?.destroyed}, writableEnded: ${shellProcess.stdin?.writableEnded}`);
    console.log(`[DEBUG] Shell stdout state - exists: ${!!shellProcess.stdout}`);
    console.log(`[DEBUG] Shell stderr state - exists: ${!!shellProcess.stderr}`);

    session.shellProcess = shellProcess;
    shellProcesses.set(sessionId, shellProcess);

    shellProcess.stdout.on("data", (data) => {
      console.log(`[DEBUG] Shell stdout data received - sessionId: ${sessionId}, tabId: ${tabId}, length: ${data.length}`);
      try {
        const dataStr = data.toString();
        console.log(`[DEBUG] Stdout content preview (first 200 chars): ${dataStr.substring(0, 200).replace(/\n/g, '\\n').replace(/\r/g, '\\r')}`);
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
          try {
            mainWindow.webContents.send(`command-output-${tabId}`, {
              stdout: dataStr,
              stderr: "",
              type: "output"
            });
            console.log(`[DEBUG] Sent stdout to renderer - tabId: ${tabId}`);
          } catch (sendError) {
            console.error(`[DEBUG] Error sending stdout to renderer:`, sendError);
            console.error(`[DEBUG] Send error stack:`, sendError.stack);
          }
        } else {
          console.log(`[DEBUG] Cannot send stdout - mainWindow destroyed or not available`);
        }
      } catch (error) {
        console.error(`[DEBUG] Error handling stdout:`, error);
        console.error(`[DEBUG] Stdout error stack:`, error.stack);
      }
    });

    shellProcess.stderr.on("data", (data) => {
      console.log(`[DEBUG] Shell stderr data received - sessionId: ${sessionId}, tabId: ${tabId}, length: ${data.length}`);
      try {
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
          const dataStr = data.toString();
          console.log(`[DEBUG] Stderr content preview: ${dataStr.substring(0, 100).replace(/\n/g, '\\n')}`);
          mainWindow.webContents.send(`command-output-${tabId}`, {
            stdout: "",
            stderr: dataStr,
            type: "error"
          });
          console.log(`[DEBUG] Sent stderr to renderer - tabId: ${tabId}`);
        } else {
          console.log(`[DEBUG] Cannot send stderr - mainWindow destroyed or not available`);
        }
      } catch (error) {
        console.error(`[DEBUG] Error handling stderr:`, error);
        console.error(`[DEBUG] Stderr error stack:`, error.stack);
      }
    });

    shellProcess.on("exit", (code, signal) => {
      console.error(`[DEBUG] ========== Shell process EXITED ==========`);
      console.error(`[DEBUG] sessionId: ${sessionId}, tabId: ${tabId}, code: ${code}, signal: ${signal}`);
      console.error(`[DEBUG] This should not happen in interactive mode!`);
      shellProcesses.delete(sessionId);
      session.shellProcess = null;
      try {
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
          mainWindow.webContents.send(`command-output-${tabId}`, {
            stdout: `\n[Shell exited unexpectedly with code ${code}]\n`,
            stderr: "",
            type: "error"
          });
          console.log(`[DEBUG] Sent exit notification to renderer`);
        } else {
          console.log(`[DEBUG] Cannot send exit notification - mainWindow destroyed or not available`);
        }
      } catch (error) {
        console.error(`[DEBUG] Error handling exit:`, error);
        console.error(`[DEBUG] Exit error stack:`, error.stack);
      }
      console.error(`[DEBUG] ===========================================`);
    });

    shellProcess.on("error", (error) => {
      console.error(`[DEBUG] Shell process ERROR - sessionId: ${sessionId}, tabId: ${tabId}, error:`, error);
      console.error(`[DEBUG] Error details - message: ${error.message}, stack: ${error.stack}`);
      shellProcesses.delete(sessionId);
      session.shellProcess = null;
      try {
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
          mainWindow.webContents.send(`command-output-${tabId}`, {
            stdout: "",
            stderr: `Shell error: ${error.message}\n`,
            type: "error"
          });
          console.log(`[DEBUG] Sent error notification to renderer`);
        } else {
          console.log(`[DEBUG] Cannot send error notification - mainWindow destroyed or not available`);
        }
      } catch (sendError) {
        console.error(`[DEBUG] Error sending error notification:`, sendError);
      }
    });

    if (shellProcess.stdin) {
      shellProcess.stdin.on("error", (error) => {
        console.error(`[DEBUG] Shell stdin ERROR - sessionId: ${sessionId}, tabId: ${tabId}, error:`, error);
        console.error(`[DEBUG] Stdin error details - message: ${error.message}, code: ${error.code}, stack: ${error.stack}`);

      });

      shellProcess.stdin.on("close", () => {
        console.log(`[DEBUG] Shell stdin CLOSED - sessionId: ${sessionId}, tabId: ${tabId}`);
      });

      shellProcess.stdin.on("drain", () => {
        console.log(`[DEBUG] Shell stdin DRAIN - sessionId: ${sessionId}, tabId: ${tabId}`);
      });
    } else {
      console.error(`[DEBUG] Shell stdin is NULL - sessionId: ${sessionId}, tabId: ${tabId}`);
    }

    if (isWindows) {

      setInterval(() => {
        if (session.shellProcess && !session.shellProcess.killed) {

        }
      }, 1000);
    }

    console.log(`[DEBUG] Shell creation completed successfully - sessionId: ${sessionId}, tabId: ${tabId}, pid: ${shellProcess.pid}`);
    return shellProcess;
  } catch (error) {
    console.error(`[DEBUG] Failed to create shell - sessionId: ${sessionId}, tabId: ${tabId}, error:`, error);
    console.error(`[DEBUG] Error stack:`, error.stack);
    return null;
  }
}

ipcMain.on("session-destroy", (event, sessionId) => {
  const session = sessions.get(sessionId);
  if (session) {
    session.destroy();
    sessions.delete(sessionId);
  }
  if (sshSessions.has(sessionId)) {
    sshSessions.delete(sessionId);
  }
  if (shellProcesses.has(sessionId)) {
    try {
      shellProcesses.get(sessionId).kill();
    } catch (e) {}
    shellProcesses.delete(sessionId);
  }
});

ipcMain.handle("get-cwd", (event, sessionId) => {
  const session = getSession(sessionId);
  return session.cwd;
});

ipcMain.handle("execute-command-live", async (event, { command, sessionId, tabId }) => {
  console.log(`[DEBUG] ========== execute-command-live START ==========`);
  console.log(`[DEBUG] Command: "${command}", sessionId: ${sessionId}, tabId: ${tabId}`);

  try {
    const session = getSession(sessionId);
    console.log(`[DEBUG] Session retrieved - cwd: ${session.cwd}, isSSH: ${session.isSSH}, hasShellProcess: ${!!session.shellProcess}`);

    if (session.isSSH && session.sshStream) {
      console.log(`[DEBUG] Handling SSH command`);
      try {
        session.sshStream.write(command + "\n");
        console.log(`[DEBUG] SSH command written successfully`);
        return { success: true };
      } catch (error) {
        console.error(`[DEBUG] SSH write error:`, error);
        return { success: false, error: error.message };
      }
    }

    if (command.trim().toLowerCase().startsWith("cd ")) {
      console.log(`[DEBUG] Handling CD command`);
      let targetPath = command
        .trim()
        .substring(3)
        .trim()
        .replace(/^["']|["']$/g, "");

      if (!targetPath) targetPath = os.homedir();
      else if (targetPath.toLowerCase() === "desktop")
        targetPath = path.join(os.homedir(), "Desktop");
      else if (targetPath.toLowerCase() === "documents")
        targetPath = path.join(os.homedir(), "Documents");
      else if (targetPath.toLowerCase() === "downloads")
        targetPath = path.join(os.homedir(), "Downloads");
      else if (targetPath === "~") targetPath = os.homedir();
      else if (targetPath === "..") targetPath = path.dirname(session.cwd);
      else if (!path.isAbsolute(targetPath)) {
        const relativePath = path.join(session.cwd, targetPath);
        if (!fs.existsSync(relativePath)) {
          const commonLocations = [
            path.join(os.homedir(), targetPath),
            path.join(os.homedir(), "Desktop", targetPath),
            path.join(os.homedir(), "Documents", targetPath),
            path.join("C:\\", targetPath),
          ];
          let found = false;
          for (const loc of commonLocations) {
            if (fs.existsSync(loc) && fs.statSync(loc).isDirectory()) {
              targetPath = loc;
              found = true;
              break;
            }
          }
          if (!found) targetPath = relativePath;
        } else targetPath = relativePath;
      }

      targetPath = path.normalize(targetPath);
      console.log(`[DEBUG] CD target path: ${targetPath}`);

      if (fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory()) {
        session.cwd = targetPath;
        console.log(`[DEBUG] CD successful, new cwd: ${session.cwd}`);

        const shell = createShell(sessionId, tabId);
        console.log(`[DEBUG] CD shell state - exists: ${!!shell}, killed: ${shell?.killed}, hasStdin: ${!!shell?.stdin}`);
        if (shell && !shell.killed && shell.stdin && !shell.stdin.destroyed && !shell.stdin.writableEnded) {
          try {

            const isWindows = process.platform === "win32";
            const isPowerShell = shell._isPowerShell !== undefined ? shell._isPowerShell : (isWindows && shell.spawnfile && shell.spawnfile.toLowerCase().includes("powershell"));

            const cdCommand = isWindows 
              ? (isPowerShell ? `Set-Location "${targetPath.replace(/\\/g, '/')}"\r\n` : `cd /d "${targetPath}"\r\n`)
              : `cd "${targetPath}"\n`;
            console.log(`[DEBUG] Writing CD command to shell: ${cdCommand.trim()}, isPowerShell: ${isPowerShell}, shell._isPowerShell: ${shell._isPowerShell}`);
            shell.stdin.write(cdCommand);
            console.log(`[DEBUG] CD command written successfully`);
          } catch (error) {
            console.error(`[DEBUG] Error writing cd command:`, error);
            console.error(`[DEBUG] Error stack:`, error.stack);
          }
        } else {
          console.log(`[DEBUG] Cannot write CD command - shell not available or stdin not writable`);
        }

        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
          mainWindow.webContents.send(`command-output-${tabId}`, {
            stdout: "",
            stderr: "",
            type: "cwd-update",
            cwd: session.cwd
          });
        }
      } else {
        console.log(`[DEBUG] CD failed - path does not exist or is not a directory: ${targetPath}`);
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
          mainWindow.webContents.send(`command-output-${tabId}`, {
            stdout: "",
            stderr: `The system cannot find the path specified: ${targetPath}\n`,
            type: "error"
          });
        }
      }
      console.log(`[DEBUG] ========== execute-command-live END (CD) ==========`);
      return { success: true };
    }

    console.log(`[DEBUG] Getting or creating shell for command execution`);
    const shell = createShell(sessionId, tabId);
    console.log(`[DEBUG] Shell retrieved - exists: ${!!shell}, killed: ${shell?.killed}, exitCode: ${shell?.exitCode}, pid: ${shell?.pid}`);

    if (!shell || shell.killed) {
      console.error(`[DEBUG] Shell is null or killed - cannot execute command`);
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
        mainWindow.webContents.send(`command-output-${tabId}`, {
          stdout: "",
          stderr: "Failed to create shell process\n",
          type: "error"
        });
      }
      console.log(`[DEBUG] ========== execute-command-live END (no shell) ==========`);
      return { success: false, error: "Shell process not available" };
    }

    try {
      console.log(`[DEBUG] Checking shell state before writing...`);
      console.log(`[DEBUG] Shell state - killed: ${shell.killed}, exitCode: ${shell.exitCode}, hasStdin: ${!!shell.stdin}`);
      if (shell.stdin) {
        console.log(`[DEBUG] Stdin state - destroyed: ${shell.stdin.destroyed}, writableEnded: ${shell.stdin.writableEnded}, writable: ${shell.stdin.writable}`);
      }

      if (shell.killed || shell.exitCode !== null || !shell.stdin || shell.stdin.destroyed || shell.stdin.writableEnded) {
        console.log(`[DEBUG] Shell process is dead or stdin not writable - attempting to recreate`);

        session.shellProcess = null;
        const newShell = createShell(sessionId, tabId);
        console.log(`[DEBUG] New shell created - exists: ${!!newShell}, killed: ${newShell?.killed}`);
        if (!newShell || newShell.killed) {
          console.error(`[DEBUG] Failed to recreate shell`);
          if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
            mainWindow.webContents.send(`command-output-${tabId}`, {
              stdout: "",
              stderr: "Shell process died and could not be recreated\n",
              type: "error"
            });
          }
          console.log(`[DEBUG] ========== execute-command-live END (recreate failed) ==========`);
          return { success: false, error: "Shell process not available" };
        }

        const commandToSend = process.platform === "win32" 
          ? command + "\r\n"
          : command + "\n";
        console.log(`[DEBUG] Writing command to new shell: "${commandToSend.trim()}"`);
        if (newShell.stdin && !newShell.stdin.destroyed && !newShell.stdin.writableEnded) {
          try {
            newShell.stdin.write(commandToSend);
            console.log(`[DEBUG] Command written to new shell successfully`);
          } catch (writeError) {
            console.error(`[DEBUG] Error writing to new shell:`, writeError);
            console.error(`[DEBUG] Write error stack:`, writeError.stack);
            throw writeError;
          }
        } else {
          console.error(`[DEBUG] New shell stdin not writable`);
          throw new Error("New shell stdin is not writable");
        }
        console.log(`[DEBUG] ========== execute-command-live END (recreated shell) ==========`);
        return { success: true };
      }

      const commandToSend = process.platform === "win32" 
        ? command + "\r\n"
        : command + "\n";

      console.log(`[DEBUG] Writing command to shell: "${commandToSend.trim()}"`);
      console.log(`[DEBUG] Final stdin check - exists: ${!!shell.stdin}, destroyed: ${shell.stdin?.destroyed}, writableEnded: ${shell.stdin?.writableEnded}, writable: ${shell.stdin?.writable}`);

      if (shell.stdin && !shell.stdin.destroyed && !shell.stdin.writableEnded) {
        try {
          const writeResult = shell.stdin.write(commandToSend);
          console.log(`[DEBUG] Command written successfully, write result: ${writeResult}`);
          console.log(`[DEBUG] ========== execute-command-live END (success) ==========`);
          return { success: true };
        } catch (writeError) {
          console.error(`[DEBUG] Error during stdin.write:`, writeError);
          console.error(`[DEBUG] Write error details - message: ${writeError.message}, code: ${writeError.code}, stack: ${writeError.stack}`);
          throw writeError;
        }
      } else {
        const errorMsg = `Shell stdin is not writable - exists: ${!!shell.stdin}, destroyed: ${shell.stdin?.destroyed}, writableEnded: ${shell.stdin?.writableEnded}`;
        console.error(`[DEBUG] ${errorMsg}`);
        throw new Error(errorMsg);
      }
    } catch (error) {
      console.error(`[DEBUG] ========== ERROR in execute-command-live ==========`);
      console.error(`[DEBUG] Error writing to shell:`, error);
      console.error(`[DEBUG] Error type: ${error.constructor.name}`);
      console.error(`[DEBUG] Error message: ${error.message}`);
      console.error(`[DEBUG] Error stack:`, error.stack);

      try {
        console.log(`[DEBUG] Attempting to recreate shell after error...`);
        session.shellProcess = null;
        const newShell = createShell(sessionId, tabId);
        console.log(`[DEBUG] Recreated shell - exists: ${!!newShell}, killed: ${newShell?.killed}`);
        if (newShell && !newShell.killed && newShell.stdin && !newShell.stdin.destroyed) {
          const commandToSend = process.platform === "win32" 
            ? command + "\r\n"
            : command + "\n";
          console.log(`[DEBUG] Retrying command write to recreated shell`);
          newShell.stdin.write(commandToSend);
          console.log(`[DEBUG] Command written to recreated shell successfully`);
          console.log(`[DEBUG] ========== execute-command-live END (recreated after error) ==========`);
          return { success: true };
        } else {
          console.error(`[DEBUG] Recreated shell is not usable`);
        }
      } catch (recreateError) {
        console.error(`[DEBUG] Error recreating shell:`, recreateError);
        console.error(`[DEBUG] Recreate error stack:`, recreateError.stack);
      }

      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
        try {
          mainWindow.webContents.send(`command-output-${tabId}`, {
            stdout: "",
            stderr: `Error executing command: ${error.message}\n`,
            type: "error"
          });
          console.log(`[DEBUG] Sent error message to renderer`);
        } catch (sendError) {
          console.error(`[DEBUG] Error sending error message:`, sendError);
        }
      }
      console.log(`[DEBUG] ========== execute-command-live END (error) ==========`);
      return { success: false, error: error.message };
    }
  } catch (error) {
    console.error(`[DEBUG] ========== OUTER ERROR in execute-command-live ==========`);
    console.error(`[DEBUG] Error in execute-command-live:`, error);
    console.error(`[DEBUG] Error type: ${error.constructor.name}`);
    console.error(`[DEBUG] Error message: ${error.message}`);
    console.error(`[DEBUG] Error stack:`, error.stack);
    console.log(`[DEBUG] ========== execute-command-live END (outer error) ==========`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle("resize-pty", (event, { sessionId, cols, rows }) => {
  return { success: true };
});

ipcMain.handle("ssh-connect", async (event, { sessionId, tabId, host, username, password, port = 22 }) => {
  return new Promise((resolve, reject) => {
    try {
      if (!mainWindow || !mainWindow.webContents) {
        reject(new Error("Main window not available"));
        return;
      }

      const session = getSession(sessionId);
      const conn = new Client();
      let isResolved = false;

      const safeSend = (data) => {
        try {
          if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
            mainWindow.webContents.send(`command-output-${tabId}`, data);
          }
        } catch (e) {
          console.error("Error sending SSH data:", e);
        }
      };

      conn.on("ready", () => {
        try {
          conn.shell((err, stream) => {
            if (err) {
              if (!isResolved) {
                isResolved = true;
                conn.end();
                reject(err);
              }
              return;
            }

            if (!stream) {
              if (!isResolved) {
                isResolved = true;
                conn.end();
                reject(new Error("Failed to create SSH shell"));
              }
              return;
            }

            session.isSSH = true;
            session.sshConnection = conn;
            session.sshStream = stream;
            sshSessions.set(sessionId, { conn, stream });

            stream.on("data", (data) => {
              if (data) {
                safeSend({
                  stdout: data.toString(),
                  stderr: "",
                  type: "output"
                });
              }
            });

            if (stream.stderr) {
              stream.stderr.on("data", (data) => {
                if (data) {
                  safeSend({
                    stdout: "",
                    stderr: data.toString(),
                    type: "error"
                  });
                }
              });
            }

            stream.on("close", () => {
              safeSend({
                stdout: "\n[SSH connection closed]\n",
                stderr: "",
                type: "info"
              });
              session.isSSH = false;
              session.sshConnection = null;
              session.sshStream = null;
              sshSessions.delete(sessionId);
            });

            stream.on("error", (err) => {
              console.error("SSH stream error:", err);
              safeSend({
                stdout: "",
                stderr: `SSH stream error: ${err.message}\n`,
                type: "error"
              });
            });

            if (!isResolved) {
              isResolved = true;
              resolve({ success: true });
            }
          });
        } catch (e) {
          if (!isResolved) {
            isResolved = true;
            conn.end();
            reject(e);
          }
        }
      });

      conn.on("error", (err) => {
        console.error("SSH connection error:", err);
        if (!isResolved) {
          isResolved = true;
          try {
            safeSend({
              stdout: "",
              stderr: `SSH connection error: ${err.message}\n`,
              type: "error"
            });
          } catch (e) {
            console.error("Error in safeSend:", e);
          }
          try {
            conn.end();
          } catch (e) {}
          reject(err);
        }
      });

      conn.on("close", () => {
        if (session.isSSH) {
          session.isSSH = false;
          session.sshConnection = null;
          session.sshStream = null;
          sshSessions.delete(sessionId);
        }
      });

      conn.connect({
        host,
        port: parseInt(port) || 22,
        username,
        password,
        readyTimeout: 20000,
        tryKeyboard: false
      });
    } catch (error) {
      reject(error);
    }
  });
});

ipcMain.handle("ssh-disconnect", (event, sessionId) => {
  const session = sessions.get(sessionId);
  if (session && session.sshConnection) {
    session.sshConnection.end();
    session.isSSH = false;
    session.sshConnection = null;
    session.sshStream = null;
  }
  if (sshSessions.has(sessionId)) {
    sshSessions.delete(sessionId);
  }
  return { success: true };
});

ipcMain.handle("execute-command", async (event, { command, sessionId }) => {
  const session = getSession(sessionId);

  return new Promise((resolve) => {
    const isWindows = process.platform === "win32";
    const shell = isWindows ? "cmd.exe" : "/bin/sh";
    const shellArgs = isWindows ? ["/c", command] : ["-c", command];

    const child = spawn(shell, shellArgs, {
      cwd: session.cwd,
      env: session.env,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      resolve({
        stdout,
        stderr,
        returncode: code,
        cwd: session.cwd,
      });
    });

    child.on("error", (error) => {
      resolve({
        stdout: "",
        stderr: error.message,
        returncode: 1,
        cwd: session.cwd,
      });
    });
  });
});

ipcMain.handle("ssh-execute", async (event, { host, username, password, command, port = 22 }) => {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let stdout = "";
    let stderr = "";

    conn.on("ready", () => {
      conn.exec(command || "echo Connected", (err, stream) => {
        if (err) {
          conn.end();
          reject(err);
          return;
        }

        stream.on("close", (code, signal) => {
          conn.end();
          resolve({ stdout, stderr, code });
        }).on("data", (data) => {
          stdout += data.toString();
        }).stderr.on("data", (data) => {
          stderr += data.toString();
        });
      });
    }).on("error", (err) => {
      reject(err);
    }).connect({
      host,
      port,
      username,
      password,
      readyTimeout: 20000,
      tryKeyboard: false
    });
  });
});

ipcMain.handle("save-macro", async (event, { name, commands }) => {
  const savesDir = path.join(app.getPath("userData"), "Saves");
  const macrosFile = path.join(savesDir, "macros.json");

  if (!fs.existsSync(savesDir)) fs.mkdirSync(savesDir, { recursive: true });

  let macros = {};
  if (fs.existsSync(macrosFile)) {
    macros = JSON.parse(fs.readFileSync(macrosFile, "utf8"));
  }

  macros[name] = commands;
  fs.writeFileSync(macrosFile, JSON.stringify(macros, null, 2));

  return { success: true };
});

ipcMain.handle("load-macros", async () => {
  const savesDir = path.join(app.getPath("userData"), "Saves");
  const macrosFile = path.join(savesDir, "macros.json");

  if (fs.existsSync(macrosFile)) {
    return JSON.parse(fs.readFileSync(macrosFile, "utf8"));
  }

  return {};
});

ipcMain.handle("delete-macro", async (event, name) => {
  const savesDir = path.join(app.getPath("userData"), "Saves");
  const macrosFile = path.join(savesDir, "macros.json");

  if (fs.existsSync(macrosFile)) {
    const macros = JSON.parse(fs.readFileSync(macrosFile, "utf8"));
    delete macros[name];
    fs.writeFileSync(macrosFile, JSON.stringify(macros, null, 2));
    return { success: true };
  }

  return { success: false };
});