const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

/**
 * CONFIGURATION
 */
const BINARY_NAME = "showdown-studio-linux";
const DIST_DIR = path.join(__dirname, "..", "dist");
const LINUX_PORTABLE_DIR = path.join(DIST_DIR, "showdown-replay-studio-linux");

console.log("🚀 Starting Linux Portable Bundle creation...");

// 1. Initial Validation
const binaryPath = path.join(DIST_DIR, BINARY_NAME);
if (!fs.existsSync(binaryPath)) {
  console.error(`❌ Binary not found at ${binaryPath}. Run 'npm run build:linux' first.`);
  process.exit(1);
}

// 2. Prepare Directory Structure
if (fs.existsSync(LINUX_PORTABLE_DIR)) {
  console.log("🧹 Cleaning old bundle...");
  fs.rmSync(LINUX_PORTABLE_DIR, { recursive: true, force: true });
}
const RESOURCES_DIR = path.join(LINUX_PORTABLE_DIR, "resources");
fs.mkdirSync(LINUX_PORTABLE_DIR, { recursive: true });
fs.mkdirSync(RESOURCES_DIR, { recursive: true });

// 3. Copy Binary
console.log("📦 Copying executable...");
const destBinary = path.join(LINUX_PORTABLE_DIR, "showdown-replay-studio");
fs.copyFileSync(binaryPath, destBinary);
fs.chmodSync(destBinary, 0o755);

// 4. Bundle Required Dependencies
const chromiumSrc = path.join(__dirname, "..", "chromium");
const extensionSrc = path.join(__dirname, "..", "node_modules", "puppeteer-stream", "extension");

// Extension
if (fs.existsSync(extensionSrc)) {
  console.log("🧩 Bundling puppeteer-stream extension...");
  const dest = path.join(RESOURCES_DIR, "extension");
  try {
    fs.cpSync(extensionSrc, dest, { recursive: true });
  } catch (e) {
    console.warn("⚠️ Failed to bundle extension:", e.message);
  }
}

// Chromium
const chromiumDest = path.join(RESOURCES_DIR, "chromium");
if (fs.existsSync(chromiumSrc)) {
  console.log("🌐 Bundling local Chromium instance...");
  try {
    fs.cpSync(chromiumSrc, chromiumDest, { recursive: true });
  } catch (e) {
    console.error("❌ Failed to bundle Chromium:", e.message);
  }
} else {
  console.log("🔍 Local 'chromium' folder missing. Attempting to locate Puppeteer's Chromium...");
  try {
    const puppeteerPath = require("puppeteer").executablePath();
    if (puppeteerPath && fs.existsSync(puppeteerPath)) {
      const chromeDir = path.dirname(puppeteerPath);
      console.log(`🚀 Found Puppeteer browser at: ${chromeDir}`);
      fs.cpSync(chromeDir, chromiumDest, { recursive: true });
    }
  } catch (err) {
    console.warn("⚠️ Could not automatically bundle a browser.");
  }
}

// FFmpeg
try {
  let ffmpegSrc = null;
  try {
    ffmpegSrc = require("ffmpeg-static");
  } catch {}

  const ffmpegDest = path.join(RESOURCES_DIR, "ffmpeg");
  if (ffmpegSrc && fs.existsSync(ffmpegSrc)) {
    console.log("🎞️ Bundling FFmpeg binary...");
    fs.copyFileSync(ffmpegSrc, ffmpegDest);
    fs.chmodSync(ffmpegDest, 0o755);
  }
} catch (err) {
  console.warn("⚠️ FFmpeg binary not found.");
}

console.log(`\n🎉 Success! Linux Portable Bundle created at: ${LINUX_PORTABLE_DIR}`);
console.log(`👉 Tar and distribute the folder.`);
