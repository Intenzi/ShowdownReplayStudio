const express = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { Server } = require("socket.io");
const http = require("http");
const open = require("open");
const { download } = require("./recorder");
const { launch } = require("puppeteer-stream");

const { execSync } = require("child_process");

// Config Management (persists across app updates in OS app data folder)
const CONFIG_DIR = path.join(os.homedir(), ".showdown-recorder");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

function loadConfig() {
  const defaults = {
    outputFolder: path.join(os.homedir(), "showdown-replays"),
    speed: "normal",
    theme: "auto",
    nomusic: false,
    noaudio: false,
    nochat: false,
    bulk: 2,
  };

  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    if (fs.existsSync(CONFIG_FILE)) {
      const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) || {};
      return { ...defaults, ...saved };
    }
  } catch {}
  return defaults;
}

function saveConfig(config) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (err) {
    console.error("Failed to save config:", err);
  }
}

// Version Check via GitHub Releases
const CURRENT_VERSION = require("./package.json").version;
const GITHUB_REPO = "Intenzi/ShowdownReplayDownloader";

async function checkForUpdates() {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
    );
    if (!res.ok) return null;
    const data = await res.json();
    const latest = data.tag_name.replace(/^v/, "");
    if (latest !== CURRENT_VERSION) {
      return { version: latest, url: data.html_url };
    }
  } catch {}
  return null;
}

// Express + Socket.io Setup
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

let browser = null;
let activeRecordings = 0;
let config = loadConfig();

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
  res.json({ ready: browser !== null, recording: activeRecordings > 0 });
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

async function initializeBrowser(socket = null) {
  if (browser) return;

  const emitLog = (msg, type) => {
    if (socket) socket.emit("log", { msg, type });
    else io.emit("log", { msg, type });
  };

  emitLog("Launching browser...", "info");

  try {
    browser = await launch({
      executablePath: require("puppeteer").executablePath(),
      // Setting defaultViewport to null tells Puppeteer to use the launched window size
      // instead of forcing it to match the requested viewport dimensions.
      defaultViewport: null,
      // This completely disables the "Chrome is being controlled by automated test software" infobar!
      ignoreDefaultArgs: ["--enable-automation"],
      args: [
        `--window-size=1280,500`,
        `--allowlisted-extension-id=jjndjgheafjngoipoacpjgeicjeomjli`,
        // `--headless=new`,
        // Platform Agnosticism: Force a 1.0 device scale factor so retina/4K monitors
        // don't secretly record at 2x or 3x resolution.
        `--force-device-scale-factor=1`,
        // Platform Agnosticism: Hide scrollbars so they don't eat into the right-side pixels
        `--hide-scrollbars`,
        // Disable default browser popups/prompts to prevent viewport shifting
        `--disable-notifications`,
        `--disable-infobars`,
      ],
    });
    emitLog("✅ Browser ready!", "success");
    if (socket) socket.emit("setup-done");
    else io.emit("setup-done");
    io.emit("status", { ready: true, recording: false });
  } catch (err) {
    emitLog(`❌ Browser setup failed: ${err}`, "error");
    throw err;
  }
}

// Socket.io - Setup & Recording Flow
io.on("connection", (socket) => {
  socket.emit("status", {
    ready: browser !== null,
    recording: activeRecordings > 0,
  });

  socket.on("setup", async () => {
    try {
      await initializeBrowser(socket);
    } catch {}
  });

  socket.on("record", async ({ recordings, recordConfig }) => {
    // Merge in any config overrides sent from the UI and persist
    if (!browser) {
      socket.emit("log", {
        msg: "Browser not ready. Please wait for setup.",
        type: "error",
      });
      return;
    }

    // merge in any config overrides sent from the UI and persist
    config = { ...config, ...recordConfig };
    saveConfig(config);

    // Bulk mode allows recording multiple replays in parallel (only recommended for strong CPUs)
    let bulk = config.bulk;

    if (parseInt(bulk) && bulk >= 1) {
      bulk = parseInt(bulk);
      if (bulk > recordings.length) bulk = recordings.length;
    } else if (bulk !== "all") {
      socket.emit("log", {
        msg: `Invalid bulk value: "${bulk}"`,
        type: "error",
      });
      return;
    }

    activeRecordings += recordings.length;
    io.emit("status", { ready: true, recording: true });

    const emitLog = (msg, type = "info") => io.emit("log", { msg, type });
    const emitProgress = (id, link, state, meta = {}) =>
      io.emit("progress", { id, link, state, ...meta });

    const toRecord = [];
    if (recordings.length > 1 && (bulk === "all" || bulk > 1)) {
      if (bulk === "all") {
        toRecord.push(recordings);
      } else {
        // Chunk the recordings into smaller lists based on bulk size
        for (let i = 0; i < recordings.length; i += bulk) {
          toRecord.push(recordings.slice(i, i + bulk));
        }
      }

      for (let batch of toRecord) {
        await Promise.all(
          batch.map((rec) =>
            download(rec.link, rec.id, browser, config, emitLog, emitProgress),
          ),
        );
      }
    } else {
      for (let rec of recordings)
        await download(rec.link, rec.id, browser, config, emitLog, emitProgress); // record one by one
    }

    activeRecordings -= recordings.length;
    io.emit("status", { ready: true, recording: activeRecordings > 0 });
    emitLog("🏁 All recordings complete!", "success");
  });
});

// Application Boot
const PORT = 57335; // unlikely to clash with anything
server.listen(PORT, "127.0.0.1", async () => {
  console.log(`Showdown Recorder running at http://localhost:${PORT}`);
  open(`http://localhost:${PORT}`); // auto-open browser tab

  // Check if browser is already "downloaded" (exists) and auto-launch if so
  try {
    const exePath = require("puppeteer").executablePath();
    if (fs.existsSync(exePath)) {
      await initializeBrowser();
    }
  } catch (err) {
    console.error("Auto-launch failed:", err);
  }
});

// Cleanup on exit
process.on("SIGINT", async () => {
  try {
    if (browser) await browser.close();
  } catch {}
  process.exit();
});
