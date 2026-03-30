const { launch } = require("puppeteer-stream");
const { download } = require("./recorder");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");
const open = require("open");

// Versioning and Updates
const CURRENT_VERSION = "1.1.0";
const GITHUB_REPO = "Intenzi/ShowdownReplayDownloader";

async function checkForUpdates() {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
    );
    const data = await response.json();
    return data.tag_name !== `v${CURRENT_VERSION}` ? data.tag_name : null;
  } catch {
    return null;
  }
}

// Config Persistence
const CONFIG_PATH = path.join(process.cwd(), "config.json");
const DEFAULT_CONFIG = {
  outputFolder: path.join(require("os").homedir(), "showdown-replays"),
  nochat: true,
  nomusic: false,
  noaudio: false,
  theme: "auto",
  speed: "normal",
  bulk: 1, // Default to 1 for stability
};

function loadConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH)) };
  }
  return DEFAULT_CONFIG;
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// GUI Server Setup
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/videos", express.static(loadConfig().outputFolder));

let activeRecordings = 0;
let config = loadConfig();

// Browser Persistence Layer
let browsers = {
  nochat: null,
  chat: null,
};

async function launchOptimizedBrowser(width, height) {
  return await launch({
    executablePath: require("puppeteer").executablePath(),
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
}

// Global Singleton Rolling Queue System
let globalQueue = [];
let isProcessing = false;
let concurrentCount = 0;

async function triggerNext() {
  // If we are already at capacity or queue is empty, do nothing
  if (
    concurrentCount >= (parseInt(config.bulk) || 1) ||
    globalQueue.length === 0
  ) {
    return;
  }

  const rec = globalQueue.shift();
  concurrentCount++;
  activeRecordings++;
  io.emit("status", { ready: true, recording: true });

  const emitLog = (msg, type = "info") => io.emit("log", { msg, type });
  const emitProgress = (id, link, state, meta = {}) =>
    io.emit("progress", { id, link, state, ...meta });

  runRecording(rec, emitLog, emitProgress);

  // Attempt to start another one immediately if bulk capacity allows
  triggerNext();
}

async function runRecording(rec, emitLog, emitProgress) {
  try {
    const type = config.nochat ? "nochat" : "chat";

    // Safety check: if browser crashed, restart it
    if (!browsers[type] || !browsers[type].isConnected()) {
      emitLog(`Refreshing ${type} browser context...`, "info");
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
    emitLog(`❌ Recording error: ${err.message}`, "error");
  } finally {
    concurrentCount--;
    activeRecordings--;
    io.emit("status", { ready: true, recording: activeRecordings > 0 });

    if (activeRecordings === 0 && globalQueue.length === 0) {
      emitLog("🏁 All queued processes complete!", "success");
    }

    // Trigger next item in queue immediately
    triggerNext();
  }
}

// API Routes
app.get("/api/config", (req, res) => {
  res.json(config);
});

app.post("/api/config", (req, res) => {
  config = { ...config, ...req.body };
  saveConfig(config);
  res.json({ ok: true });
});

app.get("/api/version", async (req, res) => {
  const update = await checkForUpdates();
  res.json({ current: CURRENT_VERSION, update });
});

app.get("/api/status", (req, res) => {
  res.json({ ready: true, recording: activeRecordings > 0 });
});

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
  let finalNewName = newName.endsWith(".webm") ? newName : newName + ".webm";
  const newPath = path.join(config.outputFolder, finalNewName);

  if (fs.existsSync(oldPath)) {
    try {
      fs.renameSync(oldPath, newPath);
      res.json({ ok: true, filename: finalNewName });
    } catch (err) {
      res.status(500).json({ error: "Rename failed" });
    }
  } else {
    res.status(404).json({ error: "Original file not found" });
  }
});

// Folder picker — uses Node's dialog via a tiny helper
app.post("/api/pick-folder", async (req, res) => {
  // On Windows/Mac/Linux we can spawn a dialog via PowerShell / osascript / zenity
  // Falls back to manual text entry if unavailable
  try {
    let folder = null;

    if (process.platform === "win32") {
      const ps = `Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.ShowDialog() | Out-Null; $f.SelectedPath`;
      folder = execSync(`powershell -command "${ps}"`, {
        encoding: "utf8",
      }).trim();
    } else if (process.platform === "darwin") {
      folder = execSync(
        `osascript -e 'POSIX path of (choose folder with prompt "Select output folder")'`,
        { encoding: "utf8" },
      ).trim();
    } else {
      // Linux — try zenity, fall back to nothing
      folder = execSync("zenity --file-selection --directory 2>/dev/null", {
        encoding: "utf8",
      }).trim();
    }

    if (folder) {
      config.outputFolder = folder;
      saveConfig(config);
      res.json({ folder });
    } else {
      res.json({ folder: null });
    }
  } catch {
    res.json({ folder: null });
  }
});

io.on("connection", (socket) => {
  socket.emit("status", {
    ready: true,
    recording: activeRecordings > 0,
  });

  socket.on("record", async ({ recordings, recordConfig }) => {
    config = { ...config, ...recordConfig };
    saveConfig(config);

    globalQueue.push(...recordings);
    triggerNext();
  });
});

const PORT = process.env.PORT || 57335;
server.listen(PORT, async () => {
  console.log(`Showdown Recorder running at http://localhost:${PORT}`);

  // Pre-launch the two optimized browsers on startup
  try {
    console.log("Initializing recording browsers...");
    browsers.nochat = await launchOptimizedBrowser(642, 450); // self adjusted value from 362 + 88 where 88 is the extra height of chrome's tab bar
    browsers.chat = await launchOptimizedBrowser(1100, 450);
    console.log("✅ Browsers ready.");
  } catch (err) {
    console.error("❌ Failed to initialize browsers:", err);
  }

  await open(`http://localhost:${PORT}`);
});
