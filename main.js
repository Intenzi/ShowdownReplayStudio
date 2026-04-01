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

async function triggerNext() {
  const maxConcurrency = parseInt(config.bulk) || 1;
  if (concurrentCount >= maxConcurrency || globalQueue.length === 0) return;

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

      await download(
        rec.link,
        rec.id,
        browsers[type],
        config,
        emitLog,
        emitProgress,
      );
    } catch (err) {
      emitLog(`[Error] ${err.message}`, "error");
    } finally {
      concurrentCount--;
      activeRecordings--;
      io.emit("status", { ready: true, recording: activeRecordings > 0 });

      if (activeRecordings === 0 && globalQueue.length === 0) {
        emitLog("🏁 All queued processes complete!", "success");
      }
      triggerNext();
    }
  })();

  triggerNext(); // Support filling all available slots
}

/**
 * SERVER SETUP
 */
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/videos", express.static(config.outputFolder));

// API: Configuration
app.get("/api/config", (req, res) => res.json(config));
app.post("/api/config", (req, res) => {
  config = { ...config, ...req.body };
  saveConfig(config);
  res.json({ ok: true });
});

// API: System
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

app.get("/api/status", (req, res) => {
  const isReady = fs.existsSync(CONFIG_PATH);
  res.json({ ready: isReady, recording: activeRecordings > 0 });
});

// API: File Management
app.get("/api/open-video/:filename", (req, res) => {
  const filePath = path.join(config.outputFolder, req.params.filename);
  if (fs.existsSync(filePath)) {
    open(filePath);
    res.json({ ok: true });
  } else {
    res.status(404).json({ error: "File not found" });
  }
});

app.post("/api/open-folder", (req, res) => {
  if (fs.existsSync(config.outputFolder)) {
    open(config.outputFolder);
    res.json({ ok: true });
  } else {
    res.status(404).json({ error: "Folder not found" });
  }
});

app.post("/api/rename", (req, res) => {
  const { oldName, newName } = req.body;
  const oldPath = path.join(config.outputFolder, oldName);
  const finalNewName = newName.endsWith(".webm") ? newName : `${newName}.webm`;
  const newPath = path.join(config.outputFolder, finalNewName);

  if (fs.existsSync(oldPath)) {
    try {
      fs.renameSync(oldPath, newPath);
      res.json({ ok: true, filename: finalNewName });
    } catch (err) {
      res.status(500).json({ error: "Rename failed" });
    }
  } else {
    res.status(404).json({ error: "File not found" });
  }
});

app.post("/api/pick-folder", async (req, res) => {
  try {
    let folder = null;
    if (process.platform === "win32") {
      const ps =
        "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.ShowDialog() | Out-Null; $f.SelectedPath";
      folder = execSync(`powershell -command "${ps}"`, {
        encoding: "utf8",
      }).trim();
    } else if (process.platform === "darwin") {
      folder = execSync(
        `osascript -e 'POSIX path of (choose folder with prompt "Select output folder")'`,
        { encoding: "utf8" },
      ).trim();
    } else {
      folder = execSync("zenity --file-selection --directory 2>/dev/null", {
        encoding: "utf8",
      }).trim();
    }

    if (folder) {
      config.outputFolder = folder;
      // Note: We don't save immediately here to allow 'setup' to handle the final save
      res.json({ folder });
    } else {
      res.json({ folder: null });
    }
  } catch {
    res.json({ folder: null });
  }
});

app.post("/api/quit", (req, res) => {
  res.json({ ok: true });
  setTimeout(() => {
    console.log("[System] Shutting down application...");
    process.exit(0);
  }, 500);
});

/**
 * SOCKET.IO COMMUNICATION
 */
io.on("connection", (socket) => {
  const isReady = fs.existsSync(CONFIG_PATH);
  socket.emit("status", { ready: isReady, recording: activeRecordings > 0 });

  socket.on("setup", () => {
    console.log("[Setup] Finalizing first-time configuration...");
    saveConfig(config); // This creates the config.json file
    socket.emit("setup-done");
    io.emit("status", { ready: true, recording: activeRecordings > 0 });
  });

  socket.on("record", async ({ recordings, recordConfig }) => {
    config = { ...config, ...recordConfig };
    saveConfig(config);
    globalQueue.push(...recordings);
    triggerNext();
  });
});

/**
 * START APPLICATION
 */
server.listen(APP_PORT, "0.0.0.0", async () => {
  console.log(
    `[Server] Showdown Replay Studio starting on http://localhost:${APP_PORT}`,
  );

  try {
    console.log("[System] Initializing background browsers...");

    // Integrity check for bundled environments
    const isBundled = process.pkg;
    if (isBundled && !bundledExecutablePath) {
      console.warn(
        "⚠️ [Warning] Bundled Chromium not found in 'resources' or sibling directory.",
      );
      console.warn(
        "👉 Please ensure you haven't moved the EXE away from its 'resources' folder.",
      );
    }

    browsers.nochat = await launchOptimizedBrowser(642, 450);
    browsers.chat = await launchOptimizedBrowser(1100, 450);
    console.log("[System] Application ready.");
  } catch (err) {
    console.error(`[Error] critical initialization failure: ${err.message}`);
    console.error(err.stack); // More detail
  }

  await open(`http://localhost:${APP_PORT}`);
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
  // Check if reason is an Error object
  if (reason instanceof Error) {
    console.error(reason.stack);
  }
});
