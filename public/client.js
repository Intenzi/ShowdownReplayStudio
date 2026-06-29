const socket =
  typeof io !== "undefined" ? io() : { on: () => {}, emit: () => {} };
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

function changeBulk(delta) {
  const input = document.getElementById("bulk");
  if (!input) return;

  let currentStr = input.value;
  let currentNum = currentStr === "all" ? 11 : parseInt(currentStr) || 1;
  let next = currentNum + delta;

  if (next < 1) next = 1;
  if (next > 10) {
    input.value = "all";
  } else {
    input.value = next;
  }
  
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
  const btn = context === "setup"
    ? document.querySelector("#step1 button")
    : document.querySelector(".ws-path-group button");

  let originalHtml = "";
  if (btn) {
    btn.disabled = true;
    btn.classList.add("btn-loading");
    originalHtml = btn.innerHTML;
    if (context === "setup") btn.textContent = "Opening...";
  }

  try {
    const res = await fetch("/api/pick-folder", { method: "POST" });
    const data = await res.json();

    if (data.success && data.folder) {
        applyFolder(data.folder);
        showToast('Output directory updated successfully.', 'success');
    } else if (data.requiresManualInput) {
        showManualPathModal(async (manualPath) => {
            if (!manualPath?.trim()) return;
            const trimmed = manualPath.trim();
            applyFolder(trimmed);
            await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ outputFolder: trimmed }),
            });
            showToast('Output directory updated successfully.', 'success');
        });
    } else if (data.cancelled) {
        // do nothing, user just closed the picker
    } else {
        showToast(data.message || 'Could not open folder picker.', 'info');
    }
  } catch (err) {
    console.error("Failed to pick folder:", err);
    showToast("Failed to open folder picker.", "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove("btn-loading");
      if (context === "setup") btn.innerHTML = originalHtml;
    }
  }
}

function applyFolder(path) {
  config.outputFolder = path;
  const pathDisplay = document.getElementById("folderPath");
  const setupPathDisplay = document.getElementById("setupFolderPath");
  if (pathDisplay) pathDisplay.textContent = path;
  if (setupPathDisplay) setupPathDisplay.textContent = path;
}

function showManualPathModal(onConfirm) {
  const existing = document.getElementById("manual-path-modal");
  if (existing) existing.remove();

  const modal = document.createElement("div");
  modal.id = "manual-path-modal";
  modal.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal-box">
        <h3>Enter Output Folder Path</h3>
        <p>Paste or type the absolute path to your output folder.</p>
        <input type="text" id="manual-path-input" placeholder="/home/user/replays" value="${config.outputFolder || ""}" />
        <div class="modal-actions">
          <button id="manual-path-cancel">Cancel</button>
          <button id="manual-path-confirm">Confirm</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const input = modal.querySelector("#manual-path-input");
  input.focus();
  input.select();

  modal.querySelector("#manual-path-confirm").addEventListener("click", () => {
    onConfirm(input.value);
    modal.remove();
  });

  modal.querySelector("#manual-path-cancel").addEventListener("click", () => {
    modal.remove();
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { onConfirm(input.value); modal.remove(); }
    if (e.key === "Escape") modal.remove();
  });
}

function openOutputFolder() {
  fetch("/api/open-folder", { method: "POST" });
}

async function quitApp() {
  if (
    confirm(
      "Are you sure you want to quit Showdown Replay Studio? This will stop all active and queued recordings.",
    )
  ) {
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

  const steps = ["step1", "step2"];
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
      ];
      setupLog.textContent = labels[currentStep];
    }

    setTimeout(
      () => {
        if (el) {
          el.classList.remove("active");
          el.classList.add("done");
        }
        currentStep++;
        processStep();
      },
      800 + Math.random() * 700,
    );
  };

  processStep();
}

let activeTab = "urls";
let selectedLocalFiles = [];

function switchTab(tabId) {
  activeTab = tabId;
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.classList.toggle("active", btn.id === `tab-${tabId}`);
    btn.setAttribute("aria-selected", btn.id === `tab-${tabId}`);
  });
  document.querySelectorAll(".tab-pane").forEach(pane => {
    pane.classList.toggle("hidden", pane.id !== `pane-${tabId}`);
  });

  const noMusicBtn = document.getElementById("segment-audio-nomusic");
  if (noMusicBtn) {
    if (tabId === "files") {
      noMusicBtn.classList.add("hidden");
      if (audioMode === "nomusic") {
        setAudio("noaudio");
      }
    } else {
      noMusicBtn.classList.remove("hidden");
    }
  }

  const btn = document.getElementById("btnRecord");
  if (btn) {
    if (tabId === "files") {
      btn.querySelector("span").textContent = "Record Local Files";
    } else {
      btn.querySelector("span").textContent = "Start Recording";
    }
  }
}

async function pickLocalFiles() {
  try {
    const btn = document.getElementById("btnSelectFiles");
    if (btn) btn.disabled = true;

    const res = await fetch("/api/pick-file-replay", { method: "POST" });
    const data = await res.json();

    if (btn) btn.disabled = false;

    if (!data.success) {
      if (data.error && data.error !== "No files selected") {
        showToast(data.error, "error");
      }
      return;
    }

    selectedLocalFiles = data.files || [];

    const listEl = document.getElementById("localFilesList");
    if (listEl) {
      if (selectedLocalFiles.length === 0) {
        listEl.innerHTML = "";
      } else {
        listEl.innerHTML = selectedLocalFiles.map(file => `
          <div class="local-file-item">
            <div class="local-file-title" title="${file.name}">${file.name}</div>
            <div class="local-file-meta">
              <span>${file.players}</span>
              <span>${file.totalTurns} turns</span>
            </div>
          </div>
        `).join("");
      }
    }

    if (data.ignored && data.ignored.length > 0) {
      showToast(`Skipped ${data.ignored.length} invalid file(s).`, "warning");
    }

    if (selectedLocalFiles.length > 0) {
      showToast(`Loaded ${selectedLocalFiles.length} valid replay file(s).`, "success");
    }
  } catch (err) {
    console.error(err);
    showToast("Failed to select files.", "error");
    const btn = document.getElementById("btnSelectFiles");
    if (btn) btn.disabled = false;
  }
}

function startRecording() {
  const currentSpeed = document.getElementById("speed")?.value;
  const recordConfig = {
    speed: currentSpeed,
    theme: document.getElementById("theme")?.value,
    bulk: document.getElementById("bulk")?.value,
    nomusic: audioMode === "nomusic",
    noaudio: audioMode === "noaudio",
    nochat: chatMode === "hide",
  };

  if (activeTab === "files") {
    if (selectedLocalFiles.length === 0) {
      showToast("Please select some HTML replay files first.", "warning");
      return;
    }

    // Clear empty state
    const emptyState = document.getElementById("emptyState");
    if (emptyState) emptyState.style.display = "none";

    selectedLocalFiles.forEach((file) => {
      const id = Math.random().toString(36).substring(2, 11);
      createRecordingItem(file.name, id, { audioMode, chatMode, speed: currentSpeed });
      socket.emit("record", { recordings: [{ link: file.path, id }], recordConfig });
    });

    // Reset selection
    selectedLocalFiles = [];
    const listEl = document.getElementById("localFilesList");
    if (listEl) listEl.innerHTML = "";

    showToast("Queued local replay files.", "success");
    return;
  }

  const input = document.getElementById("links");
  const linksText = input?.value.trim();
  if (!linksText) return;

  const links = linksText.split(/[\s,]+/).filter(Boolean);

  // Clear the input field for next batch of recordings immediately
  if (input) input.value = "";

  links.forEach((link) => {
    // 1. Domain prefix check
    const isValidPrefix =
      link.startsWith("https://replay.pokemonshowdown.com/") ||
      link.startsWith("http://replay.pokemonshowdown.com/");

    if (!isValidPrefix) {
      console.warn(`[Validator] Ignored link (invalid domain): ${link}`);
      showToast(`Invalid Replay URL (wrong domain): ${link.substring(0, 30)}...`, "warning");
      return;
    }

    // 2. Perform async HEAD request check
    (async () => {
      try {
        const cleanLink = link.split("?")[0].replace(/\/$/, "");
        const verifyUrl = `${cleanLink}.log`;

        const response = await fetch(verifyUrl, { method: "HEAD" });
        if (response.status !== 404) {
          // Clear empty state
          const emptyState = document.getElementById("emptyState");
          if (emptyState) emptyState.style.display = "none";

          const id = Math.random().toString(36).substring(2, 11);
          createRecordingItem(link, id, { audioMode, chatMode, speed: currentSpeed });

          socket.emit("record", { recordings: [{ link, id }], recordConfig });
        } else {
          console.warn(`[Validator] Replay not found (404): ${verifyUrl}`);
          showToast(`Replay not found (404): ${link.substring(0, 30)}...`, "error");
        }
      } catch (err) {
        // Failed to fetch on an invalid Pokemon Showdown domain link represents a 404
        console.warn(`[Validator] Replay not found or invalid: ${link}`);
        showToast(`Replay not found or invalid: ${link.substring(0, 30)}...`, "error");
      }
    })();
  });
}

function createRecordingItem(link, id, config = {}) {
  if (document.getElementById(`rec-${id}`)) return;

  const queueList = document.getElementById("queueList");
  if (!queueList) return;

  // Generate badges for settings
  let badgesHtml = "";
  if (config.audioMode === "noaudio")
    badgesHtml += '<span class="rec-badge">Muted</span>';
  else if (config.audioMode === "nomusic")
    badgesHtml += '<span class="rec-badge">No Music</span>';

  if (config.chatMode === "hide")
    badgesHtml += '<span class="rec-badge">No Chat</span>';
  else badgesHtml += '<span class="rec-badge">With Chat</span>';

  if (config.speed && config.speed !== "normal")
    badgesHtml += `<span class="rec-badge highlight">${config.speed}</span>`;

  const item = document.createElement("div");
  item.className = "recording-card";
  item.id = `rec-${id}`;
  item.innerHTML = `
        <div class="rec-info">
            <div class="rec-title" id="header-${id}">
                <span class="status-badge queued" id="status-${id}">Queued</span>
                <span class="rec-name" id="name-${id}">Fetching metadata...</span>
            </div>
            <div class="rec-subtitle" id="url-${id}">${link}</div>
            <div class="rec-meta-row" id="meta-${id}">
                <span class="rec-subtitle" id="turns-${id}">Turns: —</span>
                <div class="rec-badges-container" id="badges-container-${id}">${badgesHtml}</div>
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
  queueList.prepend(item);
  recordingData[id] = { link, state: "queued", config };
  updateSectionVisibility();
}

function cancelRecording(id) {
  socket.emit("cancel-recording", { id });
}

function updateRecordingItem(id, state, meta = {}) {
  const data = recordingData[id];
  if (!data) return;

  // Sync internal state
  data.state = state;

  // Move between lists if necessary
  const item = document.getElementById(`rec-${id}`);
  const activeList = document.getElementById("activeList");
  const finishedList = document.getElementById("finishedList");
  const queueList = document.getElementById("queueList");

  if (item) {
    if (state === "queued") {
      if (item.parentElement !== queueList) {
        queueList.prepend(item);
        updateSectionVisibility();
      }
    } else if (state === "starting" || state === "recording" || state === "finalizing") {
      if (item.parentElement !== activeList) {
        activeList.prepend(item);
        updateSectionVisibility();
      }
    } else if (state === "done" || state === "error" || state === "cancelled") {
      if (item.parentElement !== finishedList) {
        finishedList.prepend(item);
        updateSectionVisibility();
      }
    }
  }

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
  const processingStates = [
    "starting",
    "fetching",
    "setup",
    "preparing",
    "finalizing",
  ];

  if (processingStates.includes(state)) {
    if (statusBadge) {
      statusBadge.textContent = state.charAt(0).toUpperCase() + state.slice(1);
      statusBadge.className = `status-badge processing ${state}`;
    }

    if (label) {
      switch (state) {
        case "starting":
          label.textContent = "Moving to active queue...";
          break;
        case "fetching":
          label.textContent = "Fetching battle metadata...";
          break;
        case "setup":
          label.textContent = "Initializing browser instance...";
          break;
        case "preparing":
          label.textContent = "Configuring replay options...";
          break;
        case "finalizing":
          label.textContent = "Saving recording...";
          break;
      }
    }

    if (progressFill && state !== "finalizing") progressFill.style.width = "5%";
    if (progressFill && state === "finalizing")
      progressFill.style.width = "99%";
  } else if (state === "recording") {
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

    // Move badges to top right to make room for filename
    const badges = document.getElementById(`badges-container-${id}`);
    const header = document.getElementById(`header-${id}`);
    if (badges && header) {
        header.appendChild(badges);
        badges.style.marginLeft = "auto";
    }

    if (actions) {
      actions.innerHTML = `
                <button class="btn-rec-action primary" onclick="viewRecording('${meta.filename}')">View</button>
                <button class="btn-rec-action" onclick="editRecordingName('${id}', '${meta.filename}')">Rename</button>
            `;
    }
  } else if (state === "queued") {
    if (statusBadge) {
      statusBadge.textContent = "Queued";
      statusBadge.className = "status-badge queued";
    }
    if (progressFill) {
      progressFill.style.width = "0%";
      progressFill.style.backgroundColor = "";
    }
    if (percent) percent.textContent = "0%";
    if (label) label.textContent = "Awaiting recording";
    if (fileLabel) {
      fileLabel.classList.add("hidden");
    }
    if (actions) {
      actions.innerHTML = "";
    }
    document.getElementById(`cancel-container-${id}`)?.classList.remove("hidden");
    document.getElementById(`close-${id}`)?.classList.add("hidden");
  } else if (state === "error") {
    if (statusBadge) {
      statusBadge.textContent = "Error";
      statusBadge.className = "status-badge error";
    }
    if (label) label.textContent = "Failed to record";
    document.getElementById(`cancel-container-${id}`)?.classList.add("hidden");
    document.getElementById(`close-${id}`)?.classList.remove("hidden");
    if (actions) {
      actions.innerHTML = `
                <button class="btn-rec-action primary" onclick="retryRecording('${id}')">Retry</button>
            `;
    }
  } else if (state === "cancelled") {
    if (statusBadge) {
      statusBadge.textContent = "Cancelled";
      statusBadge.className = "status-badge error";
    }
    if (label) label.textContent = "Recording aborted.";
    if (progressFill) progressFill.style.backgroundColor = "#94a3b8";
    document.getElementById(`cancel-container-${id}`)?.classList.add("hidden");
    document.getElementById(`close-${id}`)?.classList.remove("hidden");
    if (actions) {
      actions.innerHTML = `
                <button class="btn-rec-action primary" onclick="retryRecording('${id}')">Retry</button>
            `;
    }
  }

  // Ensure close/cancel buttons are toggled correctly at the end states
  if (state === "done" || state === "error" || state === "cancelled") {
    document.getElementById(`cancel-container-${id}`)?.classList.add("hidden");
    document.getElementById(`close-${id}`)?.classList.remove("hidden");
  } else if (state === "queued") {
    document.getElementById(`cancel-container-${id}`)?.classList.remove("hidden");
    document.getElementById(`close-${id}`)?.classList.add("hidden");
  }

  updateSectionVisibility();
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
  updateSectionVisibility();
}

function clearAll() {
    if (!confirm("STOP ALL RECORDINGS? This will terminate all currently active processes and clean your workspace. This action cannot be undone.")) return;
    
    // We must cancel everything first to stop background processes
    const allIds = Object.keys(recordingData);
    allIds.forEach(id => {
        const data = recordingData[id];
        if (data.state !== 'done' && data.state !== 'error' && data.state !== 'cancelled') {
            cancelRecording(id);
        }
    });

    const activeList = document.getElementById("activeList");
    const queueList = document.getElementById("queueList");
    if (activeList) activeList.innerHTML = "";
    if (queueList) queueList.innerHTML = "";
    
    recordingData = {};
    updateSectionVisibility();
}

function clearQueue() {
    const queueList = document.getElementById("queueList");
    if (!queueList) return;
    
    // We must send cancellation to server for EVERY queued item 
    // or the background processing will still pick them up!
    const children = Array.from(queueList.children);
    children.forEach(child => {
        const id = child.id.replace('rec-', '');
        cancelRecording(id);
    });

    queueList.innerHTML = "";
    updateSectionVisibility();
}

function clearFinished() {
    const finishedList = document.getElementById("finishedList");
    if (!finishedList) return;
    
    const children = Array.from(finishedList.children);
    children.forEach(child => {
        const id = child.id.replace('rec-', '');
        removeCard(id);
    });
}

function retryRecording(id) {
  const data = recordingData[id];
  if (!data) return;

  // Move back to queue list
  const item = document.getElementById(`rec-${id}`);
  const queueList = document.getElementById("queueList");
  if (item && queueList) {
    queueList.prepend(item);
  }

  // Reset visual state and move status
  updateRecordingItem(id, "queued");

  // Re-emit record request to server
  const currentSpeed = document.getElementById("speed")?.value;
  const recordConfig = {
    speed: data.config?.speed || currentSpeed || "normal",
    theme: document.getElementById("theme")?.value || "auto",
    bulk: document.getElementById("bulk")?.value || "1",
    nomusic: data.config?.nomusic || data.config?.audioMode === "nomusic",
    noaudio: data.config?.noaudio || data.config?.audioMode === "noaudio",
    nochat: data.config?.nochat || data.config?.chatMode === "hide",
  };

  socket.emit("record", { recordings: [{ link: data.link, id }], recordConfig });
  showToast("Retrying recording...", "info");
}

function updateSectionVisibility() {
    const activeList = document.getElementById("activeList");
    const queueList = document.getElementById("queueList");
    const finishedList = document.getElementById("finishedList");

    const activeSection = document.getElementById("activeSection");
    const queueSection = document.getElementById("queueSection");
    const finishedSection = document.getElementById("finishedSection");
    
    const emptyState = document.getElementById("emptyState");
    const badge = document.getElementById("recordCountBadge");

    const activeCount = activeList?.children.length || 0;
    const queueCount = queueList?.children.length || 0;
    const finishedCount = finishedList?.children.length || 0;
    const total = activeCount + queueCount + finishedCount;

    if (activeSection) activeSection.classList.toggle("hidden", activeCount === 0);
    if (queueSection) queueSection.classList.toggle("hidden", queueCount === 0);
    if (finishedSection) finishedSection.classList.toggle("hidden", finishedCount === 0);
    
    if (emptyState) emptyState.classList.toggle("hidden", total > 0);
    
    if (badge) {
        badge.textContent = total;
        badge.classList.toggle("hidden", total === 0);
    }
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

/**
 * Toast Notification System
 */
function showToast(message, type = "info", duration = 4000) {
  let container = document.getElementById("toastContainer");
  if (!container) {
    container = document.createElement("div");
    container.id = "toastContainer";
    document.body.appendChild(container);
  }

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;

  let icon = "ℹ️";
  if (type === "success") icon = "✅";
  else if (type === "warning") icon = "⚠️";
  else if (type === "error") icon = "❌";

  toast.innerHTML = `
    <div class="toast-icon">${icon}</div>
    <div class="toast-message">${message}</div>
    <button class="toast-close" aria-label="Close">&times;</button>
  `;

  container.appendChild(toast);

  // Trigger browser paint
  setTimeout(() => {
    toast.classList.add("visible");
  }, 10);

  const removeToast = () => {
    toast.classList.remove("visible");
    toast.addEventListener("transitionend", () => {
      toast.remove();
    });
  };

  toast.querySelector(".toast-close").addEventListener("click", removeToast);

  if (duration > 0) {
    setTimeout(removeToast, duration);
  }
}

// Initialize on page load
document.addEventListener("DOMContentLoaded", init);
