const { getStream } = require("puppeteer-stream");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const fs = require("fs");
const path = require("path");

const generateRandom = () =>
  Math.random().toString(36).substring(2, 15) +
  Math.random().toString(36).substring(2, 5); // simplistic simple https://stackoverflow.com/a/71262982/14393614

ffmpeg.setFfmpegPath(ffmpegPath); // bundled ffmpeg, no separate install needed

async function waitUntilVictory(timeout, page, onProgress) {
  // Safety timeout: stop the loop if the battle doesn't end within the specified time (e.g., page hang)
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    try {
      // Direct extraction of the turn number from the field overlay (more efficient than scanning the log)
      const turnNumber = await page.evaluate(() => {
        const turnDiv = document.querySelector(".innerbattle .turn");
        if (turnDiv) {
          // Text is typically "Turn 1", "Turn 2", etc.
          return parseInt(turnDiv.innerText.replace("Turn ", "")) || 0;
        }
        return 0;
      });

      const victory = await page.evaluate(() => {
        const els = document.querySelectorAll("div.battle-history");
        if (els.length === 0) return false;
        const lastLog = els[els.length - 1].textContent;
        return lastLog.endsWith(" won the battle!");
      });

      if (onProgress) onProgress(turnNumber);
      if (victory) return;
    } catch (err) {
      console.error("Error in waitUntilVictory loop:", err);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function download(link, id, browser, config, emitLog, emitProgress) {
  const { nochat, nomusic, noaudio, theme, speed, outputFolder } = config;

  if (
    !(
      link.startsWith("https://replay.pokemonshowdown.com/") ||
      link.startsWith("http://replay.pokemonshowdown.com/")
    ) &&
    !(link.endsWith(".json") || link.endsWith(".log"))
  ) {
    if (emitLog) emitLog(`❌ Invalid link: ${link}`, "error");
    else console.log(`Invalid link: ${link}`);
    return;
  }

  const requestLink = link.split("?")[0]; // player viewpoint arg might exist
  const response = await fetch(requestLink + ".json");
  if (!response.ok) {
    const errorMsg = `❌ Unable to fetch replay. Ensure ${requestLink} is a valid showdown replay.`;
    if (emitLog) emitLog(errorMsg, "error");
    else console.log(errorMsg);
    return;
  }

  const data = await response.json();
  const matches = Array.from(data.log.matchAll(/\n\|turn\|(\d+)\n/g));
  const totalTurns =
    matches.length > 0 ? parseInt(matches[matches.length - 1][1]) : 0;
  const fileId = generateRandom();

  try {
    fs.mkdirSync(outputFolder, { recursive: true });
    const file = fs.createWriteStream(
      path.join(outputFolder, `replay-${fileId}-temp.webm`),
    );
    const page = await browser.newPage();

    // Set viewport explicitly to match intended recording dimensions
    // This prevents the default 800x600 viewport from clipping the chat
    await page.setViewport({
      width: nochat ? 642 : 1100,
      height: 362,
      deviceScaleFactor: 1,
    });

    await page.goto(link, { waitUntil: "load" });

    await page.addStyleTag({
      content: `
                header { display: none !important; }
                .bar-wrapper { margin: 0 0 !important; }
                .battle {
                    top: 0px !important;
                    left: 0px !important;
                    ${nochat ? "margin: 0 !important;" : ""}
                }
                .battle-log {
                    top: 0px !important;
                    left: 641px !important;
                    ${nochat ? "display: none !important;" : ""}
                }
                `,
    });

    await page.waitForSelector(".playbutton");

    // Customization
    // Default: music: yes, audio: yes, video: yes (why would anyone want to not record video..), speed: normal, color scheme: automatic, recordChat: yes
    // Example for if you want your replay speed to be changed dynamically per individual video on total turns basis:-
    // if (totalTurns > 20) speed = "fast"
    if (speed !== "normal") await page.select('select[name="speed"]', speed);

    if (nomusic) await page.select('select[name="sound"]', "musicoff");
    else if (noaudio) await page.select('select[name="sound"]', "off");

    // Theme
    if (theme !== "auto") await page.select('select[name="darkmode"]', theme);

    // customization done, now remove scrollbar by making below elements invisible
    await page.addStyleTag({
      content: `
                .replay-controls { display: none !important; }
                #LeaderboardBTF { display: none !important; }
                `,
    });

    const stream = await getStream(page, {
      audio: !noaudio, // no longer a necessity, can be left as true
      video: true,
    });

    await page.click('button[name="play"]');
    stream.pipe(file);

    const estimate = ((totalTurns * 7) / 60).toFixed(2);
    const playersLabel = data.players
      ? data.players.join(" vs ")
      : "Unknown Battle";
    const logMsg = `⚔️  Recording ${playersLabel} (${data.format}) — ${totalTurns} turns, ~${estimate}min`;
    if (emitLog) emitLog(logMsg, "info");
    else console.log(logMsg);

    const onProgress = (currentTurn) => {
      if (emitProgress) {
        // Calculate progress percentage, capped at 99% until fully done
        const progress =
          totalTurns > 0
            ? Math.min(Math.floor((currentTurn / totalTurns) * 100), 99)
            : 0;

        emitProgress(id, link, "recording", {
          players: playersLabel,
          format: data.format,
          currentTurn,
          totalTurns,
          progress: Math.max(progress, 10), // Start at 10%
          speed: speed || "normal",
        });
      }
    };

    // Initial progress report
    onProgress(0);

    // Start checking for victory, up to 10 minutes (some matches can be long)
    try {
      await waitUntilVictory(600000, page, onProgress);
    } catch {}

    // Wait for 2 seconds so that the battle has completely ended as we read the text earlier than it getting fully animated
    await new Promise((resolve) => setTimeout(resolve, 1500));

    stream.destroy();
    file.end();
    await new Promise((resolve) => file.on("finish", resolve));

    const fixMsg = `🎬 Fixing metadata for ${playersLabel}...`;
    if (emitLog) emitLog(fixMsg, "info");
    else console.log(`Finished recording ${link}`);

    await fixwebm(fileId, outputFolder); // metadata needs to be added for seeking video

    const saveMsg = `✅ Saved → ${path.join(outputFolder, `replay-${fileId}.webm`)}`;
    if (emitLog) {
      emitLog(saveMsg, "success");
      emitProgress(id, link, "done", { filename: `replay-${fileId}.webm` });
    } else {
      console.log(
        `Recording Saved!\nLocation -> ${path.join(outputFolder, `replay-${fileId}.webm`)}`,
      );
    }

    try {
      fs.unlinkSync(path.join(outputFolder, `replay-${fileId}-temp.webm`));
    } catch {}

    try {
      await page.close();
    } catch (error) {
      console.log(error);
    }
  } catch (err) {
    try {
      fs.unlinkSync(path.join(outputFolder, `replay-${fileId}-temp.webm`));
    } catch {}
    if (emitLog) {
      emitLog(`❌ Error recording ${link}\n${err}`, "error");
      emitProgress(id, link, "error");
    } else {
      console.log(`An error occured while downloading ${link}\n` + err);
    }
  }
}

// Updated fixwebm to use outputFolder
async function fixwebm(fileId, outputFolder) {
  return new Promise((resolve, reject) => {
    const command = ffmpeg(
      path.join(outputFolder, `replay-${fileId}-temp.webm`),
    )
      .withVideoCodec("copy")
      .withAudioCodec("copy") // Copy the video and audio streams without re-encoding
      .output(path.join(outputFolder, `replay-${fileId}.webm`))
      .on("end", resolve)
      .on("error", (err) => {
        console.error("Error fixing metadata:", err);
        reject(err);
      });

    command.run();
  });
}

module.exports = {
  download,
  waitUntilVictory,
  fixwebm,
};
