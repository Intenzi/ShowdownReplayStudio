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
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    }
  } catch {}
  return {
    outputFolder: path.join(os.homedir(), "showdown-replays"),
    speed: "normal",
    theme: "auto",
    nomusic: false,
    noaudio: false,
    nochat: false,
    bulk: "all",
  };
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
let isRecording = false;
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
  res.json({ ready: browser !== null, recording: isRecording });
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

// Socket.io - Setup & Recording Flow
io.on("connection", (socket) => {
  socket.emit("status", { ready: browser !== null, recording: isRecording });

  socket.on("setup", async () => {
    if (browser) {
      socket.emit("setup-done");
      return;
    }
    socket.emit("log", { msg: "Launching browser...", type: "info" });
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
      socket.emit("log", { msg: "✅ Browser ready!", type: "success" });
      socket.emit("setup-done");
      io.emit("status", { ready: true, recording: false });
    } catch (err) {
      socket.emit("log", {
        msg: `❌ Browser setup failed: ${err}`,
        type: "error",
      });
    }
  });

  socket.on("record", async ({ links: rawLinks, recordConfig }) => {
    if (isRecording) {
      socket.emit("log", { msg: "Already recording!", type: "error" });
      return;
    }
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

    const links = rawLinks.split(/[\s,]+/).filter(Boolean); // https://stackoverflow.com/a/23728809/14393614
    let bulk = config.bulk;

    if (parseInt(bulk) && bulk >= 1) {
      bulk = parseInt(bulk);
      if (bulk > links.length) bulk = links.length;
    } else if (bulk !== "all") {
      socket.emit("log", {
        msg: `Invalid bulk value: "${bulk}"`,
        type: "error",
      });
      return;
    }

    isRecording = true;
    io.emit("status", { ready: true, recording: true });

    const emitLog = (msg, type = "info") => io.emit("log", { msg, type });
    const emitProgress = (link, state) => io.emit("progress", { link, state });

    const toRecord = [];
    if (links.length > 1 && (bulk === "all" || bulk > 1)) {
      if (bulk === "all") {
        toRecord.push(links);
      } else {
        // Chunk the links into smaller lists based on bulk size
        for (let i = 0; i < links.length; i += bulk) {
          toRecord.push(links.slice(i, i + bulk));
        }
      }

      for (let recordLinks of toRecord) {
        await Promise.all(
          recordLinks.map((link) =>
            download(link, browser, config, emitLog, emitProgress),
          ),
        );
      }
    } else {
      for (let link of links)
        await download(link, browser, config, emitLog, emitProgress); // record one by one
    }

    isRecording = false;
    io.emit("status", { ready: true, recording: false });
    emitLog("🏁 All recordings complete!", "success");
  });
});

// Application Boot
const PORT = 57335; // unlikely to clash with anything
server.listen(PORT, "127.0.0.1", () => {
  console.log(`Showdown Recorder running at http://localhost:${PORT}`);
  open(`http://localhost:${PORT}`); // auto-open browser tab
});

// Cleanup on exit
process.on("SIGINT", async () => {
  try {
    if (browser) await browser.close();
  } catch {}
  process.exit();
});
