const { getStream } = require("puppeteer-stream");
const ffmpeg = require("fluent-ffmpeg");
const fs = require("fs");
const path = require("path");
const os = require("os");

/**
 * UTILITIES
 */
const generateFileId = () =>
  Math.random().toString(36).substring(2, 15) +
  Math.random().toString(36).substring(2, 5);

/**
 * FFmpeg CONFIGURATION
 */
function getFfmpegPath() {
  let resPath = "ffmpeg";
  const { execSync } = require("child_process");

  console.log(`[System] Resolving FFmpeg. Platform: ${os.platform()}`);

  // 1. Try system PATH first (most reliable for Windows users who have it installed)
  try {
    execSync("ffmpeg -version", { stdio: "ignore" });
    console.log("[System] Found working system-wide FFmpeg.");
    return "ffmpeg";
  } catch (e) {
    console.log("[System] System-wide FFmpeg not found on PATH.");
  }

  // 2. Try bundled/pkg path
  if (process.pkg) {
    resPath = path.join(path.dirname(process.execPath), "ffmpeg");
    if (os.platform() === "win32") resPath += ".exe";
  } else {
    // 3. Try npm-installed ffmpeg-static
    try {
      resPath = require("ffmpeg-static");
      console.log(`[System] ffmpeg-static returned: ${resPath}`);
    } catch (err) {
      console.warn("[System] ffmpeg-static require failed.");
      resPath = "ffmpeg";
    }
  }

  // Final validation and normalization for Windows
  if (path.isAbsolute(resPath)) {
    if (!fs.existsSync(resPath)) {
      console.warn(`[System] Warning: Path does not exist: ${resPath}.`);
      resPath = "ffmpeg";
    } else {
      // Very Important for Windows: Ensure paths are correctly escaped/quoted later
      resPath = path.resolve(resPath);
    }
  }

  console.log(`[System] Final FFmpeg binary path: ${resPath}`);
  return resPath;
}

const ffmpegPath = getFfmpegPath();
ffmpeg.setFfmpegPath(ffmpegPath);

/**
 * BROWSER LOGIC: Turn Detection & Victory State
 */
async function waitUntilVictory(timeout, page, onProgress, signal) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    if (signal?.aborted) return false;

    try {
      // Extract current turn number
      const turnNumber = await page.evaluate(`(() => {
        const turnDiv = document.querySelector(".innerbattle .turn");
        return turnDiv ? parseInt(turnDiv.innerText.replace("Turn ", "")) || 0 : 0;
      })()`);

      // Detect "won the battle!" message in the history
      const victory = await page.evaluate(`(() => {
        const logs = document.querySelectorAll("div.battle-history");
        if (logs.length === 0) return false;
        return logs[logs.length - 1].textContent.endsWith(" won the battle!");
      })()`);

      if (onProgress) onProgress(turnNumber);
      if (victory) return true;
    } catch (err) {
      // Silent catch for intermittent browser evaluation errors during page loads
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false; // Timeout reached
}

/**
 * MAIN RECORDING PIPELINE
 */
async function download(
  link,
  id,
  browser,
  config,
  emitLog,
  emitProgress,
  signal,
) {
  const { nochat, nomusic, noaudio, theme, speed, outputFolder } = config;
  let playersLabel = "Unknown Replay";
  const fileId = generateFileId();
  const tempPath = path.join(outputFolder, `replay-${fileId}-temp.webm`);
  const finalPath = path.join(outputFolder, `replay-${fileId}.webm`);

  // 1. Validation
  const isValidLink =
    link.startsWith("https://replay.pokemonshowdown.com/") ||
    link.startsWith("http://replay.pokemonshowdown.com/") ||
    link.endsWith(".json") ||
    link.endsWith(".log");

  if (!isValidLink) {
    const errorMsg = `[Recorder] Invalid Showdown link: ${link}`;
    emitLog?.(errorMsg, "error");
    return;
  }

  try {
    // 2. Fetch Metadata
    emitProgress?.(id, link, "fetching");
    const requestLink = link.split("?")[0].replace(/\/$/, "");
    const response = await fetch(`${requestLink}.json`);
    if (!response.ok)
      throw new Error(`Could not fetch replay data from ${requestLink}.json`);

    const data = await response.json();
    const matches = Array.from(data.log.matchAll(/\n\|turn\|(\d+)\n/g));
    const totalTurns =
      matches.length > 0 ? parseInt(matches[matches.length - 1][1]) : 0;
    playersLabel = data
      ? data.players
        ? data.players.join(" vs ")
        : "Unknown Battle"
      : "Unknown Replay";

    fs.mkdirSync(outputFolder, { recursive: true });

    // 3. Page Setup
    emitProgress?.(id, link, "setup");
    const page = await browser.newPage();
    await page.setViewport({
      width: nochat ? 642 : 1100,
      height: 362,
      deviceScaleFactor: 1,
    });

    await page.goto(link, { waitUntil: "load" });

    // Inject UI cleaning styles
    await page.addStyleTag({
      content: `
        header, .replay-controls, #LeaderboardBTF { display: none !important; }

        /* Blast the consent popups out of existence visually and behaviorally */
        .fc-consent-root, .fc-ab-root, .google-fc-monetization-dialog {
          display: none !important;
          visibility: hidden !important;
          pointer-events: none !important;
          width: 0 !important;
          height: 0 !important;
        }

        .bar-wrapper { margin: 0 !important; }
        .battle { top: 0 !important; left: 0 !important; ${nochat ? "margin: 0 !important;" : ""} }
        .battle-log { top: 0 !important; left: 641px !important; ${nochat ? "display: none !important;" : ""} }
      `,
    });

    // Remove consent banner and ads proactively to prevent blocking interactions
    await page.evaluate(() => {
      document.querySelector(".fc-consent-root")?.remove();
      document.querySelector("#LeaderboardBTF")?.remove();
      // Sometimes the banner has a backdrop that blocks clicks
      const backdrop = document.querySelector(".fc-ab-root");
      if (backdrop) backdrop.remove();
    });

    emitProgress?.(id, link, "preparing");
    await page.waitForSelector(".playbutton");

    // Apply User Preferences
    if (speed !== "normal") await page.select('select[name="speed"]', speed);
    if (nomusic) await page.select('select[name="sound"]', "musicoff");
    else if (noaudio) await page.select('select[name="sound"]', "off");
    if (theme !== "auto") await page.select('select[name="darkmode"]', theme);

    // Final check for blocker right before click
    await page.evaluate(() =>
      document.querySelector(".fc-consent-root")?.remove(),
    );
    await page.click(".playbutton");

    // 4. Start Streaming
    const file = fs.createWriteStream(tempPath);
    const stream = await getStream(page, { audio: true, video: true });

    await page.click('button[name="play"]');
    stream.pipe(file);

    const estTime = ((totalTurns * 7) / 60).toFixed(1);
    emitLog?.(
      `⚔️ Recording: ${playersLabel} (${data.format}) | ${totalTurns} turns (~${estTime}m)`,
      "info",
    );

    const updateProgress = (currentTurn) => {
      if (emitProgress) {
        const progress =
          totalTurns > 0
            ? Math.min(Math.floor((currentTurn / totalTurns) * 100), 99)
            : 0;
        emitProgress(id, link, "recording", {
          players: playersLabel,
          format: data.format,
          currentTurn,
          totalTurns,
          progress: Math.max(progress, 10),
          speed: speed || "normal",
        });
      }
    };

    updateProgress(0);

    // 5. Wait for Conclusion
    await waitUntilVictory(600000, page, updateProgress, signal);
    if (signal?.aborted) throw new Error("Recording cancelled.");

    await new Promise((resolve) => setTimeout(resolve, 2000)); // Buffer for animations
    if (signal?.aborted) throw new Error("Recording cancelled.");

    // 6. Cleanup Stream
    stream.unpipe(file);
    file.end();
    await new Promise((resolve) => file.on("finish", resolve));
    stream.destroy();
    try {
      await page.close();
    } catch {}

    // 7. Verify Integrity
    const stats = fs.statSync(tempPath);
    if (stats.size < 1000)
      throw new Error(`Stream capture failed (empty file).`);

    // 8. Fix WebM Metadata (FFmpeg)
    emitLog?.(`🎬 Finalizing metadata: ${playersLabel}...`, "info");
    emitProgress?.(id, link, "finalizing", { players: playersLabel });
    await new Promise((resolve) => setTimeout(resolve, 1000)); // Delay for file handle release on Windows
    await fixWebmMetadata(tempPath, finalPath, signal);

    emitLog?.(`✅ Saved: replay-${fileId}.webm`, "success");
    emitProgress?.(id, link, "done", {
      filename: `replay-${fileId}.webm`,
      players: playersLabel,
    });

    try {
      fs.unlinkSync(tempPath);
    } catch {}
  } catch (err) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {}

    if (err.message === "Recording cancelled.") {
      emitLog?.(`⏹️ Recording cancelled: ${playersLabel || link}`, "info");
      emitProgress?.(id, link, "cancelled");
    } else {
      const errorMsg = `[Recorder Error] ${playersLabel || link}: ${err.message}`;
      emitLog?.(errorMsg, "error");
      emitProgress?.(id, link, "error");
      console.error(err);
    }
  }
}

/**
 * FFmpeg: Metadata Repair
 */
async function fixWebmMetadata(input, output, signal) {
  // Pre-check if FFmpeg actually works to avoid background crashes in fluent-ffmpeg
  try {
    const { execSync } = require("child_process");
    execSync(`"${ffmpegPath}" -version`, { stdio: "ignore" });
  } catch (err) {
    if (signal?.aborted) return;
    console.error(
      `[FFmpeg] Pre-check failed for binary: ${ffmpegPath}. Skipping metadata repair.`,
    );
    console.error(
      "[FFmpeg] The recording will still be saved but might have seek/duration issues in some players.",
    );
    fs.copyFileSync(input, output);
    return;
  }

  return new Promise((resolve, reject) => {
    try {
      const command = ffmpeg(input)
        .withVideoCodec("copy")
        .withAudioCodec("copy")
        .output(output)
        .on("start", (cmd) => {
          if (signal?.aborted) {
            command.kill();
            return;
          }
          console.log(`[FFmpeg] Started command: ${cmd}`);
        })
        .on("end", () => {
          resolve();
        })
        .on("error", (err, stdout, stderr) => {
          if (signal?.aborted) {
            return resolve();
          }
          console.error("[FFmpeg] Error:", err.message);
          console.error("[FFmpeg] Stderr:", stderr);
          // If FFmpeg fails, we still want to "succeed" by just using the raw file
          console.warn("[FFmpeg] Repair failed, using raw capture instead.");
          try {
            fs.copyFileSync(input, output);
            resolve();
          } catch (e) {
            reject(e);
          }
        });

      if (signal) {
        signal.addEventListener("abort", () => {
          try {
            command.kill();
          } catch {}
        });
      }

      command.run();
    } catch (err) {
      if (signal?.aborted) return resolve();
      console.error(
        "[FFmpeg] Synchronous error launching FFmpeg:",
        err.message,
      );
      // Fallback
      try {
        fs.copyFileSync(input, output);
        resolve();
      } catch (e) {
        reject(e);
      }
    }
  });
}

module.exports = {
  download,
  waitUntilVictory,
  fixWebmMetadata,
};
