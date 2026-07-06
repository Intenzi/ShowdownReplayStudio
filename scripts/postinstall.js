const { execSync } = require("child_process");

if (process.platform === "linux") {
  console.log("🐧 Linux OS detected. Installing Linux-only FFmpeg dependencies...");
  try {
    // Install ffmpeg-static and fluent-ffmpeg without modifying package.json or package-lock.json
    execSync("npm install --no-save ffmpeg-static fluent-ffmpeg", { stdio: "inherit" });
    console.log("✅ Linux-only FFmpeg dependencies installed successfully.");
  } catch (err) {
    console.error("❌ Failed to install Linux FFmpeg dependencies:", err.message);
  }
} else {
  console.log("💻 Non-Linux platform detected. Skipping FFmpeg dependency installation to keep node_modules clean.");
}
