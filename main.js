const { launch } = require("puppeteer-stream");
const puppeteerCore = require('puppeteer-core');
const { download } = require("./recorder");

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execSync } = require("child_process");
const open = require("open");

/**
 * CONFIGURATION & CONSTANTS
 */
const CURRENT_VERSION = "1.1.0";
const GITHUB_REPO = "Intenzi/ShowdownReplayDownloader";
const APP_PORT = process.env.PORT || 57335;

/**
 * RESOLVE EXECUTABLE PATHS
 */
function getChromiumPath() {
  const appDir = path.dirname(process.execPath);

  // Search in multiple locations to support portable layouts
  const possibleBases = [
    path.join(appDir, "chromium"),
    path.join(appDir, "resources", "chromium"),
    path.join(appDir, "app", "chromium"),
    path.join(process.cwd(), "chromium"),
  ];

  const base = possibleBases.find((p) => fs.existsSync(p)) || possibleBases[0];

  if (!fs.existsSync(base)) {
    return null;
  }

  console.log(`[System] Chromium folder found: ${base}`);

  if (os.platform() === "win32") {
    const winPath = path.join(base, "chrome.exe");
    if (fs.existsSync(winPath)) return winPath;
    const alternateWinPath = path.join(base, "Chromium.exe");
    if (fs.existsSync(alternateWinPath)) return alternateWinPath;
  }

  if (os.platform() === "darwin") {
    try {
      const apps = fs.readdirSync(base).filter((f) => f.endsWith(".app"));
      const appName = apps[0];
      if (appName) {
        const contentsDir = path.join(base, appName, "Contents", "MacOS");
        if (fs.existsSync(contentsDir)) {
          const binaries = fs
            .readdirSync(contentsDir)
            .filter((f) => !f.startsWith("."));
          if (binaries.length > 0) {
            const res = path.join(contentsDir, binaries[0]);
            console.log(`[System] Resolved macOS browser binary: ${res}`);
            return res;
          }
        }
        // Fallback to name-based replacement if exploration fails
        const res = path.join(
          base,
          appName,
          "Contents",
          "MacOS",
          appName.replace(".app", ""),
        );
        if (fs.existsSync(res)) return res;
      }
    } catch (err) {
      console.warn(
        `[System] Error during macOS browser search: ${err.message}`,
      );
    }
  }

  const linuxPath = path.join(base, "chrome");
  if (fs.existsSync(linuxPath)) return linuxPath;

  return null;
}

const bundledExecutablePath = getChromiumPath();

// Ensure executable permissions on Unix-like systems
if (os.platform() !== "win32" && bundledExecutablePath) {
  try {
    fs.chmodSync(bundledExecutablePath, 0o755);
  } catch (err) {
    console.warn(
      `[System] Warning: Could not set permissions on Chromium: ${err.message}`,
    );
  }
}

/**
 * CONFIGURATION PERSISTENCE
 */
function getConfigDir() {
  const appName = "ShowdownReplayStudio";
  let baseDir;

  if (process.platform === "win32") {
    baseDir =
      process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  } else if (process.platform === "darwin") {
    baseDir = path.join(os.homedir(), "Library", "Application Support");
  } else {
    baseDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  }

  const finalDir = path.join(baseDir, appName);
  if (!fs.existsSync(finalDir)) {
    fs.mkdirSync(finalDir, { recursive: true });
  }
  return finalDir;
}

const CONFIG_DIR = getConfigDir();
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const DEFAULT_CONFIG = {
  outputFolder: path.join(os.homedir(), "showdown-replays"),
  nochat: true,
  nomusic: false,
  noaudio: false,
  theme: "auto",
  speed: "normal",
  bulk: 1,
};

let config = loadConfig();

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
      const loaded = { ...DEFAULT_CONFIG, ...saved };
      loaded.bulk = Math.min(3, Math.max(1, parseInt(loaded.bulk) || 1));
      return loaded;
    }
  } catch (err) {
    console.error("[Config] Failed to parse config.json, using defaults.");
  }
  return DEFAULT_CONFIG;
}

function saveConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch (err) {
    console.error(`[Config] Failed to save configuration: ${err.message}`);
  }
}

async function waitForServiceWorker(browser, extensionId, timeout = 30000) {
    const exists = browser
        .targets()
        .some(
            (t) =>
                t.type() === 'service_worker' &&
                t.url().startsWith(`chrome-extension://${extensionId}/`),
        );

    if (exists) return;

    await browser.waitForTarget(
        (t) =>
            t.type() === 'service_worker' &&
            t.url().startsWith(`chrome-extension://${extensionId}/`),
        { timeout },
    );
}

/**
 * BROWSER MANAGEMENT
 */
const pools = {
  nochat: Array.from({ length: 3 }, (_, i) => ({ id: i, browser: null, launchPromise: null, warmPromise: null, inUse: false })),
  chat: Array.from({ length: 3 }, (_, i) => ({ id: i, browser: null, launchPromise: null, warmPromise: null, inUse: false }))
};

async function launchOptimizedBrowser(width, height) {
  let launchPath = bundledExecutablePath;

  if (!launchPath || !fs.existsSync(launchPath)) {
    const puppeteerPath = require("puppeteer").executablePath();
    if (fs.existsSync(puppeteerPath)) {
      launchPath = puppeteerPath;
    } else {
      // System fallback for development environments where puppeteer download might have failed
      if (os.platform() === "win32") {
        const paths = [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          path.join(
            os.homedir(),
            "AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
          ),
          "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        ];
        launchPath = paths.find((p) => fs.existsSync(p)) || puppeteerPath;
      } else if (os.platform() === "darwin") {
        const paths = [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ];
        launchPath = paths.find((p) => fs.existsSync(p)) || puppeteerPath;
      } else {
        launchPath = puppeteerPath;
      }
    }
  }

  // Resolve extension path for bundled app vs development
  const appDir = path.dirname(process.execPath);
  const possibleExtensionPaths = [
    path.join(appDir, "extension"),
    path.join(appDir, "resources", "extension"),
    path.join(appDir, "app", "extension"),
    path.join(process.cwd(), "node_modules", "puppeteer-stream", "extension"),
  ];

  let extensionPath =
    possibleExtensionPaths.find((p) => fs.existsSync(p)) ||
    possibleExtensionPaths[0];

  function findExtensionPaths(parentDir) {
    if (!fs.existsSync(parentDir)) return [];
    const paths = [];
    try {
      const files = fs.readdirSync(parentDir);
      for (const file of files) {
        const fullPath = path.join(parentDir, file);
        if (fs.statSync(fullPath).isDirectory()) {
          if (fs.existsSync(path.join(fullPath, "manifest.json"))) {
            paths.push(fullPath);
          }
        }
      }
    } catch (e) {}
    return paths;
  }

  const possibleUblockParentDirs = [
    path.join(appDir, "extensions"),
    path.join(appDir, "resources", "extensions"),
    path.join(appDir, "app", "extensions"),
    path.join(process.cwd(), "extensions"),
  ];

  const enableExtensions = [];
  for (const parentDir of possibleUblockParentDirs) {
    const paths = findExtensionPaths(parentDir);
    if (paths.length > 0) {
      console.log(`[System] Loading custom extensions:`, paths);
      for (const p of paths) {
        const metaDir = path.join(p, "_metadata");
        if (fs.existsSync(metaDir)) {
          try {
            fs.rmSync(metaDir, { recursive: true, force: true });
          } catch (err) {
              console.log(`[System] Failed to remove _metadata: ${err.code} ${err.message}`);
          }
        }
      }
      enableExtensions.push(...paths);
      break;
    }
  }

  /**
   * Note: We temporarily override path.join because puppeteer-stream
   * has a hardcoded relative path to its internal extension.
   */
  const originalJoin = path.join;
  path.join = (...args) => {
    const res = originalJoin(...args);
    if (res.includes("puppeteer-stream") && res.endsWith("extension"))
      return extensionPath;
    return res;
  };

  try {
      /**
       * DO NOT TOUCH
       *
       * This is NOT an unnecessary wrapper.
       *
       * Removing it reintroduces a Chromium/extension startup race that causes
       * puppeteer-stream to fail with:
       *
       *   net::ERR_BLOCKED_BY_CLIENT
       *
       * It took several hours of debugging to isolate. If you think this can be
       * removed, reproduce the issue with uBlock Origin Lite enabled first.
       */
      const customPuppeteer = {
          ...puppeteerCore,

          launch: async (...args) => {
              const browser = await puppeteerCore.launch(...args);
              try {
                  await waitForServiceWorker(
                      browser,
                      'jjndjgheafjngoipoacpjgeicjeomjli',
                  );
              } catch (err) {
                  try {
                      await browser.close();
                  } catch (closeErr) {}
                  throw err;
              }

              return browser;
          },
      };

      const browser = await launch(customPuppeteer, {
          executablePath: launchPath,
          enableExtensions,
          ignoreDefaultArgs: ['--enable-automation'],
          args: [
              `--window-size=${width},${height}`,
              `--allowlisted-extension-id=jjndjgheafjngoipoacpjgeicjeomjli`,
              `--headless=new`,
              `--force-device-scale-factor=1`,
              `--hide-scrollbars`,
              `--disable-notifications`,
              `--disable-infobars`,
          ],
      });

      return browser;
  } finally {
    path.join = originalJoin;
  }
}

let isSystemWarming = true;
let idleTimeoutId = null;

function stopIdleTimeout() {
  if (idleTimeoutId) {
    clearTimeout(idleTimeoutId);
    idleTimeoutId = null;
  }
}

function startIdleTimeout() {
  stopIdleTimeout();

  if (activeRecordings === 0 && globalQueue.length === 0) {
    idleTimeoutId = setTimeout(async () => {
      console.log("[System] Idle for 30 minutes. Shutting down browser pool to release resources...");
      for (const type of ["nochat", "chat"]) {
        for (const item of pools[type]) {
          if (item.browser) {
            try {
              await item.browser.close();
              console.log(`[Browser] Closed ${type} [${item.id}]`);
            } catch (err) {
              console.error(`[System] Error closing browser ${type} [${item.id}]: ${err.message}`);
            }
          }
          item.browser = null;
          item.launchPromise = null;
          item.inUse = false;
        }
      }
      console.log("[System] Browser pool cleared.");
    }, 30 * 60 * 1000);  // 30 minutes
  }
}

function prelaunchBrowser(type, index, shouldWarm = true) {
  const item = pools[type][index];
  if (item.launchPromise) {
    return item.launchPromise;
  }
  const width = type === "nochat" ? 642 : 1100;
  item.launchPromise = launchOptimizedBrowser(width, 450)
    .then(async (b) => {
      item.browser = b;

      if (shouldWarm) {
        console.log(`[Browser] Background warming started for ${type} [${index}]...`);
        item.warmPromise = (async () => {
          let page = null;
          try {
            page = await b.newPage();
            await page.goto("https://replay.pokemonshowdown.com/", {
              waitUntil: "networkidle2",
              timeout: 20000,
            });
            await new Promise((resolve) => setTimeout(resolve, 3000));
            console.log(`[Browser] Cache warmed successfully in background for ${type} [${index}]!`);
          } catch (err) {
            console.warn(`[Browser] Background cache warming completed with warnings/timeout for ${type} [${index}]: ${err.message}`);
          } finally {
            if (page) {
              try {
                await page.close();
              } catch {}
            }
          }
        })();
      } else {
        console.log(`[Browser] Launched on-demand instance ${type} [${index}] (no cache warming).`);
        item.warmPromise = Promise.resolve();
      }

      return b;
    })
    .catch((err) => {
      console.error(`[Error] Failed to pre-launch ${type} [${index}] browser: ${err.message}`);
      item.launchPromise = null;
      throw err;
    });
  return item.launchPromise;
}

async function getBrowser(type, index, shouldWarm = true) {
  const item = pools[type][index];
  if (item.browser && item.browser.isConnected()) {
    return item.browser;
  }
  if (item.launchPromise) {
    try {
      const b = await item.launchPromise;
      if (b && b.isConnected()) {
        return b;
      }
    } catch (err) {
      // Ignore and retry
    }
  }
  return prelaunchBrowser(type, index, shouldWarm);
}


/**
 * QUEUE SYSTEM
 */
let globalQueue = [];
let concurrentCount = 0;
let activeRecordings = 0;
const controllers = new Map();

async function triggerNext() {
  const maxConcurrency = Math.min(3, parseInt(config.bulk) || 1);

  // Use a while loop to fill up all available slots immediately
  while (concurrentCount < maxConcurrency && globalQueue.length > 0) {
    const type = config.nochat ? "nochat" : "chat";
    const poolItem = pools[type].find((item) => !item.inUse);
    if (!poolItem) {
      break;
    }

    const rec = globalQueue.shift();
    concurrentCount++;
    activeRecordings++;
    poolItem.inUse = true;

    stopIdleTimeout();

    io.emit("status", { ready: true, recording: true });

    const emitLog = (msg, type = "info") => io.emit("log", { msg, type });
    const emitProgress = (id, link, state, meta = {}) =>
      io.emit("progress", { id, link, state, ...meta });

    emitProgress(rec.id, rec.link, "starting");

    (async () => {
      try {
        emitLog(`[Browser] Ensuring ${type} instance [${poolItem.id}] is ready...`, "info");
        // Created anew / on-demand inside queue run won't have cache warmup done.
        const browserInstance = await getBrowser(type, poolItem.id, false);

        const ctrl = new AbortController();
        controllers.set(rec.id, ctrl);

        await download(
          rec.link,
          rec.id,
          browserInstance,
          config,
          emitLog,
          emitProgress,
          ctrl.signal,
        );
      } catch (err) {
        emitLog(`[Error] ${err.message}`, "error");
      } finally {
        controllers.delete(rec.id);
        poolItem.inUse = false;
        concurrentCount--;
        activeRecordings--;
        io.emit("status", { ready: true, recording: activeRecordings > 0 });

        if (activeRecordings === 0 && globalQueue.length === 0) {
          emitLog("🏁 All queued processes complete!", "success");
        }
        startIdleTimeout();
        triggerNext();
      }
    })(); // End of async IIFE
  } // End of while loop
}

/**
 * EXPRESS & SOCKET.IO SETUP
 */
function generateFileId() {
  return Math.random().toString(36).substring(2, 11);
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// Serve recorded videos dynamically from the current configuration folder
app.use("/videos", (req, res) => {
  const filePath = path.join(config.outputFolder, decodeURIComponent(req.path));
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send("Video not found");
  }
});

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// API: Configuration
app.get("/api/config", (req, res) => res.json(config));

app.post("/api/config", (req, res) => {
  config = { ...config, ...req.body };
  config.bulk = Math.min(3, Math.max(1, parseInt(config.bulk) || 1));
  saveConfig(config);
  // Real-time bulk limit application
  triggerNext();
  res.json({ success: true, config });
});

// Version API
app.get("/api/version", async (req, res) => {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
    );
    const data = await response.json();
    const update =
      data.tag_name !== `v${CURRENT_VERSION}` ? data.tag_name : null;
    res.json({ current: CURRENT_VERSION, update });
  } catch {
    res.json({ current: CURRENT_VERSION, update: null });
  }
});

// Status API
app.get("/api/status", (req, res) => {
  const isReady = fs.existsSync(CONFIG_PATH);
  res.json({ ready: isReady, warming: isSystemWarming, recording: activeRecordings > 0 });
});

// Directory Browser / Folder Picker
const pickFolderHandler = async (req, res) => {
  const { execFile } = require("child_process");
  const platform = os.platform();

  try {
    if (platform === "darwin") {
      const script = `
        try
          set selectedFolder to (choose folder with prompt "Select Output Folder")
          POSIX path of selectedFolder
        on error errMsg number errNum
          if errNum is -128 then
            "CANCELLED"
          else
            error errMsg number errNum
          end if
        end try
      `;
      execFile("osascript", ["-e", script], (err, stdout) => {
        if (err) return res.json({ success: false });
        const output = stdout?.trim();
        if (output === "CANCELLED") {
          return res.json({ success: false, cancelled: true });
        }
        if (!output) return res.json({ success: false });

        config.outputFolder = output;
        saveConfig(config);
        res.json({ success: true, folder: output, path: output });
      });

    } else if (platform === "win32") {
      execFile(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-STA",
          "-InputFormat",
          "None",
          "-Command",
          `& {
            Add-Type -AssemblyName System.Windows.Forms;
            $f = New-Object System.Windows.Forms.FolderBrowserDialog;
            $f.Description = 'Select Output Folder';
            $f.UseDescriptionForTitle = $true;
            $f.ShowNewFolderButton = $true;
            $w = New-Object System.Windows.Forms.Form;
            $w.TopMost = $true;
            $w.Size = New-Object System.Drawing.Size(0,0);
            $w.StartPosition = 'CenterScreen';
            $w.ShowInTaskbar = $false;
            if ($f.ShowDialog($w) -eq 'OK') {
              $f.SelectedPath
            }
            $w.Dispose();
          }`,
        ],
        (err, stdout) => {
          if (err) return res.json({ success: false });
          const finalPath = stdout ? stdout.trim() : "";
          if (!finalPath) return res.json({ success: false, cancelled: true });

          config.outputFolder = finalPath;
          saveConfig(config);
          res.json({ success: true, folder: finalPath, path: finalPath });
        }
      );

    } else {
      execFile(
        "zenity",
        [
          "--file-selection",
          "--directory",
          "--title=Select Output Folder",
        ],
        (err, stdout) => {
          if (err) {
            if (err.code === 1) {
              return res.json({ success: false, cancelled: true });
            }
            return res.json({
              success: false,
              requiresManualInput: true,
              message: "Manual path required on Linux",
            });
          }
          const finalPath = stdout ? stdout.trim() : "";
          if (!finalPath) return res.json({ success: false, cancelled: true });

          config.outputFolder = finalPath;
          saveConfig(config);
          res.json({ success: true, folder: finalPath, path: finalPath });
        }
      );
    }
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
};

// Local Replay File Picker (Multi-select)
const pickFileReplayHandler = async (req, res) => {
  try {
    const { execFile } = require("child_process");

    if (os.platform() === "darwin") {
      execFile("osascript", [
        "-e", 'set selectedFiles to (choose file with prompt "Select Showdown Replay HTML Files" of type {"public.html"} with multiple selections allowed)',
        "-e", "set pathList to {}",
        "-e", "repeat with aFile in selectedFiles",
        "-e", "  copy POSIX path of aFile to end of pathList",
        "-e", "end repeat",
        "-e", "set AppleScript's text item delimiters to linefeed",
        "-e", "pathList as text"
      ], (err, stdout) => {
        handleFileSelection(err, stdout, res);
      });
    } else if (os.platform() === "win32") {
       execFile("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-STA",
        "-InputFormat",
        "None",
        "-Command",
        `& {
          Add-Type -AssemblyName System.Windows.Forms;
          $f = New-Object System.Windows.Forms.OpenFileDialog;
          $f.Filter = 'HTML Files (*.html)|*.html';
          $f.Multiselect = $true;
          $f.Title = 'Select Showdown Replay HTML Files';
          $w = New-Object System.Windows.Forms.Form;
          $w.TopMost = $true;
          $w.Size = New-Object System.Drawing.Size(0,0);
          $w.StartPosition = 'CenterScreen';
          $w.ShowInTaskbar = $false;
          if ($f.ShowDialog($w) -eq 'OK') {
              $f.FileNames
          }
          $w.Dispose();
        }`
      ], (err, stdout) => {
        handleFileSelection(err, stdout, res);
      });
    } else {
      // Linux zenity
      execFile("zenity", [
        "--file-selection",
        "--multiple",
        "--file-filter=*.html",
        "--title=Select Showdown Replay HTML Files"
      ], (err, stdout) => {
        // Zenity outputs paths separated by "|"
        handleFileSelection(err, stdout ? stdout.replace(/\|/g, "\n") : stdout, res);
      });
    }
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
};

const handleFileSelection = (err, stdout, res) => {
  if (err || !stdout) {
    return res.json({ success: false, error: "No files selected" });
  }

  const filePaths = stdout.trim().split(/\r?\n/).map(p => p.trim()).filter(Boolean);
  if (filePaths.length === 0) {
    return res.json({ success: false, error: "No files selected" });
  }

  const results = [];
  const ignored = [];

  for (const filePath of filePaths) {
    if (!fs.existsSync(filePath)) continue;

    try {
      const content = fs.readFileSync(filePath, "utf8");

      // Parse battle log from <script type="text/plain" class="battle-log-data"> or similar
      const scriptMatch = content.match(/<script[^>]*class="battle-log-data"[^>]*>([\s\S]*?)<\/script>/i);
      if (!scriptMatch) {
        ignored.push(path.basename(filePath));
        continue;
      }

      const logText = scriptMatch[1].trim();
      const hasPlayers = logText.includes("|player|p1|") && logText.includes("|player|p2|");
      if (!hasPlayers) {
        ignored.push(path.basename(filePath));
        continue;
      }

      // Metadata Parsing
      let format = "Unknown Format";
      const tierMatch = logText.match(/\n\|tier\|([^\n|]+)/) || logText.match(/\n\|format\|([^\n|]+)/);
      if (tierMatch) format = tierMatch[1].trim();

      let p1 = "Player 1";
      let p2 = "Player 2";
      const p1Match = logText.match(/\n\|player\|p1\|([^\n|]+)/);
      const p2Match = logText.match(/\n\|player\|p2\|([^\n|]+)/);
      if (p1Match) p1 = p1Match[1].trim();
      if (p2Match) p2 = p2Match[1].trim();

      const turnMatches = Array.from(logText.matchAll(/\n\|turn\|(\d+)/g));
      const totalTurns = turnMatches.length > 0 ? parseInt(turnMatches[turnMatches.length - 1][1]) : 0;

      results.push({
        path: `file://${filePath}`,
        name: path.basename(filePath),
        players: `${p1} vs ${p2}`,
        format,
        totalTurns
      });
    } catch (e) {
      ignored.push(path.basename(filePath));
    }
  }

  res.json({
    success: true,
    files: results,
    ignored: ignored.length > 0 ? ignored : null
  });
};

app.post("/api/pick-file-replay", pickFileReplayHandler);

app.get("/api/browse", pickFolderHandler);
app.get("/api/pick-folder", pickFolderHandler);
app.post("/api/pick-folder", pickFolderHandler);

// Open Record Folder
app.post("/api/open-folder", (req, res) => {
  // Safety check for req.body to prevent TypeErrors
  const target = (req.body && req.body.path) || config.outputFolder;
  if (fs.existsSync(target)) {
    open(target);
    res.json({ success: true });
  } else {
    res.json({ success: false, error: "Folder does not exist" });
  }
});

// Rename Video API
app.post("/api/rename", (req, res) => {
  try {
    const { oldName, newName } = req.body;
    if (!oldName || !newName) {
      return res.json({ ok: false, error: "Missing parameters" });
    }

    const cleanNewName = newName.replace(/[/\\?%*:|"<>]/g, "-");
    const oldPath = path.join(config.outputFolder, oldName);
    const newFilename = cleanNewName.endsWith(".webm") ? cleanNewName : `${cleanNewName}.webm`;
    const newPath = path.join(config.outputFolder, newFilename);

    if (!fs.existsSync(oldPath)) {
      return res.json({ ok: false, error: "Source file not found" });
    }

    if (fs.existsSync(newPath)) {
      return res.json({ ok: false, error: "Destination file already exists" });
    }

    fs.renameSync(oldPath, newPath);
    res.json({ ok: true, filename: newFilename });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// Quit App API
app.post("/api/quit", (req, res) => {
  res.json({ success: true });
  console.log("[System] Shutdown requested via API. Cleaning up...");

  for (const type of ["nochat", "chat"]) {
    for (const item of pools[type]) {
      if (item.browser) {
        try {
          item.browser.close();
        } catch (err) {}
      }
    }
  }

  for (const ctrl of controllers.values()) {
    try {
      ctrl.abort();
    } catch (err) {}
  }

  setTimeout(() => {
    process.exit(0);
  }, 1000);
});

// Socket Events
io.on("connection", (socket) => {
  console.log("[Socket] Client connected");

  const isReady = fs.existsSync(CONFIG_PATH);
  socket.emit("status", { ready: isReady, warming: isSystemWarming, recording: activeRecordings > 0 });

  socket.on("setup", async () => {
    try {
      socket.emit("log", { msg: "⚙️ Starting environment validation...", type: "info" });

      // Ensure output directory exists
      if (!fs.existsSync(config.outputFolder)) {
        fs.mkdirSync(config.outputFolder, { recursive: true });
      }

      // Check browser
      const type = config.nochat ? "nochat" : "chat";
      socket.emit("log", { msg: `🌐 Ensuring headless browser (${type}) is ready...`, type: "info" });
      await getBrowser(type, 0, true);

      socket.emit("log", { msg: "✅ Environment ready!", type: "success" });
      socket.emit("setup-done");
      io.emit("status", { ready: true, warming: isSystemWarming, recording: activeRecordings > 0 });
    } catch (err) {
      socket.emit("log", { msg: `❌ Setup failed: ${err.message}`, type: "error" });
    }
  });

  socket.on("record", ({ recordings, recordConfig }) => {
    stopIdleTimeout();
    if (recordConfig) {
      config = { ...config, ...recordConfig };
      saveConfig(config);
    }

    recordings.forEach(({ id, link }) => {
      globalQueue.push({ id, link });
      socket.emit("log", { msg: `📝 Added to queue: ${link}`, type: "info" });
    });
    triggerNext();
  });

  socket.on("add-to-queue", (links) => {
    stopIdleTimeout();
    links.forEach((link) => {
      const id = generateFileId();
      globalQueue.push({ id, link });
      socket.emit("log", { msg: `📝 Added to queue: ${link}`, type: "info" });
    });
    triggerNext();
  });

  socket.on("cancel-recording", (data) => {
    const id = typeof data === "object" && data !== null ? data.id : data;
    if (!id) return;

    // 1. Check if it's in queue
    const queueIdx = globalQueue.findIndex((r) => r.id === id);
    if (queueIdx > -1) {
      globalQueue.splice(queueIdx, 1);
      socket.emit("log", { msg: `🚫 Cancelled from queue: ${id}`, type: "warn" });
      return;
    }

    // 2. Check if it's active
    if (controllers.has(id)) {
      controllers.get(id).abort();
      socket.emit("log", { msg: `🛑 Stopping active recording: ${id}`, type: "warn" });
    }
  });

  socket.on("clear-queue", () => {
    globalQueue = [];
    socket.emit("log", { msg: "🧹 All pending items cleared.", type: "warn" });
  });
});

// START
server.listen(APP_PORT, "0.0.0.0", () => {
  console.log(`[Server] Showdown Replay Studio starting on http://localhost:${APP_PORT}`);

  // Auto-open browser in dev/start
  open(`http://localhost:${APP_PORT}`);

  console.log("[System] Initializing background browsers...");
  (async () => {
    try {
      console.log("[System] Launching background browser 'nochat' [0]...");
      await prelaunchBrowser("nochat", 0, true);
      console.log("[System] background browser 'nochat' [0] initialized.");

      console.log("[System] Launching background browser 'chat' [0]...");
      await prelaunchBrowser("chat", 0, true);
      console.log("[System] background browser 'chat' [0] initialized.");

      console.log("[System] Launching background browser 'nochat' [1]...");
      await prelaunchBrowser("nochat", 1, true);
      console.log("[System] background browser 'nochat' [1] initialized.");

      console.log("[System] Launching background browser 'chat' [1]...");
      await prelaunchBrowser("chat", 1, true);
      console.log("[System] background browser 'chat' [1] initialized.");

      console.log("[System] Waiting for background cache warming to complete...");
      await Promise.all([
        pools.nochat[0].warmPromise,
        pools.chat[0].warmPromise,
        pools.nochat[1].warmPromise,
        pools.chat[1].warmPromise
      ].filter(Boolean));

      isSystemWarming = false;
      console.log("[System] Application ready.");
      io.emit("status", { ready: true, warming: false, recording: activeRecordings > 0 });
      startIdleTimeout();
    } catch (err) {
      isSystemWarming = false;
      console.error(`[Error] Background browser pre-launch failed: ${err.message}`);
      io.emit("status", { ready: true, warming: false, recording: activeRecordings > 0 });
      startIdleTimeout();
    }
  })();
});

/**
 * GLOBAL PROCESS ERROR HANDLERS
 */
process.on("uncaughtException", (err) => {
  console.error("[Fatal Error] Uncaught Exception:", err.message);
  console.error(err.stack);
  // Give logs a moment to flush
  setTimeout(() => process.exit(1), 1000);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error(
    "[Fatal Error] Unhandled Rejection at:",
    promise,
    "reason:",
    reason,
  );
  if (reason instanceof Error) {
    console.error(reason.stack);
  }
});
