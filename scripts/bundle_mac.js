const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

/**
 * CONFIGURATION
 */
const APP_NAME = "Showdown Replay Studio";
const BINARY_NAME = "showdown-studio-mac";
const DIST_DIR = path.join(__dirname, "..", "dist");
const APP_BUNDLE = path.join(DIST_DIR, `${APP_NAME}.app`);
const CONTENTS_DIR = path.join(APP_BUNDLE, "Contents");
const MAC_OS_DIR = path.join(CONTENTS_DIR, "MacOS");
const RESOURCES_DIR = path.join(CONTENTS_DIR, "Resources");

const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>${BINARY_NAME}</string>
    <key>CFBundleIdentifier</key>
    <string>com.intenzi.showdownreplaystudio</string>
    <key>CFBundleName</key>
    <string>${APP_NAME}</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>1.1.0</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>LSMinimumSystemVersion</key>
    <string>10.13.0</string>
</dict>
</plist>`;

console.log("🚀 Starting Apple App Bundle creation...");

// 1. Initial Validation
const binaryPath = path.join(DIST_DIR, BINARY_NAME);
if (!fs.existsSync(binaryPath)) {
  console.error(`❌ Binary not found at ${binaryPath}. Run 'npm run build:mac' first.`);
  process.exit(1);
}

// 2. Prepare Directory Structure
if (fs.existsSync(APP_BUNDLE)) fs.rmSync(APP_BUNDLE, { recursive: true, force: true });
fs.mkdirSync(MAC_OS_DIR, { recursive: true });
fs.mkdirSync(RESOURCES_DIR, { recursive: true });

// 3. Deploy Binary & Metadata
console.log("📦 Packaging binary...");
fs.renameSync(binaryPath, path.join(MAC_OS_DIR, BINARY_NAME));
fs.chmodSync(path.join(MAC_OS_DIR, BINARY_NAME), 0o755);
fs.writeFileSync(path.join(CONTENTS_DIR, "Info.plist"), PLIST);

// 4. Bundle Required Dependencies
const chromiumSrc = path.join(__dirname, "..", "chromium");
const extensionSrc = path.join(__dirname, "..", "node_modules", "puppeteer-stream", "extension");
const ublockSrc = path.join(__dirname, "..", "extensions");

// Extension
if (fs.existsSync(extensionSrc)) {
  console.log("🧩 Bundling puppeteer-stream extension...");
  try {
    fs.cpSync(extensionSrc, path.join(MAC_OS_DIR, "extension"), { recursive: true });
  } catch (e) {
    console.warn("⚠️ Failed to bundle extension:", e.message);
  }
}

// UBlock & other extensions
if (fs.existsSync(ublockSrc)) {
  console.log("🧩 Bundling custom extensions...");
  try {
    fs.cpSync(ublockSrc, path.join(MAC_OS_DIR, "extensions"), { recursive: true });
  } catch (e) {
    console.warn("⚠️ Failed to bundle custom extensions:", e.message);
  }
}

// Chromium
if (fs.existsSync(chromiumSrc)) {
  console.log("🌐 Bundling local Chromium instance...");
  try {
    fs.cpSync(chromiumSrc, path.join(MAC_OS_DIR, "chromium"), { recursive: true });
  } catch (e) {
    console.error("❌ Failed to bundle Chromium:", e.message);
  }
} else {
  console.log("🔍 Local 'chromium' folder missing. Attempting to locate system Puppeteer browser...");
  try {
    const puppeteerPath = require("puppeteer").executablePath();
    if (puppeteerPath && fs.existsSync(puppeteerPath)) {
      const parts = puppeteerPath.split(".app/");
      if (parts.length > 1) {
        const appRoot = parts[0] + ".app";
        console.log(`🚀 Found Puppeteer browser: ${appRoot}`);
        const dest = path.join(MAC_OS_DIR, "chromium");
        fs.cpSync(appRoot, dest, { recursive: true });
      }
    }
  } catch (err) {
    console.warn("⚠️ Could not automatically bundle a browser.");
  }
}

// FFmpeg
try {
  const ffmpegSrc = require("ffmpeg-static");
  const ffmpegDest = path.join(MAC_OS_DIR, "ffmpeg");
  if (ffmpegSrc && fs.existsSync(ffmpegSrc)) {
    console.log("🎞️ Bundling FFmpeg binary...");
    fs.copyFileSync(ffmpegSrc, ffmpegDest);
    fs.chmodSync(ffmpegDest, 0o755);
  }
} catch (err) {
  console.warn("⚠️ FFmpeg binary not found in ffmpeg-static.");
}

console.log(`\n🎉 Success! App created at: ${APP_BUNDLE}`);
console.log(`👉 Zip and distribute the folder.`);
