const socket = (typeof io !== 'undefined') ? io() : { on: () => {}, emit: () => {} };
let config = {};
let setupDone = false;
let isRecording = false;
let recordingData = {}; // Track state of each recording
let audioMode = "all";
let chatMode = "hide";

/**
 * Application State Management
 */
async function init() {
  try {
    // Fetch initial config
    const res = await fetch("/api/config");
    config = await res.json();
    applyConfig(config);

    // Check version
    const vRes = await fetch("/api/version");
    const vData = await vRes.json();
    const badge = document.getElementById("versionBadge");
    const sourceBtn = document.getElementById("sourceRepo");
    const updateBtn = document.getElementById("updateBanner");

    if (badge) badge.textContent = `v${vData.current}`;

    if (vData.update) {
      if (sourceBtn) sourceBtn.classList.remove("visible");
      if (updateBtn) {
        updateBtn.classList.add("visible");
        updateBtn.href = vData.update.url;
      }
    } else {
      if (sourceBtn) sourceBtn.classList.add("visible");
      if (updateBtn) updateBtn.classList.remove("visible");
    }

    // Check initial status
    const sRes = await fetch("/api/status");
    const sData = await sRes.json();
    updateStatus(sData);

    if (!sData.ready) {
      const overlay = document.getElementById("setupOverlay");
      if (overlay) overlay.classList.remove("hidden");
    } else {
      setupDone = true;
    }
  } catch (err) {
    console.error("Initialization failed:", err);
  }
}

function applyConfig(cfg) {
  const speed = document.getElementById("speed");
  const theme = document.getElementById("theme");
  const bulk = document.getElementById("bulk");
  const folderPath = document.getElementById("folderPath");
  const setupFolderPath = document.getElementById("setupFolderPath");

  if (speed) speed.value = cfg.speed;
  if (theme) theme.value = cfg.theme;
  if (bulk) bulk.value = cfg.bulk;
  if (folderPath)
    folderPath.textContent = cfg.outputFolder || "No folder selected";
  if (setupFolderPath)
    setupFolderPath.textContent = cfg.outputFolder || "No folder selected";

  // Preferences
  if (cfg.noaudio) setAudio("noaudio");
  else if (cfg.nomusic) setAudio("nomusic");
  else setAudio("all");

  setChat(cfg.nochat ? "hide" : "show");
}

function updateStatus(status) {
  const dot = document.getElementById("statusDot");
  const text = document.getElementById("statusText");
  const btn = document.getElementById("btnRecord");

  if (status.recording) {
    if (dot) dot.className = "status-dot recording";
    if (text) text.textContent = "Recording Replays...";
    isRecording = true;
  } else if (status.ready) {
    if (dot) dot.className = "status-dot ready";
    if (text) text.textContent = "Ready";
    if (btn) btn.disabled = false;
    isRecording = false;
    setupDone = true;
    const overlay = document.getElementById("setupOverlay");
    if (overlay) overlay.classList.add("hidden");
  } else {
    if (dot) dot.className = "status-dot";
    if (text) text.textContent = "Setup Required";
    if (btn) btn.disabled = true;
    isRecording = false;
  }
}

/**
 * UI Actions
 */
function setAudio(mode) {
  audioMode = mode;
  document.querySelectorAll("#audioSelector .segment").forEach((seg) => {
    seg.classList.toggle("active", seg.id === `segment-audio-${mode}`);
  });
  updateConfig();
}

function setChat(mode) {
  chatMode = mode;
  document.querySelectorAll("#chatSelector .segment").forEach((seg) => {
    seg.classList.toggle("active", seg.id === `segment-chat-${mode}`);
  });
  updateConfig();
}

function updateConfig() {
  const newConfig = {
    speed: document.getElementById("speed")?.value,
    theme: document.getElementById("theme")?.value,
    bulk: document.getElementById("bulk")?.value,
    nomusic: audioMode === "nomusic",
    noaudio: audioMode === "noaudio",
    nochat: chatMode === "hide",
  };

  fetch("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(newConfig),
  });
}

async function pickFolder(context = "sidebar") {
  const res = await fetch("/api/pick-folder", { method: "POST" });
  const data = await res.json();
  if (data.folder) {
    config.outputFolder = data.folder;
    const pathDisplay = document.getElementById("folderPath");
    const setupPathDisplay = document.getElementById("setupFolderPath");
    if (pathDisplay) pathDisplay.textContent = data.folder;
    if (setupPathDisplay) setupPathDisplay.textContent = data.folder;
  }
}

function openOutputFolder() {
  fetch("/api/open-folder", { method: "POST" });
}

async function quitApp() {
  if (confirm("Are you sure you want to quit Showdown Replay Studio? This will stop all active and queued recordings.")) {
    const btn = document.getElementById("btnQuit");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Shutting down...";
    }
    
    try {
      await fetch("/api/quit", { method: "POST" });
      document.body.innerHTML = `
        <div style="height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; background: #0f1115; color: #f8fafc; font-family: sans-serif; text-align: center; padding: 20px;">
          <h1 style="color: #ff7e4d; margin-bottom: 20px;">App Shutdown</h1>
          <p>The Showdown Replay Studio background service has been stopped.</p>
          <p style="margin-top: 10px; color: #94a3b8;">You can now close this browser tab.</p>
        </div>
      `;
    } catch {
      // If server dies before response, just show the message
      window.close();
    }
  }
}

function startSetup() {
  const btn = document.getElementById("btnSetup");
  const setupLog = document.getElementById("setupLog");
  if (btn) btn.disabled = true;

  const steps = ["step1", "step2", "step3"];
  let currentStep = 0;

  const processStep = () => {
    if (currentStep >= steps.length) {
      if (setupLog) setupLog.textContent = "Finalizing configuration...";
      socket.emit("setup");
      return;
    }

    const stepId = steps[currentStep];
    const el = document.getElementById(stepId);
    if (el) el.classList.add("active");

    if (setupLog) {
      const labels = [
        "Validating output directory...",
        "Verifying Chromium instance...",
        "Checking FFmpeg binaries...",
      ];
      setupLog.textContent = labels[currentStep];
    }

    setTimeout(() => {
      if (el) {
        el.classList.remove("active");
        el.classList.add("done");
      }
      currentStep++;
      processStep();
    }, 800 + Math.random() * 700);
  };

  processStep();
}

function startRecording() {
  const input = document.getElementById("links");
  const linksText = input?.value.trim();
  if (!linksText) return;

  const links = linksText.split(/[\s,]+/).filter(Boolean);
  const recordConfig = {
    speed: document.getElementById("speed")?.value,
    theme: document.getElementById("theme")?.value,
    bulk: document.getElementById("bulk")?.value,
    nomusic: document.getElementById("nomusic")?.checked,
    noaudio: document.getElementById("noaudio")?.checked,
    nochat: document.getElementById("nochat")?.checked,
  };

  // Clear empty state
  const emptyState = document.getElementById("emptyState");
  if (emptyState) emptyState.style.display = "none";

  const recordings = links.map((link) => {
    const id = Math.random().toString(36).substring(2, 11);
    createRecordingItem(link, id);
    return { link, id };
  });

  socket.emit("record", { recordings, recordConfig });

  // Clear the input field for next batch of recordings
  if (input) input.value = "";
}

function createRecordingItem(link, id) {
  if (document.getElementById(`rec-${id}`)) return;

  const list = document.getElementById("recordingList");
  if (!list) return;

  const item = document.createElement("div");
  item.className = "recording-card";
  item.id = `rec-${id}`;
  item.innerHTML = `
        <div class="rec-info">
            <div class="rec-title">
                <span class="status-badge queued" id="status-${id}">Queued</span>
                <span class="rec-name" id="name-${id}">Fetching metadata...</span>
            </div>
            <div class="rec-subtitle" id="url-${id}">${link}</div>
            <div class="rec-meta-row">
                <span class="rec-subtitle" id="speed-${id}">Speed: —</span>
                <span class="rec-subtitle" id="turns-${id}">Turns: —</span>
                <span class="rec-subtitle hidden" id="file-${id}">Filename: Pending...</span>
            </div>
            <div class="rec-progress-container">
                <div class="progress-bar-bg">
                    <div class="progress-bar-fill" id="progress-${id}"></div>
                </div>
                <div class="progress-stats">
                    <span id="label-${id}">Awaiting recording</span>
                    <span id="percent-${id}">0%</span>
                </div>
            </div>
        </div>
    <div class="rec-actions-container">
            <div id="cancel-container-${id}">
                <button class="btn-cancel" onclick="cancelRecording('${id}')" title="Cancel Recording">Cancel</button>
            </div>
            <button class="btn-close hidden" id="close-${id}" onclick="removeCard('${id}')" title="Remove Card">&times;</button>
            <div class="rec-actions" id="actions-${id}">
                <!-- Actions appear on completion -->
            </div>
        </div>
    `;
  list.prepend(item);
  recordingData[id] = { link, state: "queued" };
}

function cancelRecording(id) {
  socket.emit("cancel-recording", { id });
}

function updateRecordingItem(id, state, meta = {}) {
  const data = recordingData[id];
  if (!data) return;

  const statusBadge = document.getElementById(`status-${id}`);
  const progressFill = document.getElementById(`progress-${id}`);
  const nameLabel = document.getElementById(`name-${id}`);
  const label = document.getElementById(`label-${id}`);
  const percent = document.getElementById(`percent-${id}`);
  const actions = document.getElementById(`actions-${id}`);
  const speedLabel = document.getElementById(`speed-${id}`);
  const turnsLabel = document.getElementById(`turns-${id}`);
  const fileLabel = document.getElementById(`file-${id}`);

  if (meta.players) {
    nameLabel.textContent = `${meta.players}${meta.format ? ` (${meta.format})` : ""}`;
  }
  if (meta.totalTurns && turnsLabel) {
    const current = meta.currentTurn || 0;
    turnsLabel.textContent = `Turns: ${current}/${meta.totalTurns}`;
  }
  if (meta.speed && speedLabel) {
    const capitalized =
      meta.speed.charAt(0).toUpperCase() + meta.speed.slice(1);
    speedLabel.textContent = `Speed: ${capitalized}`;
  }

  // Handle all processing states
  const processingStates = ["starting", "fetching", "setup", "preparing", "finalizing"];
  
  if (processingStates.includes(state)) {
    if (statusBadge) {
      statusBadge.textContent = state.charAt(0).toUpperCase() + state.slice(1);
      statusBadge.className = `status-badge processing ${state}`;
    }
    
    if (label) {
      switch(state) {
        case "starting": label.textContent = "Moving to active queue..."; break;
        case "fetching": label.textContent = "Fetching battle metadata..."; break;
        case "setup": label.textContent = "Initializing browser instance..."; break;
        case "preparing": label.textContent = "Configuring replay options..."; break;
        case "finalizing": label.textContent = "Fixing video metadata (FFmpeg)..."; break;
      }
    }
    
    if (progressFill && state !== "finalizing") progressFill.style.width = "5%";
    if (progressFill && state === "finalizing") progressFill.style.width = "99%";
  } 
  else if (state === "recording") {
    if (statusBadge) {
      statusBadge.textContent = "Recording";
      statusBadge.className = "status-badge recording";
    }
    const val = meta.progress || 10;
    if (progressFill) progressFill.style.width = `${val}%`;
    if (percent) percent.textContent = `${val}%`;
    if (label) label.textContent = "Capturing replay...";
  } else if (state === "done") {
    if (statusBadge) {
      statusBadge.textContent = "Complete";
      statusBadge.className = "status-badge done";
    }
    if (progressFill) progressFill.style.width = "100%";
    if (percent) percent.textContent = "100%";
    if (label) label.textContent = "File saved successfully";
    if (fileLabel) {
      fileLabel.textContent = `Filename: ${meta.filename}`;
      fileLabel.classList.remove("hidden");
    }

    if (actions) {
      actions.innerHTML = `
                <button class="btn-rec-action primary" onclick="viewRecording('${meta.filename}')">View</button>
                <button class="btn-rec-action" onclick="editRecordingName('${id}', '${meta.filename}')">Rename</button>
            `;
    }
  } else if (state === "error") {
    if (statusBadge) {
      statusBadge.textContent = "Error";
      statusBadge.className = "status-badge error";
    }
    if (label) label.textContent = "Failed to record";
    document.getElementById(`cancel-container-${id}`)?.classList.add("hidden");
    document.getElementById(`close-${id}`)?.classList.remove("hidden");
  } else if (state === "cancelled") {
    if (statusBadge) {
      statusBadge.textContent = "Cancelled";
      statusBadge.className = "status-badge error";
    }
    if (label) label.textContent = "Recording aborted.";
    if (progressFill) progressFill.style.backgroundColor = "#94a3b8";
    document.getElementById(`cancel-container-${id}`)?.classList.add("hidden");
    document.getElementById(`close-${id}`)?.classList.remove("hidden");
  }

  // Ensure close button is only shown at the end
  if (state === "done" || state === "error" || state === "cancelled") {
      document.getElementById(`cancel-container-${id}`)?.classList.add("hidden");
      document.getElementById(`close-${id}`)?.classList.remove("hidden");
  }
}

/**
 * Socket.io Event Handlers
 */
socket.on("status", updateStatus);

socket.on("log", (data) => {
  console.log("[Log]", data.msg);
  // Future: implement more granular parsing for UI updates
});

socket.on("progress", (data) => {
  updateRecordingItem(data.id, data.state, data);
});

socket.on("setup-done", () => {
  setupDone = true;
  const overlay = document.getElementById("setupOverlay");
  if (overlay) overlay.classList.add("hidden");

  ["step1", "step2", "step3"].forEach((id) => {
    const step = document.getElementById(id);
    if (step) step.className = "step-item done";
  });
});

/**
 * Workspace Helpers
 */
function removeCard(id) {
  const card = document.getElementById(`rec-${id}`);
  if (card) card.remove();
  delete recordingData[id];
}

function clearAll() {
  const list = document.getElementById("recordingList");
  if (list) {
    list.innerHTML = `
            <div class="empty-state" id="emptyState">
                <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M12 2v20M2 12h20" />
                </svg>
                <p>No active recordings. Paste some links and hit "Start Recording" to begin.</p>
            </div>
        `;
  }
  recordingData = {};
}

function toggleDarkTheme() {
  const body = document.body;
  const current = body.getAttribute("data-theme") || "dark";
  const target = current === "dark" ? "light" : "dark";
  body.setAttribute("data-theme", target);
  document.getElementById("themeToggle").textContent =
    target === "dark" ? "Theme (Dark)" : "Theme (Light)";
}

let lastFocusedElement = null;

function viewRecording(filename) {
  const modal = document.getElementById("videoModal");
  const video = document.getElementById("videoPlayer");
  const container = document.getElementById("modalContainer");

  lastFocusedElement = document.activeElement;

  video.src = `/videos/${filename}`;
  modal.classList.remove("hidden");

  // Accessibility: Focus modal
  container.focus();

  // Scroll to top of modal just in case
  container.scrollTop = 0;
}

function closeVideoModal() {
  const modal = document.getElementById("videoModal");
  const video = document.getElementById("videoPlayer");

  modal.classList.add("hidden");
  video.pause();
  video.removeAttribute("src");
  video.load();

  // Return focus
  if (lastFocusedElement) {
    lastFocusedElement.focus();
  }
}

// Global modal event listeners
document.addEventListener("DOMContentLoaded", () => {
  const modal = document.getElementById("videoModal");
  const closeBtn = document.getElementById("btnCloseModal");

  closeBtn.addEventListener("click", closeVideoModal);

  // Close on backdrop click
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeVideoModal();
  });

  // Close on Escape & Tab Trap
  document.addEventListener("keydown", (e) => {
    if (modal.classList.contains("hidden")) return;

    if (e.key === "Escape") {
      closeVideoModal();
    }

    if (e.key === "Tab") {
      const focusableSelectors =
        'button, [tabindex]:not([tabindex="-1"]), video';
      const focusableElements = modal.querySelectorAll(focusableSelectors);
      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === firstElement) {
          lastElement.focus();
          e.preventDefault();
        }
      } else {
        if (document.activeElement === lastElement) {
          firstElement.focus();
          e.preventDefault();
        }
      }
    }
  });
});

async function editRecordingName(id, oldFilename) {
  const newName = prompt(
    "Enter new filename (excluding .webm):",
    oldFilename.replace(".webm", ""),
  );
  if (newName && newName !== oldFilename.replace(".webm", "")) {
    try {
      const res = await fetch("/api/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oldName: oldFilename, newName: newName }),
      });
      const data = await res.json();
      if (data.ok) {
        // Update the UI
        const fileLabel = document.getElementById(`file-${id}`);
        if (fileLabel) fileLabel.textContent = `Filename: ${data.filename}`;

        const actions = document.getElementById(`actions-${id}`);
        if (actions) {
          actions.innerHTML = `
                    <button class="btn-rec-action primary" onclick="viewRecording('${data.filename}')">View</button>
                    <button class="btn-rec-action" onclick="editRecordingName('${id}', '${data.filename}')">Rename</button>
                `;
        }
      } else {
        alert("Rename failed: " + (data.error || "Unknown error"));
      }
    } catch (err) {
      console.error("Rename failed:", err);
    }
  }
}

// Initialize on page load
document.addEventListener("DOMContentLoaded", init);
