const { getStream } = require("puppeteer-stream");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const fs = require("fs");
const path = require("path");

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

// Create a FFmpeg command to fix the metadata
async function fixwebm(fileId) {
  return new Promise((resolve, reject) => {
    const command = ffmpeg(`./replays/replay-${fileId}-temp.webm`)
      .withVideoCodec("copy")
      .withAudioCodec("copy") // Copy the video and audio streams without re-encoding
      .output(`./replays/replay-${fileId}.webm`)
      .on("end", () => {
        resolve();
      })
      .on("error", (err) => {
        console.error("Error fixing metadata:", err);
        reject(err);
      });

    command.run();
  });
}

const generateRandom = () =>
  Math.random().toString(36).substring(2, 15) +
  Math.random().toString(36).substring(2, 5); // simplistic simple https://stackoverflow.com/a/71262982/14393614

async function download(link, browser, nochat, nomusic, noaudio, theme, speed) {
  if (
    !(
      link.startsWith("https://replay.pokemonshowdown.com/") ||
      link.startsWith("http://replay.pokemonshowdown.com/")
    ) &&
    !(link.endsWith(".json") || link.endsWith(".log"))
  )
    return console.log(`Invalid link: ${link}`);

  const requestLink = link.split("?")[0]; // player viewpoint arg might exist
  const response = await fetch(requestLink + ".json");
  if (!response.ok) {
    console.log(
      `Unable to join the url. Please ensure ${requestLink} is a valid showdown replay.`,
    );
    return;
  }
  const data = await response.json();
  const matches = Array.from(data.log.matchAll(/\n\|turn\|(\d+)\n/g));
  const totalTurns = parseInt(matches[matches.length - 1][1]);
  const fileId = generateRandom();
  try {
    const file = fs.createWriteStream(`./replays/replay-${fileId}-temp.webm`);
    const page = await browser.newPage();
    await page.goto(link, {
      waitUntil: "load",
    });
    await page.addStyleTag({
      content: `
                header {
                    display: none !important;
                }
                .bar-wrapper {
                    margin: 0 0 !important;
                }
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
                .replay-controls {
                    display: none !important;
                }
                #LeaderboardBTF {
                    display: none !important;
                }
                `,
    });
    const stream = await getStream(page, {
      audio: !noaudio, // no longer a necessity, can be left as true
      video: true,
    });
    await page.click('button[name="play"]');
    stream.pipe(file);

    console.log(
      `Opened replay ${data.p1} vs ${data.p2} (${
        data.format
      })\nSaving Replay..  (this may take a while.. preferably not more than ${(
        (totalTurns * 7) /
        60
      ).toFixed(2)} minutes)\n[*estimates are calced at normal speed*]`,
    ); // the estimate is based upon my observation for "normal" speed replays

    // Start checking for victory, upto 5 minutes (aka record time limit)
    // You might want to modify this for super long videos as with endless battle clause, a battle can last upto 1000 turns which is approx 1 hour and 56 minutes at normal speed
    try {
      await waitUntilVictory(150000, page);
    } catch {}
    // Wait for 2 seconds so that the battle has completely ended as we read the text earlier than it getting fully animated
    await new Promise((resolve) => setTimeout(resolve, 1500));

    stream.destroy();
    file.close();

    console.log(`Finished recording ${link}`);
    await fixwebm(fileId); // metadata needs to be added for seeking video
    console.log(`Recording Saved!\nLocation -> replays/replay-${fileId}.webm`);
    try {
      fs.unlinkSync(`./replays/replay-${fileId}-temp.webm`);
    } catch {}

    try {
      await page.close();
    } catch (error) {
      console.log(error);
    }
  } catch (err) {
    try {
      fs.unlinkSync(`./replays/replay-${fileId}-temp.webm`);
    } catch {}
    console.log(`An error occured while downloading ${link}\n` + err);
  }
}

module.exports = {
  download,
  waitUntilVictory,
  checkForVictory,
  fixwebm,
};
