const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

/**
 * CONFIGURATION
 */
const BINARY_NAME = "showdown-studio-win.exe";
const DIST_DIR = path.join(__dirname, "..", "dist");
const WIN_PORTABLE_DIR = path.join(DIST_DIR, "showdown-replay-studio-win");

console.log("🚀 Starting Windows Portable Bundle creation...");

// 1. Initial Validation
const binaryPath = path.join(DIST_DIR, BINARY_NAME);
if (!fs.existsSync(binaryPath)) {
  console.error(
    `❌ Binary not found at ${binaryPath}. Run 'npm run build:win' first.`,
  );
  process.exit(1);
}

// 2. Prepare Directory Structure
if (fs.existsSync(WIN_PORTABLE_DIR)) {
  console.log("🧹 Cleaning old bundle...");
  fs.rmSync(WIN_PORTABLE_DIR, { recursive: true, force: true });
}
const RESOURCES_DIR = path.join(WIN_PORTABLE_DIR, "resources");
fs.mkdirSync(WIN_PORTABLE_DIR, { recursive: true });
fs.mkdirSync(RESOURCES_DIR, { recursive: true });

// 3. Copy Binary
console.log("📦 Copying executable...");
fs.copyFileSync(
  binaryPath,
  path.join(WIN_PORTABLE_DIR, "Showdown Replay Studio.exe"),
);

// 4. Bundle Required Dependencies
const chromiumSrc = path.join(__dirname, "..", "chromium");
const extensionSrc = path.join(
  __dirname,
  "..",
  "node_modules",
  "puppeteer-stream",
  "extension",
);

// Extension
if (fs.existsSync(extensionSrc)) {
  console.log("🧩 Bundling puppeteer-stream extension...");
  const dest = path.join(RESOURCES_DIR, "extension");
  fs.mkdirSync(dest, { recursive: true });

  if (process.platform === "win32") {
    execSync(`xcopy /S /E /I /Y "${extensionSrc}" "${dest}"`);
  } else {
    execSync(`cp -R "${extensionSrc}/" "${dest}/"`);
  }
}

// Chromium
const chromiumDest = path.join(RESOURCES_DIR, "chromium");
if (fs.existsSync(chromiumSrc)) {
  console.log("🌐 Bundling local Chromium instance...");
  fs.mkdirSync(chromiumDest, { recursive: true });
  if (process.platform === "win32") {
    execSync(`xcopy /S /E /I /Y "${chromiumSrc}" "${chromiumDest}"`);
  } else {
    execSync(`cp -R "${chromiumSrc}/" "${chromiumDest}/"`);
  }
} else {
  console.log(
    "🔍 Local 'chromium' folder missing. Attempting to locate Puppeteer's Chromium...",
  );
  try {
    // Require Puppeteer directly in the current process to avoid stdout pollution
    const puppeteerPath = require("puppeteer").executablePath();

    if (puppeteerPath && fs.existsSync(puppeteerPath)) {
      const chromeDir = path.dirname(puppeteerPath);
      console.log(`🚀 Found Puppeteer browser at: ${chromeDir}`);

      fs.mkdirSync(chromiumDest, { recursive: true });
      if (process.platform === "win32") {
        execSync(`xcopy /S /E /I /Y "${chromeDir}" "${chromiumDest}"`);
      } else {
        execSync(`cp -R "${chromeDir}/" "${chromiumDest}/"`);
      }
    } else {
      console.warn(
        "⚠️ Path found, but the file doesn't exist at:",
        puppeteerPath,
      );
    }
  } catch (err) {
    console.warn(
      "⚠️ Could not automatically bundle a browser. Is puppeteer installed?",
    );
  }
}

// FFmpeg
try {
  let ffmpegSrc = null;
  try {
    ffmpegSrc = require("ffmpeg-static");
  } catch {}

  const ffmpegDest = path.join(RESOURCES_DIR, "ffmpeg.exe");
  if (ffmpegSrc && fs.existsSync(ffmpegSrc)) {
    console.log("🎞️ Bundling FFmpeg binary...");
    fs.copyFileSync(ffmpegSrc, ffmpegDest);
  } else {
    // Try to find it in the project root if it was downloaded manually
    const rootFfmpeg = path.join(__dirname, "..", "ffmpeg.exe");
    if (fs.existsSync(rootFfmpeg)) {
      fs.copyFileSync(rootFfmpeg, ffmpegDest);
    }
  }
} catch (err) {
  console.warn("⚠️ FFmpeg binary not found.");
}

console.log(
  `\n🎉 Success! Windows Portable Bundle created at: ${WIN_PORTABLE_DIR}`,
);
console.log(`👉 Zip the folder and share it.`);
