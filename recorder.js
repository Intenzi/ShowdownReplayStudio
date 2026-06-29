const { getStream } = require("puppeteer-stream");
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
        const activeLog = document.querySelector("div.battle-log");
        if (!activeLog) return false;
        const logs = activeLog.querySelectorAll("div.battle-history");
        if (logs.length === 0) return false;
        return logs[logs.length - 1].textContent.trim().endsWith(" won the battle!");
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
  const finalPath = path.join(outputFolder, `replay-${fileId}.mp4`);

  // 1. Validation
  const isValidLink =
    link.startsWith("https://replay.pokemonshowdown.com/") ||
    link.startsWith("http://replay.pokemonshowdown.com/") ||
    link.startsWith("file://");

  if (!isValidLink) {
    const errorMsg = `[Recorder] Invalid Showdown link: ${link}`;
    emitLog?.(errorMsg, "error");
    return;
  }

  let page = null;
  let stream = null;
  let file = null;

  try {
    // 2. Fetch Metadata
    emitProgress?.(id, link, "fetching");
    let data;
    if (link.startsWith("file://")) {
      const localFilePath = link.replace(/^file:\/\//, "");
      const content = fs.readFileSync(localFilePath, "utf8");

      const scriptMatch = content.match(/<script[^>]*class="battle-log-data"[^>]*>([\s\S]*?)<\/script>/i);
      if (!scriptMatch) {
        throw new Error("Invalid local HTML: Missing battle-log-data script element");
      }

      const logText = scriptMatch[1].trim();

      let format = "Unknown Format";
      const tierMatch = logText.match(/\n\|tier\|([^\n|]+)/) || logText.match(/\n\|format\|([^\n|]+)/);
      if (tierMatch) format = tierMatch[1].trim();

      let p1 = "Player 1";
      let p2 = "Player 2";
      const p1Match = logText.match(/\n\|player\|p1\|([^\n|]+)/);
      const p2Match = logText.match(/\n\|player\|p2\|([^\n|]+)/);
      if (p1Match) p1 = p1Match[1].trim();
      if (p2Match) p2 = p2Match[1].trim();

      data = {
        players: [p1, p2],
        format: format,
        log: logText
      };
    } else {
      const requestLink = link.split("?")[0].replace(/\/$/, "");
      const response = await fetch(`${requestLink}.json`);
      if (!response.ok)
        throw new Error(`Could not fetch replay data from ${requestLink}.json`);
      data = await response.json();
    }

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
    page = await browser.newPage();
    await page.setViewport({
      width: nochat ? 642 : 1100,
      height: 362,
      deviceScaleFactor: 1,
    });

    await page.goto(link, { waitUntil: "load", timeout: 60000 });

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

        /* For local replays */
        .replay-wrapper { margin: 0 !important; }
        body { padding: 0 !important; }
      `,
    });

    // Remove consent banner and ads proactively to prevent blocking interactions
    await page.evaluate(`(() => {
      document.querySelector(".fc-consent-root")?.remove();
      document.querySelector("#LeaderboardBTF")?.remove();
      // Sometimes the banner has a backdrop that blocks clicks
      const backdrop = document.querySelector(".fc-ab-root");
      if (backdrop) backdrop.remove();
    })()`);

    emitProgress?.(id, link, "preparing");
    await page.waitForSelector(".playbutton");

    // Apply User Preferences
    const isLocal = link.startsWith("file://");
    await page.evaluate(`(({ isLocal, speed, nomusic, noaudio, theme }) => {
      if (isLocal) {
        // 1. Playback Speed
        if (speed !== "normal") {
          const speedBtn = document.querySelector(\`.speedchooser button[value="\${speed}"]\`) || 
                           document.querySelector(\`button[value="\${speed}"]\`);
          if (speedBtn) speedBtn.click();
        }

        // 2. Sound Settings (Only supports "on" / "off" buttons under soundchooser)
        if (nomusic || noaudio) {
          const muteBtn = document.querySelector(\`.soundchooser button[value="off"]\`) || 
                          document.querySelector(\`button[value="off"]\`);
          if (muteBtn) muteBtn.click();
        } else {
          const unmuteBtn = document.querySelector(\`.soundchooser button[value="on"]\`) || 
                            document.querySelector(\`button[value="on"]\`);
          if (unmuteBtn) unmuteBtn.click();
        }

        // 3. Visual Theme
        if (theme !== "auto") {
          const themeBtn = document.querySelector(\`.colorchooser button[value="\${theme}"]\`) || 
                           document.querySelector(\`button[value="\${theme}"]\`);
          if (themeBtn) themeBtn.click();
        }
      } else {
        const setSelect = (selector, value) => {
          const selectEl = document.querySelector(selector);
          if (selectEl) {
            selectEl.value = value;
            selectEl.dispatchEvent(new Event("change", { bubbles: true }));
            return true;
          }
          return false;
        };

        if (speed !== "normal") setSelect('select[name="speed"]', speed);
        if (nomusic) setSelect('select[name="sound"]', "musicoff");
        else if (noaudio) setSelect('select[name="sound"]', "off");
        if (theme !== "auto") setSelect('select[name="darkmode"]', theme);
      }
    })(${JSON.stringify({ isLocal, speed, nomusic, noaudio, theme })})`);

    // Final check for blocker right before click
    await page.evaluate(`(() => document.querySelector(".fc-consent-root")?.remove())()`);

    // Wait for network idle to ensure all sprites/GIFs are fully fetched before starting
    try {
      await page.waitForNetworkIdle({ idleTime: 500, timeout: 10000 });
    } catch (err) {
      // Proceed even if some tracker/ad hangs the network
    }

    await page.click(".playbutton");


    // 4. Start Streaming
    file = fs.createWriteStream(finalPath);
    stream = await getStream(page, {
      audio: true,
      video: true,
      mimeType: "video/mp4;codecs=avc1,mp4a.40.2",
    });

    try {
      await page.click('button[name="play"]');
    } catch (err) {
      // Ignore if play button selector does not exist or is named differently in offline HTML
      if (!isLocal) {
        throw err;
      }
    }
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

    await new Promise((resolve) => setTimeout(resolve, 3000)); // Buffer for animations and encoder flushing
    if (signal?.aborted) throw new Error("Recording cancelled.");

    // 6. Cleanup Stream
    if (stream) {
      stream.unpipe(file);
      stream.destroy();
    }
    if (file) {
      file.end();
      await new Promise((resolve) => file.on("finish", resolve));
    }

    // 7. Verify Integrity
    const stats = fs.statSync(finalPath);
    if (stats.size < 1000)
      throw new Error(`Stream capture failed (empty file).`);

    emitLog?.(`✅ Saved: replay-${fileId}.mp4`, "success");
    emitProgress?.(id, link, "done", {
      filename: `replay-${fileId}.mp4`,
      players: playersLabel,
    });
  } catch (err) {
    if (stream) {
      try {
        stream.unpipe(file);
        stream.destroy();
      } catch {}
    }
    if (file) {
      try {
        file.end();
      } catch {}
    }

    try {
      if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
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
  } finally {
    if (page) {
      try {
        await page.close();
      } catch {}
    }
  }

}
module.exports = {
  download,
  waitUntilVictory,
};
