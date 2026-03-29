const { getStream } = require("puppeteer-stream");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const fs = require("fs");
const path = require("path");

const generateRandom = () =>
  Math.random().toString(36).substring(2, 15) +
  Math.random().toString(36).substring(2, 5); // simplistic simple https://stackoverflow.com/a/71262982/14393614

ffmpeg.setFfmpegPath(ffmpegPath); // bundled ffmpeg, no separate install needed

async function waitUntilVictory(timeout, page) {
  return Promise.race([
    checkForVictory(page),
    new Promise((_, reject) => setTimeout(reject, timeout)),
  ]);
}

async function checkForVictory(page) {
  // Use a loop instead of recursion to avoid call stack issues on long battles
  while (true) {
    try {
      let victory = await page.$$eval('div[class="battle-history"]', (els) =>
        els.map((e) => e.textContent),
      );
      victory = victory[victory.length - 1].endsWith(" won the battle!");
      if (victory) return;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

async function download(link, browser, config, emitLog, emitProgress) {
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
  const totalTurns = parseInt(matches[matches.length - 1][1]);
  const fileId = generateRandom();

  try {
    fs.mkdirSync(outputFolder, { recursive: true });
    const file = fs.createWriteStream(
      path.join(outputFolder, `replay-${fileId}-temp.webm`),
    );
    const page = await browser.newPage();
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
    const logMsg = `⚔️  Recording ${data.p1} vs ${data.p2} (${data.format}) — ${totalTurns} turns, ~${estimate}min`;
    if (emitLog) emitLog(logMsg, "info");
    else console.log(logMsg); // the estimate is based upon my observation for "normal" speed replays

    if (emitProgress) emitProgress(link, "recording");

    // Start checking for victory, upto 5 minutes (aka record time limit)
    // You might want to modify this for super long videos as with endless battle clause, a battle can last upto 1000 turns which is approx 1 hour and 56 minutes at normal speed
    try {
      await waitUntilVictory(150000, page);
    } catch {}

    // Wait for 2 seconds so that the battle has completely ended as we read the text earlier than it getting fully animated
    await new Promise((resolve) => setTimeout(resolve, 1500));

    stream.destroy();
    file.close();

    const fixMsg = `🎬 Fixing metadata for ${data.p1} vs ${data.p2}...`;
    if (emitLog) emitLog(fixMsg, "info");
    else console.log(`Finished recording ${link}`);

    await fixwebm(fileId, outputFolder); // metadata needs to be added for seeking video

    const saveMsg = `✅ Saved → ${path.join(outputFolder, `replay-${fileId}.webm`)}`;
    if (emitLog) {
      emitLog(saveMsg, "success");
      emitProgress(link, "done");
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
      emitProgress(link, "error");
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
  checkForVictory,
  fixwebm,
};
