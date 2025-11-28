// renderer.js
const { ipcRenderer } = require("electron");
const os = require("os");
const path = require("path");

let Convert, convert;
try {
  Convert = require("ansi-to-html");
  convert = new Convert({
    fg: "#cccccc",
    bg: "#0c0c0c",
    newline: true,
    escapeXML: true,
    stream: true,
  });
} catch (e) {
  console.warn("ansi-to-html not available, using fallback");
  convert = {
    toHtml: (text) => {
      return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\n/g, "<br>");
    },
  };
}

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
    this.awaitingSSHPassword = false;
    this.awaitingSSHCommand = null;
    this.outputListeners = new Map();

    this.outputBuffers = new Map();
    this.outputTimeouts = new Map();
    this.BATCH_DELAY = 0;
    this.lastProcessTime = new Map();

    this.init();
  }

  async init() {
    this.setupEventListeners();
    await this.loadMacros();
    this.createTab();
    this.showStartupAnimation();
  }

  setupEventListeners() {
    document
      .getElementById("newTabBtn")
      .addEventListener("click", () => this.createTab());
    document.getElementById("minimizeBtn").addEventListener("click", () => {
      ipcRenderer.send("window-minimize");
    });
    document.getElementById("maximizeBtn").addEventListener("click", () => {
      ipcRenderer.send("window-maximize");
    });
    document.getElementById("closeBtn").addEventListener("click", () => {
      ipcRenderer.send("window-close");
    });

    document.addEventListener("keydown", (e) => {
      if (e.ctrlKey && e.key === "t") {
        e.preventDefault();
        this.createTab();
      } else if (e.ctrlKey && e.key === "w") {
        e.preventDefault();
        if (this.activeTabId) this.closeTab(this.activeTabId);
      } else if (e.ctrlKey && e.key === "l") {
        e.preventDefault();
        this.clearTerminal();
      }
    });

    document.addEventListener("click", () => {
      this.hideContextMenu();
    });

    this.setupContextMenu();
    this.setupResizeHandler();
  }

  setupResizeHandler() {
    window.addEventListener("resize", () => {});
  }

  setupContextMenu() {
    const contextMenu = document.getElementById("contextMenu");

    contextMenu.addEventListener("click", (e) => {
      e.stopPropagation();
      const item = e.target.closest(".context-menu-item");
      if (!item) return;

      const action = item.dataset.action;
      const tabId = contextMenu.dataset.tabId;

      switch (action) {
        case "color":
          this.changeTabColor(tabId);
          break;
        case "rename":
          this.renameTab(tabId);
          break;
        case "duplicate":
          this.duplicateTab(tabId);
          break;
        case "split":
          this.splitTab(tabId);
          break;
        case "move":
          this.printLine(tabId, "Tab move functionality coming soon", "info");
          break;
        case "export":
          this.exportTabText(tabId);
          break;
        case "find":
          this.findInTab(tabId);
          break;
        case "close-other":
          this.closeOtherTabs(tabId);
          break;
        case "close":
          this.closeTab(tabId);
          break;
      }

      this.hideContextMenu();
    });
  }

  showContextMenu(tabId, x, y) {
    const contextMenu = document.getElementById("contextMenu");
    contextMenu.dataset.tabId = tabId;
    contextMenu.classList.add("active");

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

    contextMenu.style.left = left + "px";
    contextMenu.style.top = top + "px";
  }

  hideContextMenu() {
    const contextMenu = document.getElementById("contextMenu");
    contextMenu.classList.remove("active");
  }

  renameTab(tabId) {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return;

    const tabBtn = tab.button;
    const titleSpan =
      tabBtn.querySelector(".tab-title span") ||
      tabBtn.querySelector(".tab-title");
    const input = document.createElement("input");

    input.value = titleSpan.textContent;
    input.className = "tab-rename-input";

    titleSpan.replaceWith(input);
    input.focus();
    input.select();

    const finish = () => {
      const newTitle = input.value.trim() || titleSpan.textContent;
      const newSpan = document.createElement("span");
      newSpan.textContent = newTitle;
      input.replaceWith(newSpan);
    };

    input.addEventListener("blur", finish);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish();
      else if (e.key === "Escape") finish();
    });
  }

  duplicateTab(tabId) {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return;

    const titleSpan =
      tab.button.querySelector(".tab-title span") ||
      tab.button.querySelector(".tab-title");
    this.createTab(titleSpan.textContent + " (Copy)");
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

    const tabBtn = document.createElement("div");
    tabBtn.className = "tab";
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

    const panel = document.createElement("div");
    panel.className = "terminal-panel";
    panel.dataset.tabId = tabId;
    panel.innerHTML = `
            <div class="terminal-output" contenteditable="true" spellcheck="false"></div>
            <div class="terminal-input-container">
                <span class="prompt"></span>
                <input type="text" class="terminal-input" placeholder="" autocomplete="off" spellcheck="false" />
            </div>
        `;

    const tabBar = document.querySelector(".tab-bar");
    const newTabBtn = document.getElementById("newTabBtn");
    tabBar.insertBefore(tabBtn, newTabBtn);
    document.getElementById("terminalContainer").appendChild(panel);

    const output = panel.querySelector(".terminal-output");
    const input = panel.querySelector(".terminal-input");

    this.setupOutputListener(tabId);

    this.tabs.push({
      id: tabId,
      name: tabName,
      button: tabBtn,
      panel: panel,
      output: output,
      input: input,
      sessionId: tabId,
      tabNumber: tabNumber,
    });

    tabBtn.addEventListener("click", (e) => {
      if (
        !e.target.classList.contains("tab-close") &&
        !e.target.closest(".tab-close")
      ) {
        this.switchTab(tabId);
      }
    });

    tabBtn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.showContextMenu(tabId, e.clientX, e.clientY);
    });

    tabBtn.querySelector(".tab-close").addEventListener("click", (e) => {
      e.stopPropagation();
      this.closeTab(tabId);
    });

    tabBtn.addEventListener("auxclick", (e) => {
      if (e.button === 1) {
        e.preventDefault();
        e.stopPropagation();
        this.closeTab(tabId);
      }
    });

    tabBtn.addEventListener("dblclick", () => {
      this.renameTab(tabId);
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        this.executeCommand(tabId, input.value);
        input.value = "";
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        this.historyUp(input);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        this.historyDown(input);
      }
    });

    output.addEventListener("keydown", (e) => {
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        input.focus();
        input.value += e.key;
      }
    });

    this.switchTab(tabId);
    return tabId;
  }

  setupOutputListener(tabId) {
    if (this.outputListeners.has(tabId)) {
      ipcRenderer.removeAllListeners(`command-output-${tabId}`);
    }

    if (!this.outputBuffers.has(tabId)) {
      this.outputBuffers.set(tabId, []);
    }

    const listener = (event, data) => {
      try {
        console.log(
          `[DEBUG-RENDERER] Output received - tabId: ${tabId}, type: ${
            data.type
          }, hasStdout: ${!!data.stdout}, hasStderr: ${!!data.stderr}`
        );

        if (data.type === "cwd-update" && data.cwd) {
          this.updatePromptFromCwd(tabId, data.cwd);
          return;
        }

        const outputText = data.stdout || data.stderr || "";
        if (outputText) {
          const buffer = this.outputBuffers.get(tabId) || [];
          buffer.push({ text: outputText, type: data.type || "output" });
          this.outputBuffers.set(tabId, buffer);

          const now = Date.now();
          const lastProcess = this.lastProcessTime.get(tabId) || 0;
          const timeSinceLastProcess = now - lastProcess;

          if (timeSinceLastProcess >= this.BATCH_DELAY) {
            this.lastProcessTime.set(tabId, now);
            this.processOutputBatch(tabId);
          } else {
            if (this.outputTimeouts.has(tabId)) {
              clearTimeout(this.outputTimeouts.get(tabId));
            }

            const remainingTime = this.BATCH_DELAY - timeSinceLastProcess;
            const timeoutId = setTimeout(() => {
              this.lastProcessTime.set(tabId, Date.now());
              this.processOutputBatch(tabId);
            }, remainingTime);

            this.outputTimeouts.set(tabId, timeoutId);
          }
        }
      } catch (error) {
        console.error(
          `[DEBUG-RENDERER] ========== ERROR in output listener ==========`
        );
        console.error(`[DEBUG-RENDERER] Error:`, error);
        console.error(`[DEBUG-RENDERER] Error type: ${error.constructor.name}`);
        console.error(`[DEBUG-RENDERER] Error message: ${error.message}`);
        console.error(`[DEBUG-RENDERER] Error stack:`, error.stack);
        console.error(`[DEBUG-RENDERER] Data that caused error:`, data);
        console.error(
          `[DEBUG-RENDERER] ===============================================`
        );

        try {
          const tab = this.tabs.find((t) => t.id === tabId);
          if (tab) {
            const errorDiv = document.createElement("div");
            errorDiv.className = "output-line error";
            errorDiv.textContent = `[Error displaying output: ${error.message}]`;
            tab.output.appendChild(errorDiv);
            tab.output.scrollTop = tab.output.scrollHeight;
          }
        } catch (displayError) {
          console.error(
            `[DEBUG-RENDERER] Could not display error:`,
            displayError
          );
        }
      }
    };

    ipcRenderer.on(`command-output-${tabId}`, listener);
    this.outputListeners.set(tabId, listener);
  }

  processOutputBatch(tabId) {
    try {
      const buffer = this.outputBuffers.get(tabId);
      if (!buffer || buffer.length === 0) {
        return;
      }

      console.log(
        `[DEBUG-RENDERER] Processing output batch - tabId: ${tabId}, items: ${buffer.length}`
      );

      if (buffer.length <= 5) {
        for (const item of buffer) {
          if (item.text) {
            this.appendOutput(tabId, item.text, item.type || "output");
          }
        }
      } else {
        let combinedText = "";
        let combinedType = "output";

        for (const item of buffer) {
          combinedText += item.text;
          if (item.type === "error") {
            combinedType = "error";
          }
        }

        if (combinedText) {
          this.appendOutput(tabId, combinedText, combinedType);
        }
      }

      this.outputBuffers.set(tabId, []);
      this.outputTimeouts.delete(tabId);
    } catch (error) {
      console.error(`[DEBUG-RENDERER] Error processing output batch:`, error);
      console.error(`[DEBUG-RENDERER] Error stack:`, error.stack);

      this.outputBuffers.set(tabId, []);
      this.outputTimeouts.delete(tabId);
    }
  }

  switchTab(tabId) {
    if (this.activeTabId === tabId) return;

    this.tabs.forEach((tab) => {
      tab.button.classList.remove("active");
      tab.panel.classList.remove("active");
    });

    const tab = this.tabs.find((t) => t.id === tabId);
    if (tab) {
      requestAnimationFrame(() => {
        tab.button.classList.add("active");
        tab.panel.classList.add("active");
        tab.input.focus();
        this.activeTabId = tabId;

        this.updatePrompt(tabId);
      });
    }
  }

  closeTab(tabId) {
    const tabIndex = this.tabs.findIndex((t) => t.id === tabId);
    if (tabIndex === -1) return;

    const tab = this.tabs[tabIndex];

    if (this.outputListeners.has(tabId)) {
      ipcRenderer.removeAllListeners(`command-output-${tabId}`);
      this.outputListeners.delete(tabId);
    }

    ipcRenderer.send("session-destroy", tabId);

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
    const tab = this.tabs.find((t) => t.id === this.activeTabId);
    if (tab) {
      tab.output.innerHTML = "";
    }
  }

  appendOutput(tabId, text, type = "output") {
    try {
      const tab = this.tabs.find((v) => v.id === tabId);
      if (!tab || !tab.output) return;

      if (typeof text !== "string") text = String(text || "");

      const MAX_CHUNK_SIZE = 500 * 1024;
      if (text.length > MAX_CHUNK_SIZE) {
        text = text.substring(0, MAX_CHUNK_SIZE) + "\n[Output truncated...]";
      }

      const normalizedText = text
        .replace(/\r\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n");

      let html;
      try {
        html = convert.toHtml(normalizedText);
      } catch {
        html = normalizedText
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/\n/g, "<br>");
      }

      const temp = document.createElement("div");
      temp.innerHTML = html;

      const frag = document.createDocumentFragment();
      for (;;) {
        const n = temp.firstChild;
        if (!n) break;
        frag.appendChild(n);
      }

      tab.output.appendChild(frag);

      const c = (this._scrollCounter = (this._scrollCounter || 0) + 1);
      if (c % 5 === 0) tab.output.scrollTop = tab.output.scrollHeight;
    } catch {}
  }

  printLine(tabId, text, className = "") {
    try {
      const tab = this.tabs.find((t) => t.id === tabId);
      if (!tab) {
        console.warn(`[DEBUG-RENDERER] Tab not found for printLine: ${tabId}`);
        return;
      }

      if (!tab.output) {
        console.error(
          `[DEBUG-RENDERER] Tab output element not found: ${tabId}`
        );
        return;
      }

      if (typeof text !== "string") {
        text = String(text || "");
      }

      let cleanedText = text;
      cleanedText = cleanedText.replace(/\n{3,}/g, "\n");
      cleanedText = cleanedText.replace(/^\n+|\n+$/g, "");

      let html;
      try {
        html = convert.toHtml(cleanedText);
      } catch (convertError) {
        console.error(
          `[DEBUG-RENDERER] Error converting ANSI in printLine:`,
          convertError
        );

        html = cleanedText
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/\n/g, "<br>")
          .replace(/\r/g, "");
      }

      const line = document.createElement("div");
      line.className = `output-line ${className} fade-in`;
      try {
        line.innerHTML = html;
      } catch (innerHTMLError) {
        console.error(
          `[DEBUG-RENDERER] Error setting innerHTML:`,
          innerHTMLError
        );
        line.textContent = text;
      }

      tab.output.appendChild(line);

      try {
        tab.output.scrollTop = tab.output.scrollHeight;
      } catch (scrollError) {
        console.error(
          `[DEBUG-RENDERER] Error scrolling in printLine:`,
          scrollError
        );
      }
    } catch (error) {
      console.error(
        `[DEBUG-RENDERER] ========== ERROR in printLine ==========`
      );
      console.error(`[DEBUG-RENDERER] Error:`, error);
      console.error(
        `[DEBUG-RENDERER] tabId: ${tabId}, text: ${text?.substring(
          0,
          100
        )}, className: ${className}`
      );
      console.error(
        `[DEBUG-RENDERER] =========================================`
      );
    }
  }

  async loadMacros() {
    this.macros = await ipcRenderer.invoke("load-macros");
  }

  async saveMacro(name, commands) {
    await ipcRenderer.invoke("save-macro", { name, commands });
    this.macros[name] = commands;
  }

  async deleteMacro(name) {
    await ipcRenderer.invoke("delete-macro", name);
    delete this.macros[name];
  }

  async updatePrompt(tabId) {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return;

    try {
      const cwd = await ipcRenderer.invoke("get-cwd", tab.sessionId);
      this.updatePromptFromCwd(tabId, cwd);
    } catch (error) {}
  }

  updatePromptFromCwd(tabId, cwd) {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return;

    const prompt = tab.panel.querySelector(".prompt");

    prompt.innerHTML = `<span>${cwd}&gt;</span>`;
  }

  async executeCommand(tabId, command) {
    console.log(
      `[DEBUG-RENDERER] executeCommand called - tabId: ${tabId}, command: "${command}"`
    );
    if (!command.trim()) {
      console.log(`[DEBUG-RENDERER] Empty command, returning`);
      return;
    }

    if (this.awaitingSSHPassword) {
      const password = command.trim();
      const sshInfo = this.awaitingSSHCommand;

      this.printLine(
        tabId,
        `Connecting via SSH to ${sshInfo.username}@${sshInfo.host}...`,
        "info"
      );

      try {
        const result = await ipcRenderer.invoke("ssh-connect", {
          sessionId: this.tabs.find((t) => t.id === tabId)?.sessionId,
          tabId: tabId,
          host: sshInfo.host,
          username: sshInfo.username,
          password: password,
          port: sshInfo.port || 22,
        });

        if (result && result.success) {
          this.printLine(
            tabId,
            `Connected to ${sshInfo.username}@${sshInfo.host}`,
            "success"
          );
          this.updatePrompt(tabId);
        }
      } catch (err) {
        console.error("SSH connection error:", err);
        this.printLine(
          tabId,
          `SSH error: ${err.message || err.toString()}`,
          "error"
        );
      } finally {
        this.awaitingSSHPassword = false;
        this.awaitingSSHCommand = null;
      }
      return;
    }

    if (this.awaitingConfirmation) {
      const response = command.trim().toLowerCase();
      if (response === "y" || response === "yes") {
        const macroName = this.awaitingConfirmation;
        await this.deleteMacro(macroName);
        this.printLine(
          tabId,
          `Macro '${macroName}' deleted successfully.`,
          "success"
        );
      } else {
        this.printLine(tabId, "Deletion cancelled.", "warning");
      }
      this.awaitingConfirmation = null;
      return;
    }

    this.commandHistory.push(command);
    this.historyIndex = this.commandHistory.length;

    const tab = this.tabs.find((v) => v.id === tabId);
    const isSSH = tab && tab.sessionId;

    if (!isSSH) {
      this.printLine(tabId, `> ${command}`, "command");
    }

    if (!tab) return;

    if (command.trim().startsWith("flash")) {
      await this.handleFlashCommand(tabId, command.trim());
      return;
    }

    if (command.trim() === "clear" || command.trim() === "cls") {
      tab.output.innerHTML = "";
      return;
    }

    if (command.trim() === "exit") {
      const session = this.tabs.find((t) => t.id === tabId);
      if (session) {
        try {
          await ipcRenderer.invoke("ssh-disconnect", session.sessionId);
        } catch (e) {}
      }
      this.closeTab(tabId);
      return;
    }

    if (command.trim() === "help") {
      this.showHelp(tabId);
      return;
    }

    if (command.trim() === "macros" || command.trim() === "flash macros") {
      this.listMacros(tabId);
      return;
    }

    if (command.trim() === "history") {
      this.showHistory(tabId);
      return;
    }

    if (command.trim().startsWith("ssh ")) {
      const sshMatch = command
        .trim()
        .match(/^ssh\s+([^\s@]+)@([^\s:]+)(?::(\d+))?(?:\s+(.+))?$/);
      if (sshMatch) {
        const [, username, host, port, remoteCommand] = sshMatch;
        this.awaitingSSHCommand = {
          username,
          host,
          port: port ? parseInt(port) : 22,
        };
        this.awaitingSSHPassword = true;
        this.printLine(
          tabId,
          `Enter password for ${username}@${host}:`,
          "confirmation-prompt"
        );
        return;
      } else {
        this.printLine(tabId, "Usage: ssh user@host [port] [command]", "error");
        this.printLine(tabId, "Example: ssh root@192.168.1.1", "info");
        this.printLine(tabId, "Example: ssh user@example.com:2222", "info");
        return;
      }
    }

    await this.executeCommandLive(tabId, command);
  }

  async executeCommandLive(tabId, command) {
    console.log(
      `[DEBUG-RENDERER] ========== executeCommandLive START ==========`
    );
    console.log(`[DEBUG-RENDERER] tabId: ${tabId}, command: "${command}"`);

    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) {
      console.error(`[DEBUG-RENDERER] Tab not found: ${tabId}`);
      return;
    }

    console.log(`[DEBUG-RENDERER] Tab found - sessionId: ${tab.sessionId}`);

    try {
      console.log(`[DEBUG-RENDERER] Invoking execute-command-live IPC...`);

      const result = await ipcRenderer.invoke("execute-command-live", {
        command,
        sessionId: tab.sessionId,
        tabId: tabId,
      });

      console.log(`[DEBUG-RENDERER] IPC result received:`, result);

      if (result && !result.success) {
        console.error(`[DEBUG-RENDERER] Command failed: ${result.error}`);
        this.printLine(
          tabId,
          `Error: ${result.error || "Command failed"}`,
          "error"
        );
      } else {
        console.log(`[DEBUG-RENDERER] Command executed successfully`);
      }

      setTimeout(() => this.updatePrompt(tabId), 200);
      console.log(
        `[DEBUG-RENDERER] ========== executeCommandLive END ==========`
      );
    } catch (error) {
      console.error(
        `[DEBUG-RENDERER] ========== ERROR in executeCommandLive ==========`
      );
      console.error(`[DEBUG-RENDERER] Error:`, error);
      console.error(`[DEBUG-RENDERER] Error type: ${error.constructor.name}`);
      console.error(`[DEBUG-RENDERER] Error message: ${error.message}`);
      console.error(`[DEBUG-RENDERER] Error stack:`, error.stack);
      this.printLine(
        tabId,
        `Error: ${error.message || "Unknown error"}`,
        "error"
      );
      console.error(
        `[DEBUG-RENDERER] ===============================================`
      );
    }
  }

  async handleFlashCommand(tabId, command) {
    const parts = command.split(" ").filter((p) => p);

    if (parts.length < 2) {
      this.printLine(tabId, "Usage: flash <subcommand> [args]", "error");
      return;
    }

    const subcommand = parts[1];

    if (subcommand === "macro") {
      await this.handleMacroCommand(tabId, command);
      return;
    }

    this.printLine(tabId, `Unknown flash command: ${subcommand}`, "error");
  }

  async handleMacroCommand(tabId, command) {
    const parts = command.split(" ").filter((p) => p);

    if (parts.length < 3) {
      this.printLine(tabId, "Usage:", "warning");
      this.printLine(tabId, "  flash macro create <name> <number>", "info");
      this.printLine(tabId, "  flash macro list", "info");
      this.printLine(tabId, "  flash macro <name>", "info");
      this.printLine(tabId, "  flash macro delete <name>", "info");
      return;
    }

    const action = parts[2];

    if (action === "list") {
      this.listMacrosDetailed(tabId);
      return;
    }

    if (action === "create") {
      if (parts.length < 5) {
        this.printLine(
          tabId,
          "Usage: flash macro create <name> <number>",
          "error"
        );
        this.printLine(tabId, "Example: flash macro create deploy 5", "info");
        return;
      }

      const macroName = parts[3];
      const count = parseInt(parts[4]);

      if (isNaN(count) || count < 1) {
        this.printLine(
          tabId,
          "Error: Number must be a positive integer.",
          "error"
        );
        return;
      }

      if (count > this.commandHistory.length) {
        this.printLine(
          tabId,
          `Error: Only ${this.commandHistory.length} commands in history.`,
          "error"
        );
        return;
      }

      const commands = this.commandHistory.slice(-count);
      await this.saveMacro(macroName, commands);

      this.printLine(tabId, "", "");
      this.printLine(
        tabId,
        `Macro '${macroName}' created with ${count} commands:`,
        "success"
      );
      commands.forEach((cmd, i) => {
        this.printLine(tabId, `  ${i + 1}. ${cmd}`, "info");
      });
      this.printLine(tabId, "", "");
      this.printLine(tabId, `Run with: flash macro ${macroName}`, "accent");
    } else if (action === "delete") {
      if (parts.length < 4) {
        this.printLine(tabId, "Usage: flash macro delete <name>", "error");
        return;
      }

      const macroName = parts[3];

      if (!this.macros[macroName]) {
        this.printLine(tabId, `Macro '${macroName}' not found.`, "error");
        return;
      }

      this.printLine(
        tabId,
        `Delete macro '${macroName}'? (y/n)`,
        "confirmation-prompt"
      );
      this.awaitingConfirmation = macroName;
    } else {
      const macroName = action;

      if (!this.macros[macroName]) {
        this.printLine(tabId, `Macro '${macroName}' not found.`, "error");
        this.printLine(
          tabId,
          `Use 'flash macro list' to see available macros.`,
          "info"
        );
        return;
      }

      this.printLine(tabId, "", "");
      this.printLine(
        tabId,
        `Executing macro '${macroName}'...`,
        "macro-indicator"
      );
      this.printLine(tabId, "━".repeat(60), "secondary");

      for (const cmd of this.macros[macroName]) {
        this.printLine(tabId, `> ${cmd}`, "command");
        await this.executeCommandLive(tabId, cmd);
        await this.delay(300);
      }

      this.printLine(tabId, "━".repeat(60), "secondary");
      this.printLine(tabId, `Macro '${macroName}' completed.`, "success");
      this.printLine(tabId, "", "");
    }
  }

  listMacrosDetailed(tabId) {
    const macroNames = Object.keys(this.macros);

    if (macroNames.length === 0) {
      this.printLine(tabId, "", "");
      this.printLine(tabId, "No macros saved yet.", "warning");
      this.printLine(tabId, "", "");
      this.printLine(
        tabId,
        "Create one with: flash macro create <name> <number>",
        "info"
      );
      this.printLine(tabId, "", "");
      return;
    }

    this.printLine(tabId, "", "");
    this.printLine(tabId, "SAVED MACROS", "accent");
    this.printLine(tabId, "━".repeat(60), "secondary");

    macroNames.forEach((name) => {
      const commands = this.macros[name];
      this.printLine(tabId, "", "");
      this.printLine(
        tabId,
        `${name} (${commands.length} commands)`,
        "macro-indicator"
      );
      commands.forEach((cmd, i) => {
        this.printLine(tabId, `  ${i + 1}. ${cmd}`, "info");
      });
    });

    this.printLine(tabId, "", "");
    this.printLine(tabId, "━".repeat(60), "secondary");
    this.printLine(tabId, "", "");
  }

  listMacros(tabId) {
    const macroNames = Object.keys(this.macros);

    if (macroNames.length === 0) {
      this.printLine(tabId, "", "");
      this.printLine(tabId, "No macros saved yet.", "warning");
      this.printLine(tabId, "", "");
      this.printLine(
        tabId,
        "Create one with: flash macro create <name> <number>",
        "info"
      );
      this.printLine(tabId, "", "");
      return;
    }

    this.printLine(tabId, "", "");
    this.printLine(tabId, "SAVED MACROS", "accent");
    this.printLine(tabId, "━".repeat(60), "secondary");

    macroNames.forEach((name) => {
      const commands = this.macros[name];
      this.printLine(
        tabId,
        `  ${name} (${commands.length} commands)`,
        "macro-indicator"
      );
    });

    this.printLine(tabId, "", "");
    this.printLine(tabId, `Use 'flash macro list' for detailed view`, "info");
    this.printLine(tabId, "━".repeat(60), "secondary");
    this.printLine(tabId, "", "");
  }

  showHistory(tabId) {
    if (this.commandHistory.length === 0) {
      this.printLine(tabId, "No command history yet.", "warning");
      return;
    }

    this.printLine(tabId, "", "");
    this.printLine(tabId, "COMMAND HISTORY", "accent");
    this.printLine(tabId, "━".repeat(60), "secondary");

    const recentCommands = this.commandHistory.slice(-20);
    recentCommands.forEach((cmd, i) => {
      const index = this.commandHistory.length - recentCommands.length + i + 1;
      this.printLine(tabId, `${index}. ${cmd}`, "info");
    });

    this.printLine(tabId, "━".repeat(60), "secondary");
    this.printLine(tabId, "", "");
  }

  showHelp(tabId) {
    this.printLine(tabId, "");
    this.printLine(tabId, "FLASH TERMINAL v0.0.2 - LIVE EDITION", "accent");
    this.printLine(tabId, "━".repeat(60), "secondary");
    this.printLine(tabId, "");
    this.printLine(tabId, "FEATURES:", "accent");
    this.printLine(tabId, "  Flash Packages", "success");
    this.printLine(tabId, "");
    this.printLine(tabId, "SSH COMMANDS:", "accent");
    this.printLine(
      tabId,
      "  ssh user@host              - Connect via SSH",
      "info"
    );
    this.printLine(
      tabId,
      "  ssh user@host:port         - Connect with custom port",
      "info"
    );
    this.printLine(
      tabId,
      "  exit                       - Disconnect SSH / Close tab",
      "info"
    );
    this.printLine(tabId, "");
    this.printLine(tabId, "MACRO COMMANDS:", "accent");
    this.printLine(
      tabId,
      "  flash macro create <name> <number> - Create macro from last N commands",
      "info"
    );
    this.printLine(
      tabId,
      "  flash macro list                   - List all macros with commands",
      "info"
    );
    this.printLine(
      tabId,
      "  flash macro <name>                 - Execute saved macro",
      "info"
    );
    this.printLine(
      tabId,
      "  flash macro delete <name>          - Delete a macro",
      "info"
    );
    this.printLine(
      tabId,
      "  macros                             - Quick list of macros",
      "info"
    );
    this.printLine(tabId, "");

    this.printLine(tabId, "");
    this.printLine(tabId, "SYSTEM COMMANDS:", "accent");
    this.printLine(
      tabId,
      "  File: dir, ls, mkdir, del, copy, move, type",
      "info"
    );
    this.printLine(tabId, "  Network: ping, ipconfig, netstat, curl", "info");
    this.printLine(tabId, "  Dev: python, node, npm, git, pip", "info");
    this.printLine(tabId, "  System: tasklist, systeminfo, echo", "info");
    this.printLine(tabId, "");
    this.printLine(tabId, "TERMINAL COMMANDS:", "accent");
    this.printLine(tabId, "  clear / cls    - Clear screen", "info");
    this.printLine(tabId, "  history        - Show command history", "info");
    this.printLine(tabId, "  help           - Show this help", "info");
    this.printLine(tabId, "  exit           - Close current tab", "info");
    this.printLine(tabId, "");
    this.printLine(tabId, "SHORTCUTS:", "accent");
    this.printLine(
      tabId,
      "  Ctrl+T - New tab    |  Ctrl+W - Close tab",
      "info"
    );
    this.printLine(tabId, "  Ctrl+L - Clear      |  Up/Down - History", "info");
    this.printLine(tabId, "");
  }

  async showStartupAnimation() {
    if (this.tabs.length === 0) return;

    const tabId = this.tabs[0].id;

    await this.delay(100);
    this.printLine(tabId, "Flash Terminal v0.0.2", "accent");
    await this.delay(150);
    this.printLine(tabId, "━".repeat(60), "secondary");
    await this.delay(150);
    this.printLine(tabId, "Flash Terminal : https://github.com/FMFAU/Flash-Terminal", "accent");
    this.printLine(tabId, "Created by DIZZY | d.i.z.z_y | @FMFAU", "error");
    this.printLine(tabId, "Terminal_Ready()", "success");
    await this.delay(200);
    this.printLine(tabId, "", "");
    this.printLine(tabId, "Type 'help' for available commands", "warning");
    this.printLine(tabId, "Try: ssh user@host", "info");
    this.printLine(tabId, "━".repeat(60), "secondary");
    this.printLine(tabId, "", "");
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
      input.value = "";
    }
  }

  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  changeTabColor(tabId) {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return;

    const colors = [
      { name: "Yellow", value: "#ffc107" },
      { name: "Blue", value: "#2196f3" },
      { name: "Green", value: "#4caf50" },
      { name: "Red", value: "#f44336" },
      { name: "Purple", value: "#9c27b0" },
      { name: "Orange", value: "#ff9800" },
      { name: "Cyan", value: "#00bcd4" },
      { name: "Default", value: "#ffc107" },
    ];

    const currentColor = tab.button.dataset.tabColor || "#ffc107";
    const currentIndex = colors.findIndex((c) => c.value === currentColor);
    const nextIndex = (currentIndex + 1) % colors.length;
    const nextColor = colors[nextIndex];

    tab.button.dataset.tabColor = nextColor.value;
    tab.button.style.borderTopColor = nextColor.value;
    if (tab.button.classList.contains("active")) {
      const afterElement = tab.button.querySelector("::after") || tab.button;
      tab.button.style.setProperty("--accent-primary", nextColor.value);
    }

    this.printLine(tabId, `Tab color changed to ${nextColor.name}`, "info");
  }

  splitTab(tabId) {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return;

    this.createTab(tab.name + " (Split)");
    const newTab = this.tabs[this.tabs.length - 1];

    if (newTab && tab.output) {
      newTab.output.innerHTML = tab.output.innerHTML;
      this.printLine(newTab.id, "[Split tab created]", "info");
    }
  }

  exportTabText(tabId) {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab || !tab.output) return;

    const text = tab.output.innerText || tab.output.textContent;
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `terminal-export-${tabId}-${Date.now()}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    this.printLine(tabId, "Terminal output exported", "success");
  }

  findInTab(tabId) {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return;

    const searchTerm = prompt("Enter search term:");
    if (!searchTerm) return;

    const text = tab.output.innerText || tab.output.textContent;
    const regex = new RegExp(searchTerm, "gi");
    const matches = text.match(regex);

    if (matches) {
      this.printLine(
        tabId,
        `Found ${matches.length} occurrence(s) of "${searchTerm}"`,
        "info"
      );

      const content = tab.output.innerHTML;
      const highlighted = content.replace(
        new RegExp(`(${searchTerm})`, "gi"),
        '<mark style="background: var(--accent-primary); color: var(--bg-primary);">$1</mark>'
      );
      tab.output.innerHTML = highlighted;
    } else {
      this.printLine(tabId, `No matches found for "${searchTerm}"`, "warning");
    }
  }

  closeOtherTabs(tabId) {
    const tabsToClose = this.tabs.filter((t) => t.id !== tabId);
    tabsToClose.forEach((tab) => {
      this.closeTab(tab.id);
    });
    this.printLine(tabId, `Closed ${tabsToClose.length} other tab(s)`, "info");
  }
}

window.addEventListener("error", (event) => {
  console.error(`[DEBUG-RENDERER] ========== GLOBAL ERROR ==========`);
  console.error(`[DEBUG-RENDERER] Error:`, event.error);
  console.error(`[DEBUG-RENDERER] Message: ${event.message}`);
  console.error(`[DEBUG-RENDERER] Filename: ${event.filename}`);
  console.error(`[DEBUG-RENDERER] Line: ${event.lineno}, Col: ${event.colno}`);
  console.error(`[DEBUG-RENDERER] ===================================`);
});

window.addEventListener("unhandledrejection", (event) => {
  console.error(`[DEBUG-RENDERER] ========== UNHANDLED REJECTION ==========`);
  console.error(`[DEBUG-RENDERER] Reason:`, event.reason);
  console.error(`[DEBUG-RENDERER] ==========================================`);
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    try {
      const terminal = new FlashTerminal();
      window.terminal = terminal;
    } catch (error) {
      console.error("[DEBUG-RENDERER] Failed to initialize terminal:", error);
      console.error("[DEBUG-RENDERER] Error stack:", error.stack);
      document.body.innerHTML = `
        <div style="padding: 20px; color: #ff4444; font-family: monospace;">
          <h2>Terminal Initialization Error</h2>
          <pre>${error.stack || error.message}</pre>
        </div>
      `;
    }
  });
} else {
  try {
    const terminal = new FlashTerminal();
    window.terminal = terminal;
  } catch (error) {
    console.error("[DEBUG-RENDERER] Failed to initialize terminal:", error);
    console.error("[DEBUG-RENDERER] Error stack:", error.stack);
    document.body.innerHTML = `
      <div style="padding: 20px; color: #ff4444; font-family: monospace;">
        <h2>Terminal Initialization Error</h2>
        <pre>${error.stack || error.message}</pre>
      </div>
    `;
  }
}
