const { launch } = require("puppeteer-stream");
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
      return { ...DEFAULT_CONFIG, ...saved };
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

/**
 * BROWSER MANAGEMENT
 */
const browsers = { nochat: null, chat: null };

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
    const browser = await launch({
      executablePath: launchPath,
      ignoreDefaultArgs: ["--enable-automation"],
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

/**
 * QUEUE SYSTEM
 */
let globalQueue = [];
let concurrentCount = 0;
let activeRecordings = 0;
const controllers = new Map();

async function triggerNext() {
  const maxConcurrency = config.bulk === "all" ? 99 : (parseInt(config.bulk) || 1);

  // Use a while loop to fill up all available slots immediately
  while (concurrentCount < maxConcurrency && globalQueue.length > 0) {
    const rec = globalQueue.shift();
    concurrentCount++;
    activeRecordings++;

  io.emit("status", { ready: true, recording: true });

  const emitLog = (msg, type = "info") => io.emit("log", { msg, type });
  const emitProgress = (id, link, state, meta = {}) =>
    io.emit("progress", { id, link, state, ...meta });

  emitProgress(rec.id, rec.link, "starting");

  (async () => {
    try {
      const type = config.nochat ? "nochat" : "chat";
      if (!browsers[type] || !browsers[type].isConnected()) {
        emitLog(`[Browser] Initializing ${type} instance...`, "info");
        browsers[type] = await launchOptimizedBrowser(
          config.nochat ? 642 : 1100,
          450,
        );
      }

      const ctrl = new AbortController();
      controllers.set(rec.id, ctrl);

      await download(
        rec.link,
        rec.id,
        browsers[type],
        config,
        emitLog,
        emitProgress,
        ctrl.signal,
      );
    } catch (err) {
      emitLog(`[Error] ${err.message}`, "error");
    } finally {
      controllers.delete(rec.id);
      concurrentCount--;
      activeRecordings--;
      io.emit("status", { ready: true, recording: activeRecordings > 0 });

      if (activeRecordings === 0 && globalQueue.length === 0) {
        emitLog("🏁 All queued processes complete!", "success");
      }
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
  res.json({ ready: isReady, recording: activeRecordings > 0 });
});

// Directory Browser / Folder Picker
const pickFolderHandler = async (req, res) => {
  try {
    const { exec } = require("child_process");
    if (os.platform() === "darwin") {
      const script = `osascript -e 'POSIX path of (choose folder with prompt "Select Output Folder")'`;
      exec(script, (err, stdout) => {
        if (err || !stdout) return res.json({ success: false });
        const finalPath = stdout.trim();
        if (!finalPath) return res.json({ success: false });

        config.outputFolder = finalPath;
        saveConfig(config);

        res.json({ success: true, folder: finalPath, path: finalPath });
      });
    } else if (os.platform() === "win32") {
      const script =
        'powershell.exe -NoProfile -Command "& { $f = New-Object System.Windows.Forms.FolderBrowserDialog; if($f.ShowDialog() -eq \'OK\') { $f.SelectedPath } }"';
      exec(script, (err, stdout) => {
        if (err || !stdout) return res.json({ success: false });
        const finalPath = stdout.trim();
        if (!finalPath) return res.json({ success: false });

        config.outputFolder = finalPath;
        saveConfig(config);

        res.json({ success: true, folder: finalPath, path: finalPath });
      });
    } else {
      res.json({ success: false, message: "Manual path required on Linux" });
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
        "-Command",
        `& {
          Add-Type -AssemblyName System.Windows.Forms;
          $f = New-Object System.Windows.Forms.OpenFileDialog;
          $f.Filter = 'HTML Files (*.html)|*.html';
          $f.Multiselect = $true;
          $f.Title = 'Select Showdown Replay HTML Files';
          if($f.ShowDialog() -eq 'OK') {
              $f.FileNames
          }
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
    if (browsers[type]) {
      try {
        browsers[type].close();
      } catch (err) {}
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
  socket.emit("status", { ready: isReady, recording: activeRecordings > 0 });

  socket.on("setup", async () => {
    try {
      socket.emit("log", { msg: "⚙️ Starting environment validation...", type: "info" });

      // Ensure output directory exists
      if (!fs.existsSync(config.outputFolder)) {
        fs.mkdirSync(config.outputFolder, { recursive: true });
      }

      // Check browser
      const type = config.nochat ? "nochat" : "chat";
      if (!browsers[type] || !browsers[type].isConnected()) {
        socket.emit("log", { msg: "🌐 Launching headless browser...", type: "info" });
        browsers[type] = await launchOptimizedBrowser(
          config.nochat ? 642 : 1100,
          450,
        );
      }

      socket.emit("log", { msg: "✅ Environment ready!", type: "success" });
      socket.emit("setup-done");
      io.emit("status", { ready: true, recording: activeRecordings > 0 });
    } catch (err) {
      socket.emit("log", { msg: `❌ Setup failed: ${err.message}`, type: "error" });
    }
  });

  socket.on("record", ({ recordings, recordConfig }) => {
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
  launchOptimizedBrowser(642, 450).then(b => {
    browsers.nochat = b;
    console.log("[System] Application ready.");
  }).catch(err => {
    console.error(`[Error] critical initialization failure: ${err.message}`);
  });
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
