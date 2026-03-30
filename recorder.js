const { getStream } = require("puppeteer-stream");
const ffmpeg = require("fluent-ffmpeg");
const fs = require("fs");
const path = require("path");

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
  if (process.pkg) {
    // In bundled macOS apps, binaries must sit on the real disk (Contents/MacOS/)
    const bundledPath = path.join(path.dirname(process.execPath), "ffmpeg");
    if (fs.existsSync(bundledPath)) return bundledPath;
  }
  try {
    return require("ffmpeg-static");
  } catch (err) {
    console.error("[System] FFmpeg static binary not found.");
    return "ffmpeg"; // Fallback to system PATH
  }
}

ffmpeg.setFfmpegPath(getFfmpegPath());

/**
 * BROWSER LOGIC: Turn Detection & Victory State
 */
async function waitUntilVictory(timeout, page, onProgress) {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeout) {
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
async function download(link, id, browser, config, emitLog, emitProgress) {
  const { nochat, nomusic, noaudio, theme, speed, outputFolder } = config;
  let playersLabel = "Unknown Replay";
  const fileId = generateFileId();
  const tempPath = path.join(outputFolder, `replay-${fileId}-temp.webm`);
  const finalPath = path.join(outputFolder, `replay-${fileId}.webm`);

  // 1. Validation
  const isValidLink = (link.startsWith("https://replay.pokemonshowdown.com/") || 
                     link.startsWith("http://replay.pokemonshowdown.com/")) ||
                    (link.endsWith(".json") || link.endsWith(".log"));

  if (!isValidLink) {
    const errorMsg = `[Recorder] Invalid Showdown link: ${link}`;
    emitLog?.(errorMsg, "error");
    return;
  }

  try {
    // 2. Fetch Metadata
    const requestLink = link.split("?")[0].replace(/\/$/, "");
    const response = await fetch(`${requestLink}.json`);
    if (!response.ok) throw new Error(`Could not fetch replay data from ${requestLink}.json`);

    const data = await response.json();
    const matches = Array.from(data.log.matchAll(/\n\|turn\|(\d+)\n/g));
    const totalTurns = matches.length > 0 ? parseInt(matches[matches.length - 1][1]) : 0;
    playersLabel = data ? (data.players ? data.players.join(" vs ") : "Unknown Battle") : "Unknown Replay";

    fs.mkdirSync(outputFolder, { recursive: true });

    // 3. Page Setup
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
        .bar-wrapper { margin: 0 !important; }
        .battle { top: 0 !important; left: 0 !important; ${nochat ? "margin: 0 !important;" : ""} }
        .battle-log { top: 0 !important; left: 641px !important; ${nochat ? "display: none !important;" : ""} }
      `,
    });

    await page.waitForSelector(".playbutton");

    // Apply User Preferences
    if (speed !== "normal") await page.select('select[name="speed"]', speed);
    if (nomusic) await page.select('select[name="sound"]', "musicoff");
    else if (noaudio) await page.select('select[name="sound"]', "off");
    if (theme !== "auto") await page.select('select[name="darkmode"]', theme);

    // 4. Start Streaming
    const file = fs.createWriteStream(tempPath);
    const stream = await getStream(page, { audio: !noaudio, video: true });

    await page.click('button[name="play"]');
    stream.pipe(file);

    const estTime = ((totalTurns * 7) / 60).toFixed(1);
    emitLog?.(`⚔️ Recording: ${playersLabel} (${data.format}) | ${totalTurns} turns (~${estTime}m)`, "info");

    const updateProgress = (currentTurn) => {
      if (emitProgress) {
        const progress = totalTurns > 0 ? Math.min(Math.floor((currentTurn / totalTurns) * 100), 99) : 0;
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
    await waitUntilVictory(600000, page, updateProgress);
    await new Promise((resolve) => setTimeout(resolve, 2000)); // Buffer for animations

    // 6. Cleanup Stream
    stream.unpipe(file);
    file.end();
    await new Promise((resolve) => file.on("finish", resolve));
    stream.destroy();
    try { await page.close(); } catch {}

    // 7. Verify Integrity
    const stats = fs.statSync(tempPath);
    if (stats.size < 1000) throw new Error(`Stream capture failed (empty file).`);

    // 8. Fix WebM Metadata (FFmpeg)
    emitLog?.(`🎬 Finalizing metadata: ${playersLabel}...`, "info");
    await fixWebmMetadata(tempPath, finalPath);

    emitLog?.(`✅ Saved: replay-${fileId}.webm`, "success");
    emitProgress?.(id, link, "done", { filename: `replay-${fileId}.webm` });

    try { fs.unlinkSync(tempPath); } catch {}

  } catch (err) {
    try { fs.unlinkSync(tempPath); } catch {}
    const errorMsg = `[Recorder Error] ${playersLabel || link}: ${err.message}`;
    emitLog?.(errorMsg, "error");
    emitProgress?.(id, link, "error");
    console.error(err);
  }
}

/**
 * FFmpeg: Metadata Repair
 */
async function fixWebmMetadata(input, output) {
  return new Promise((resolve, reject) => {
    ffmpeg(input)
      .withVideoCodec("copy")
      .withAudioCodec("copy")
      .output(output)
      .on("end", resolve)
      .on("error", (err, stdout, stderr) => {
        reject(new Error(`FFmpeg processing failed: ${err.message}`));
      })
      .run();
  });
}

module.exports = {
  download,
  waitUntilVictory,
  fixWebmMetadata,
};
