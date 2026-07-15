/* Envelope Tool frontend: upload PDB, define domains, generate + view envelopes. */

// ---------- Theme color ----------

const THEME_STORAGE_KEY = "envelopeToolAccent";

function hexToRgbInts(hex) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

function rgbaFromHex(hex, alpha) {
  const [r, g, b] = hexToRgbInts(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function lightenHex(hex, amount) {
  const [r, g, b] = hexToRgbInts(hex);
  const mix = (c) => Math.round(c + (255 - c) * amount);
  const toHex = (v) => v.toString(16).padStart(2, "0");
  return `#${toHex(mix(r))}${toHex(mix(g))}${toHex(mix(b))}`;
}

function applyThemeColor(hex, { persist = true } = {}) {
  const root = document.documentElement.style;
  root.setProperty("--accent", hex);
  root.setProperty("--accent-hover", lightenHex(hex, 0.18));
  root.setProperty("--accent-dim", rgbaFromHex(hex, 0.16));
  root.setProperty("--accent-border", rgbaFromHex(hex, 0.45));
  if (persist) localStorage.setItem(THEME_STORAGE_KEY, hex);
}

const themeSwatch = document.getElementById("theme-accent");
themeSwatch.addEventListener("input", () => applyThemeColor(themeSwatch.value));

const savedAccent = localStorage.getItem(THEME_STORAGE_KEY);
if (savedAccent) {
  themeSwatch.value = savedAccent;
  applyThemeColor(savedAccent, { persist: false });
}

// A full reload is the simplest reliable way to guarantee a truly clean
// slate (structure, domains, generated envelopes, log, all in-memory state)
// without having to enumerate and reset every piece of UI by hand. The
// theme color is the only thing that persists (via localStorage), which
// matches it being a display preference rather than session data.
document.getElementById("restart-btn").addEventListener("click", () => {
  if (confirm("Start a new session? This clears the current structure and all domains. Unsaved changes will be lost -- use Save state first if you want to keep them.")) {
    location.reload();
  }
});

const state = {
  sessionId: null,
  file: null,
  segInfo: {},        // segid -> { n_atoms, ranges, resnames }
  structureComp: null,
  shapeComps: [],
  domainColorReprs: [],  // cartoon representations used for the live per-domain color preview
  initialOrientation: null,
};

let stage = null;

function initViewer() {
  stage = new NGL.Stage("viewer", {
    backgroundColor: "#1b1d21",
    fogNear: 100,
    fogFar: 100,
    // The scene light is fixed while the model spins (NGL rotates the
    // model, not the camera), so a mostly-directional light makes shading
    // swing a lot as you rotate. Leaning on ambient instead keeps
    // brightness/quality consistent at any orientation.
    ambientIntensity: 0.75,
    lightIntensity: 0.55,
  });
  applyBackground(backgroundSelect.value);
  window.addEventListener("resize", () => stage.handleResize());
  // NGL's own render loop only redraws on interaction/parameter changes; on
  // some browsers that leaves a stale frame (e.g. background color changes
  // not showing) until the next interaction. Force a steady heartbeat
  // redraw so the canvas never goes stale regardless of mouse/focus state.
  setInterval(() => stage.viewer.requestRender(), 500);
}

// ---------- Display controls ----------

const viewerWrap = document.getElementById("viewer-wrap");
const backgroundSelect = document.getElementById("v-background");
const showStructureCheckbox = document.getElementById("v-show-structure");

function applyBackground(mode) {
  if (mode === "transparent") {
    stage.setParameters({ backgroundColor: "white" });
    stage.viewer.renderer.setClearAlpha(0);
    viewerWrap.classList.add("bg-transparent");
  } else {
    stage.setParameters({ backgroundColor: mode === "white" ? "white" : "#1b1d21" });
    stage.viewer.renderer.setClearAlpha(1);
    viewerWrap.classList.remove("bg-transparent");
  }
  stage.viewer.requestRender();
}
backgroundSelect.addEventListener("change", () => applyBackground(backgroundSelect.value));

function applyStructureVisibility(visible) {
  if (state.structureComp) {
    state.structureComp.reprList.forEach((r) => r.setVisibility(visible));
  }
}
showStructureCheckbox.addEventListener("change", () => applyStructureVisibility(showStructureCheckbox.checked));

// ---------- View controls (orient/zoom, turn axes) ----------

document.getElementById("reset-view-btn").addEventListener("click", () => {
  if (state.initialOrientation) {
    stage.viewerControls.orient(state.initialOrientation);
  } else {
    stage.autoView();
  }
});

function wireTurnButton(btnId, inputId, axis) {
  const btn = document.getElementById(btnId);
  const input = document.getElementById(inputId);
  btn.addEventListener("click", () => {
    const degrees = parseFloat(input.value) || 0;
    stage.viewerControls.spin(axis, (degrees * Math.PI) / 180);
  });
}
wireTurnButton("turn-x-btn", "turn-x-deg", [1, 0, 0]);
wireTurnButton("turn-y-btn", "turn-y-deg", [0, 1, 0]);
wireTurnButton("turn-z-btn", "turn-z-deg", [0, 0, 1]);

// ---------- Surface style ----------

const SURFACE_STYLES = {
  plastic:  { roughness: 0.4,  metalness: 0.0,  flatShaded: false },
  matte:    { roughness: 1.0,  metalness: 0.0,  flatShaded: false },
  glossy:   { roughness: 0.1,  metalness: 0.05, flatShaded: false },
  metallic: { roughness: 0.25, metalness: 0.85, flatShaded: false },
  faceted:  { roughness: 0.65, metalness: 0.0,  flatShaded: true  },
};

const surfaceStyleSelect = document.getElementById("v-surface-style");

function applySurfaceStyle(styleName) {
  const preset = SURFACE_STYLES[styleName] || SURFACE_STYLES.plastic;
  state.shapeComps.forEach((comp) => {
    comp.reprList.forEach((r) => r.setParameters(preset));
  });
  stage.viewer.requestRender();
}
surfaceStyleSelect.addEventListener("change", () => applySurfaceStyle(surfaceStyleSelect.value));

// ---------- Save snapshot ----------

const saveSnapshotBtn = document.getElementById("save-snapshot");
const snapshotBackgroundSelect = document.getElementById("v-snapshot-background");
const snapshotResolutionSelect = document.getElementById("v-snapshot-resolution");
const snapshotFormatSelect = document.getElementById("v-snapshot-format");

// NGL's makeImage() only ever produces PNG (it calls canvas.toBlob with no
// mime type), so JPEG is re-encoded client-side via an offscreen canvas.
async function exportViewerImage(factor, format, bgChoice) {
  const originalBg = backgroundSelect.value;
  const targetBg = bgChoice === "current" ? originalBg : bgChoice;
  if (targetBg !== originalBg) applyBackground(targetBg);

  const transparent = targetBg === "transparent" && format === "png";
  let pngBlob;
  try {
    pngBlob = await stage.makeImage({ factor, antialias: true, trim: false, transparent });
  } finally {
    if (targetBg !== originalBg) applyBackground(originalBg);
  }

  if (format === "png") return pngBlob;

  const bitmap = await createImageBitmap(pngBlob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff"; // JPEG has no alpha channel
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
}

saveSnapshotBtn.addEventListener("click", async () => {
  saveSnapshotBtn.disabled = true;
  saveSnapshotBtn.textContent = "Saving...";
  try {
    const factor = parseInt(snapshotResolutionSelect.value, 10);
    const format = snapshotFormatSelect.value;
    const bgChoice = snapshotBackgroundSelect.value;
    const blob = await exportViewerImage(factor, format, bgChoice);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `envelope_view_${Date.now()}.${format === "jpeg" ? "jpg" : "png"}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } finally {
    saveSnapshotBtn.disabled = false;
    saveSnapshotBtn.textContent = "Save image";
  }
});

// ---------- Structure upload ----------

const dropzone = document.getElementById("dropzone");
const dropzoneLabel = document.getElementById("dropzone-label");
const pdbInput = document.getElementById("pdb-input");
const structureInfo = document.getElementById("structure-info");
const addDomainBtn = document.getElementById("add-domain");
const loadYamlBtn = document.getElementById("load-yaml-btn");
const generateBtn = document.getElementById("generate");

dropzone.addEventListener("click", () => pdbInput.click());
dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("dragover"); });
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("dragover");
  if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});
pdbInput.addEventListener("change", () => {
  if (pdbInput.files.length) handleFile(pdbInput.files[0]);
});

async function handleFile(file) {
  state.file = file;
  dropzoneLabel.textContent = file.name;
  structureInfo.textContent = "Uploading + parsing...";
  structureInfo.classList.remove("error");

  const form = new FormData();
  form.append("pdb", file);

  try {
    const res = await fetch("/api/upload", { method: "POST", body: form });
    if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
    const data = await res.json();
    state.sessionId = data.session_id;
    state.segInfo = data.segids;

    const segSummary = Object.entries(data.segids)
      .map(([seg, info]) => `${seg}: ${info.n_atoms} atoms, resid ${info.ranges.map(r => r.join("-")).join(", ")}`)
      .join("\n");
    structureInfo.textContent = `${data.n_atoms} atoms total\n${segSummary}`;

    // Loading a new structure keeps existing domain rows as-is (this is a
    // reload/update, not a reset) and just refreshes which chains they can
    // select from. If a domain's previously-selected chains don't exist in
    // the new structure, its chip selection quietly ends up empty (fine --
    // it'll just be skipped when generating); we only add a small note so
    // the user knows to double check it, without blocking anything.
    const existingRows = Array.from(document.querySelectorAll(".domain-row"));
    const hadChainsBefore = existingRows.map((row) => selectedChains(row).length > 0);

    document.querySelectorAll(".chain-chips").forEach(fillChainChips);

    const nowEmpty = existingRows.filter((row, i) => hadChainsBefore[i] && selectedChains(row).length === 0);
    if (nowEmpty.length > 0) {
      const names = nowEmpty.map((row) => row.querySelector(".d-name").value || "unnamed").join(", ");
      structureInfo.textContent += `\n\nNote: ${nowEmpty.length} domain(s) (${names}) had chain selections `
        + `that don't exist in this structure. They're left as-is (no chains selected, so they'll be `
        + `skipped when generating) -- update or remove them if needed.`;
    }

    addDomainBtn.disabled = false;
    loadYamlBtn.disabled = false;
    generateBtn.disabled = document.querySelectorAll(".domain-row").length === 0;
    updateEnvelopeCount();

    await loadStructureIntoViewer(file);
  } catch (err) {
    structureInfo.textContent = `Error: ${err.message}`;
    structureInfo.classList.add("error");
  }
}

async function loadStructureIntoViewer(file) {
  if (state.structureComp) {
    stage.removeComponent(state.structureComp);
    state.structureComp = null;
  }
  const ext = file.name.toLowerCase().endsWith(".ent") ? "pdb" : file.name.split(".").pop();
  const comp = await stage.loadFile(file, { ext: ext === "ent" ? "pdb" : ext });
  comp.addRepresentation("licorice", { sele: "hetero and not water", color: "element" });
  comp.autoView();
  state.structureComp = comp;
  state.domainColorReprs = [];
  state.initialOrientation = stage.viewerControls.getOrientation();
  applyStructureVisibility(showStructureCheckbox.checked);
  applyBackground(backgroundSelect.value);
  updateDomainColoring();
}

// ---------- Live per-domain cartoon coloring (no generate needed) ----------
//
// The structure's cartoon is colored to match each domain's chosen color
// over its selected chain(s) + residue range, updating immediately as
// chains/resid/color change -- independent of the (slower) actual envelope
// generation. Regions not covered by any domain stay neutral grey.

// NGL selection language: chain must be selected via ":<chain>" (the
// "segid <x>" keyword does not compose correctly with a following
// "and (<resid-range>)" clause -- verified empirically).
function buildNglSelection(chains, residStr) {
  if (!chains || chains.length === 0) return null;
  const chainPart = chains.length > 1
    ? `(${chains.map((c) => `:${c}`).join(" or ")})`
    : `:${chains[0]}`;
  const ranges = (residStr || "").split(",").map((r) => r.trim()).filter(Boolean);
  if (ranges.length === 0) return chainPart;
  const residPart = ranges.length > 1 ? `(${ranges.join(" or ")})` : ranges[0];
  return `${chainPart} and (${residPart})`;
}

// Each domain can be individually shown or hidden on the structure (the
// "eye" checkbox in its header), independent of the master "show structure"
// checkbox and of every other domain. A hidden domain's segment is left
// out of its own colored representation entirely (not just recolored grey)
// -- but its selection still counts toward carving out the neutral "rest of
// the structure" region, so hiding a domain doesn't make the base cartoon
// reclaim that area.
function updateDomainColoring() {
  if (!state.structureComp) return;

  try {
    state.domainColorReprs.forEach((repComp) => state.structureComp.removeRepresentation(repComp));
    state.domainColorReprs = [];

    const domainSelections = [];
    document.querySelectorAll(".domain-row").forEach((row) => {
      const chains = selectedChains(row);
      const resid = row.querySelector(".d-resid").value.trim();
      const sel = buildNglSelection(chains, resid);
      if (!sel) return;
      // Each selection needs its own parens before being OR'd together --
      // `not (A or B)` silently fails to negate correctly in NGL's selection
      // grammar (matches everything instead of excluding A and B), whereas
      // `not ((A) or (B))` works correctly. Verified empirically.
      domainSelections.push(`(${sel})`);

      if (!row.querySelector(".d-show-structure").checked) return;
      const color = row.querySelector(".d-color").value;
      const repComp = state.structureComp.addRepresentation("cartoon", { sele: sel, color });
      state.domainColorReprs.push(repComp);
    });

    const baseSele = domainSelections.length > 0 ? `not (${domainSelections.join(" or ")})` : "*";
    const baseRep = state.structureComp.addRepresentation("cartoon", { sele: baseSele, color: "#8a8a92" });
    state.domainColorReprs.push(baseRep);

    stage.viewer.requestRender();
  } catch (err) {
    // Surface failures visibly (not just in devtools) so this is diagnosable
    // without needing to know how to open the browser console.
    console.error("updateDomainColoring failed:", err);
    structureInfo.textContent += `\n\n[domain coloring error] ${err.message}`;
  }
}

// ---------- Domain rows ----------

const domainsContainer = document.getElementById("domains");
const rowTemplate = document.getElementById("domain-row-template");

function fillChainChips(container) {
  const prevSelected = new Set(
    Array.from(container.querySelectorAll(".chain-chip.selected")).map((c) => c.dataset.segid)
  );
  const isFirstFill = container.children.length === 0;
  const row = container.closest(".domain-row");
  container.innerHTML = "";
  Object.keys(state.segInfo).forEach((seg) => {
    const chip = document.createElement("span");
    chip.className = "chain-chip";
    chip.dataset.segid = seg;
    chip.textContent = seg;
    const shouldSelect = isFirstFill ? true : prevSelected.has(seg);
    if (shouldSelect) chip.classList.add("selected");
    chip.addEventListener("click", () => {
      chip.classList.toggle("selected");
      renderRangeChipsForRow(row);
      updateChainToggleAllState(row);
      updateEnvelopeCount();
      updateDomainColoring();
    });
    container.appendChild(chip);
  });
  updateChainToggleAllState(row);
}

function selectedChains(row) {
  return Array.from(row.querySelectorAll(".chain-chip.selected")).map((c) => c.dataset.segid);
}

function updateChainToggleAllState(row) {
  const toggle = row.querySelector(".chain-toggle-all");
  const chips = row.querySelectorAll(".chain-chip");
  const allSelected = chips.length > 0 && Array.from(chips).every((c) => c.classList.contains("selected"));
  toggle.classList.toggle("all-selected", allSelected);
}

function renderRangeChipsForRow(row) {
  const chipsDiv = row.querySelector(".range-chips");
  const residInput = row.querySelector(".d-resid");
  chipsDiv.innerHTML = "";
  selectedChains(row).forEach((seg) => {
    const info = state.segInfo[seg];
    if (!info) return;
    info.ranges.forEach(([lo, hi]) => {
      const chip = document.createElement("span");
      chip.className = "range-chip";
      chip.textContent = `${seg}: ${lo}-${hi}`;
      chip.addEventListener("click", () => {
        const piece = `${lo}-${hi}`;
        residInput.value = residInput.value
          ? `${residInput.value},${piece}`
          : piece;
      });
      chipsDiv.appendChild(chip);
    });
  });
}

// ---------- Global <-> per-domain parameter sync ----------
//
// Global render parameters are "live defaults": changing one updates every
// domain that hasn't been individually edited for that specific field.
// Directly editing a domain's own field breaks the link for that field only
// (it becomes an independent override, shown with a highlight), without
// touching the global value or any other domain.

const SYNCED_FIELDS = [
  { global: "g-sigma", domainClass: "d-sigma" },
  { global: "g-smoothing", domainClass: "d-smoothing" },
  { global: "g-decimate", domainClass: "d-decimate" },
  { global: "g-spacing", domainClass: "d-spacing" },
  { global: "g-basis", domainClass: "d-basis" },
];

function markOverridden(input) {
  input.dataset.overridden = "1";
}

function isOverridden(input) {
  return input.dataset.overridden === "1";
}

function valuesDiffer(a, b) {
  const na = parseFloat(a);
  const nb = parseFloat(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na !== nb;
  return String(a) !== String(b);
}

function updateOverrideBadge(row) {
  const fields = [
    ...SYNCED_FIELDS.map(({ domainClass }) => row.querySelector(`.${domainClass}`)),
    row.querySelector(".d-threshold-mode"),
  ];
  const count = fields.filter(isOverridden).length;
  const badge = row.querySelector(".override-badge");
  badge.textContent = count > 0 ? ` (${count} custom)` : "";
}

SYNCED_FIELDS.forEach(({ global, domainClass }) => {
  document.getElementById(global).addEventListener("input", () => {
    const globalValue = document.getElementById(global).value;
    document.querySelectorAll(".domain-row").forEach((row) => {
      const input = row.querySelector(`.${domainClass}`);
      if (!isOverridden(input)) input.value = globalValue;
    });
  });
});

function propagateGlobalThreshold() {
  document.querySelectorAll(".domain-row").forEach((row) => {
    const dMode = row.querySelector(".d-threshold-mode");
    const dValue = row.querySelector(".d-threshold-value");
    if (isOverridden(dMode)) return;
    dMode.value = gThresholdMode.value;
    dValue.value = gThresholdValue.value;
    dValue.disabled = dMode.value !== "manual";
  });
}

function addDomainRow(defaults = {}) {
  const frag = rowTemplate.content.cloneNode(true);
  const row = frag.querySelector(".domain-row");

  const nameInput = row.querySelector(".d-name");
  nameInput.value = defaults.name || `domain_${domainsContainer.children.length + 1}`;

  fillChainChips(row.querySelector(".chain-chips"));
  renderRangeChipsForRow(row);

  row.querySelector(".chain-toggle-all").addEventListener("click", () => {
    const chips = row.querySelectorAll(".chain-chip");
    const allSelected = Array.from(chips).every((c) => c.classList.contains("selected"));
    chips.forEach((c) => c.classList.toggle("selected", !allSelected));
    updateChainToggleAllState(row);
    renderRangeChipsForRow(row);
    updateEnvelopeCount();
    updateDomainColoring();
  });

  row.querySelector(".d-resid").addEventListener("input", updateDomainColoring);
  row.querySelector(".d-color").addEventListener("input", updateDomainColoring);
  row.querySelector(".d-show-structure").addEventListener("change", updateDomainColoring);

  const transRange = row.querySelector(".d-transparency");
  const transVal = row.querySelector(".d-transparency-val");
  transRange.addEventListener("input", () => { transVal.textContent = transRange.value; });

  // Pre-fill this domain's parameters with the current global defaults, and
  // keep them live-linked to the global fields (edits to the global
  // parameters propagate here) until the user directly edits this domain's
  // own field, at which point that one field becomes independent.
  SYNCED_FIELDS.forEach(({ global, domainClass }) => {
    const input = row.querySelector(`.${domainClass}`);
    input.value = document.getElementById(global).value;
    input.addEventListener("input", () => {
      markOverridden(input);
      updateOverrideBadge(row);
    });
  });

  const thresholdMode = row.querySelector(".d-threshold-mode");
  const thresholdValue = row.querySelector(".d-threshold-value");
  thresholdMode.value = gThresholdMode.value;
  thresholdValue.value = gThresholdValue.value;
  thresholdValue.disabled = thresholdMode.value !== "manual";
  thresholdMode.addEventListener("input", () => {
    thresholdValue.disabled = thresholdMode.value !== "manual";
  });
  [thresholdMode, thresholdValue].forEach((el) => {
    el.addEventListener("input", () => {
      markOverridden(thresholdMode);
      updateOverrideBadge(row);
    });
  });

  row.querySelector(".remove-domain").addEventListener("click", () => {
    row.remove();
    generateBtn.disabled = document.querySelectorAll(".domain-row").length === 0;
    updateEnvelopeCount();
    updateDomainColoring();
  });

  domainsContainer.appendChild(row);
  generateBtn.disabled = false;
  updateEnvelopeCount();
  updateDomainColoring();
}

addDomainBtn.addEventListener("click", () => addDomainRow());

const envelopeCountEl = document.getElementById("envelope-count");

function updateEnvelopeCount() {
  const rows = Array.from(document.querySelectorAll(".domain-row"));
  if (rows.length === 0) {
    envelopeCountEl.textContent = "";
    return;
  }
  const active = rows.filter((row) => selectedChains(row).length > 0);
  const total = active.reduce((sum, row) => sum + selectedChains(row).length, 0);
  if (total === 0) {
    envelopeCountEl.textContent = "0 envelope(s) total (no domain has a chain selected)";
    return;
  }
  const chainNote = active.some((row) => selectedChains(row).length > 1)
    ? ` (${active.length} domain(s) across selected chains)`
    : "";
  envelopeCountEl.textContent = `${total} envelope(s) total${chainNote}`;
}

// global threshold mode toggle
const gThresholdMode = document.getElementById("g-threshold-mode");
const gThresholdValue = document.getElementById("g-threshold-value");
gThresholdMode.addEventListener("input", () => {
  gThresholdValue.disabled = gThresholdMode.value !== "manual";
});
gThresholdMode.addEventListener("input", propagateGlobalThreshold);
gThresholdValue.addEventListener("input", propagateGlobalThreshold);

// ---------- Load domains.yaml ----------

const yamlInput = document.getElementById("yaml-input");
const yamlStatus = document.getElementById("yaml-status");

loadYamlBtn.addEventListener("click", () => yamlInput.click());

yamlInput.addEventListener("change", async () => {
  if (!yamlInput.files.length) return;
  const file = yamlInput.files[0];
  yamlStatus.textContent = "Parsing...";
  yamlStatus.classList.remove("error");

  const form = new FormData();
  form.append("config", file);

  try {
    const res = await fetch("/api/parse-domains-yaml", { method: "POST", body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || res.statusText);

    applyGlobalParams(data.global);

    domainsContainer.innerHTML = "";
    Object.entries(data.domains).forEach(([name, spec]) => {
      addDomainRow({ name });
      applyDomainSpecToRow(domainsContainer.lastElementChild, spec);
    });
    updateEnvelopeCount();
    generateBtn.disabled = document.querySelectorAll(".domain-row").length === 0;

    yamlStatus.textContent = `Loaded ${Object.keys(data.domains).length} domain(s) from ${file.name}.`;
  } catch (err) {
    yamlStatus.textContent = `Error: ${err.message}`;
    yamlStatus.classList.add("error");
  } finally {
    yamlInput.value = "";
  }
});

// ---------- Save / load full session state ----------

const SESSION_STATE_VERSION = 1;
const saveStateBtn = document.getElementById("save-state-btn");
const loadStateBtn = document.getElementById("load-state-btn");
const stateInput = document.getElementById("state-input");
const stateStatus = document.getElementById("state-status");

function collectDisplayState() {
  return {
    background: backgroundSelect.value,
    showStructure: showStructureCheckbox.checked,
    surfaceStyle: surfaceStyleSelect.value,
    snapshotBackground: snapshotBackgroundSelect.value,
    snapshotResolution: snapshotResolutionSelect.value,
    snapshotFormat: snapshotFormatSelect.value,
    themeAccent: themeSwatch.value,
  };
}

function applyDisplayState(display) {
  if (!display) return;
  if (display.background) {
    backgroundSelect.value = display.background;
    applyBackground(display.background);
  }
  if (typeof display.showStructure === "boolean") {
    showStructureCheckbox.checked = display.showStructure;
    applyStructureVisibility(display.showStructure);
  }
  if (display.surfaceStyle) {
    surfaceStyleSelect.value = display.surfaceStyle;
    applySurfaceStyle(display.surfaceStyle);
  }
  if (display.snapshotBackground) snapshotBackgroundSelect.value = display.snapshotBackground;
  if (display.snapshotResolution) snapshotResolutionSelect.value = display.snapshotResolution;
  if (display.snapshotFormat) snapshotFormatSelect.value = display.snapshotFormat;
  if (display.themeAccent) {
    themeSwatch.value = display.themeAccent;
    applyThemeColor(display.themeAccent);
  }
}

saveStateBtn.addEventListener("click", async () => {
  if (!state.file) {
    stateStatus.textContent = "Upload a PDB first.";
    stateStatus.classList.add("error");
    return;
  }
  stateStatus.classList.remove("error");
  stateStatus.textContent = "Saving...";
  try {
    const pdbContent = await state.file.text();
    const payload = {
      version: SESSION_STATE_VERSION,
      pdb_filename: state.file.name,
      pdb_content: pdbContent,
      global: collectGlobal(),
      domains: collectDomainsRaw(),
      display: collectDisplayState(),
    };
    const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `envelope_state_${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    stateStatus.textContent = "State saved.";
  } catch (err) {
    stateStatus.textContent = `Error: ${err.message}`;
    stateStatus.classList.add("error");
  }
});

loadStateBtn.addEventListener("click", () => stateInput.click());

stateInput.addEventListener("change", async () => {
  if (!stateInput.files.length) return;
  const file = stateInput.files[0];
  stateStatus.textContent = "Loading...";
  stateStatus.classList.remove("error");
  try {
    const text = await file.text();
    const saved = JSON.parse(text);
    if (!saved.pdb_content || !saved.domains) throw new Error("Not a valid state file.");

    const pdbFile = new File([saved.pdb_content], saved.pdb_filename || "structure.pdb", { type: "text/plain" });
    await handleFile(pdbFile);

    applyGlobalParams(saved.global);

    domainsContainer.innerHTML = "";
    saved.domains.forEach((spec) => {
      addDomainRow({ name: spec.name });
      applyDomainSpecToRow(domainsContainer.lastElementChild, spec);
    });
    updateEnvelopeCount();
    generateBtn.disabled = document.querySelectorAll(".domain-row").length === 0;

    applyDisplayState(saved.display);

    stateStatus.textContent = `Loaded state from ${file.name} (${saved.domains.length} domain(s)).`;
  } catch (err) {
    stateStatus.textContent = `Error: ${err.message}`;
    stateStatus.classList.add("error");
  } finally {
    stateInput.value = "";
  }
});

function applyGlobalParams(global) {
  document.getElementById("g-sigma").value = global.sigma;
  document.getElementById("g-smoothing").value = global.smoothing_iterations;
  document.getElementById("g-decimate").value = global.decimate_faces;
  document.getElementById("g-spacing").value = global.grid_spacing;
  document.getElementById("g-basis").value = global.basis;
  if (global.threshold === "auto") {
    gThresholdMode.value = "auto";
    gThresholdValue.value = "";
    gThresholdValue.disabled = true;
  } else {
    gThresholdMode.value = "manual";
    gThresholdValue.value = global.threshold;
    gThresholdValue.disabled = false;
  }
}

function applyDomainSpecToRow(row, spec) {
  row.querySelector(".d-color").value = rgb01ToHex(spec.color);
  row.querySelector(".d-transparency").value = spec.transparency;
  row.querySelector(".d-transparency-val").textContent = spec.transparency;
  row.querySelector(".d-resid").value = Array.isArray(spec.resid) ? spec.resid.join(",") : (spec.resid || "");
  row.querySelector(".d-show-structure").checked = spec.showStructure !== false;

  const wantedSegids = new Set(
    spec.segid ? (Array.isArray(spec.segid) ? spec.segid : [spec.segid]) : Object.keys(state.segInfo)
  );
  row.querySelectorAll(".chain-chip").forEach((chip) => {
    chip.classList.toggle("selected", wantedSegids.has(chip.dataset.segid));
  });
  renderRangeChipsForRow(row);

  // Loaded values that differ from the current global default are treated
  // as intentional per-domain overrides (e.g. from a YAML file) and won't
  // get silently overwritten if the global value is changed afterward.
  const specKeys = {
    "d-sigma": "sigma",
    "d-smoothing": "smoothing_iterations",
    "d-decimate": "decimate_faces",
    "d-spacing": "grid_spacing",
    "d-basis": "basis",
  };
  SYNCED_FIELDS.forEach(({ global, domainClass }) => {
    const input = row.querySelector(`.${domainClass}`);
    const value = spec[specKeys[domainClass]];
    input.value = value;
    delete input.dataset.overridden;
    if (valuesDiffer(value, document.getElementById(global).value)) markOverridden(input);
  });

  const thresholdMode = row.querySelector(".d-threshold-mode");
  const thresholdValue = row.querySelector(".d-threshold-value");
  if (spec.threshold === "auto") {
    thresholdMode.value = "auto";
    thresholdValue.value = "";
    thresholdValue.disabled = true;
  } else {
    thresholdMode.value = "manual";
    thresholdValue.value = spec.threshold;
    thresholdValue.disabled = false;
  }
  delete thresholdMode.dataset.overridden;
  const globalThresholdStr = gThresholdMode.value === "auto" ? "auto" : String(gThresholdValue.value);
  const specThresholdStr = spec.threshold === "auto" ? "auto" : String(spec.threshold);
  if (specThresholdStr !== globalThresholdStr) markOverridden(thresholdMode);

  updateOverrideBadge(row);
  updateChainToggleAllState(row);
  updateDomainColoring();
}

// ---------- Collect form -> request payload ----------

function rgb01ToHex(rgb) {
  const toHex = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");
  return `#${toHex(rgb[0])}${toHex(rgb[1])}${toHex(rgb[2])}`;
}

function hexToRgb01(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return [round3(r), round3(g), round3(b)];
}
function round3(x) { return Math.round(x * 1000) / 1000; }

function collectGlobal() {
  return {
    sigma: parseFloat(document.getElementById("g-sigma").value),
    smoothing_iterations: parseInt(document.getElementById("g-smoothing").value, 10),
    decimate_faces: parseInt(document.getElementById("g-decimate").value, 10),
    grid_spacing: parseFloat(document.getElementById("g-spacing").value),
    threshold: gThresholdMode.value === "manual" ? parseFloat(gThresholdValue.value) : "auto",
    basis: document.getElementById("g-basis").value,
  };
}

// Reads all domain rows and expands each into one entry per selected chain
// (plain name if only one chain is selected; chain-suffixed name otherwise).
// Rows with zero chains selected are silently skipped -- not an error, just
// nothing to generate for that domain.
function collectDomains() {
  const rows = Array.from(document.querySelectorAll(".domain-row"));
  const domains = [];
  rows.forEach((row) => {
    const chains = selectedChains(row);
    if (chains.length === 0) return;

    const name = row.querySelector(".d-name").value.trim();
    const resid = row.querySelector(".d-resid").value.trim();
    const color = hexToRgb01(row.querySelector(".d-color").value);
    const transparency = parseFloat(row.querySelector(".d-transparency").value);

    const params = {
      sigma: parseFloat(row.querySelector(".d-sigma").value),
      smoothing_iterations: parseInt(row.querySelector(".d-smoothing").value, 10),
      decimate_faces: parseInt(row.querySelector(".d-decimate").value, 10),
      grid_spacing: parseFloat(row.querySelector(".d-spacing").value),
      basis: row.querySelector(".d-basis").value,
    };
    const thMode = row.querySelector(".d-threshold-mode").value;
    params.threshold = thMode === "manual"
      ? parseFloat(row.querySelector(".d-threshold-value").value)
      : "auto";

    chains.forEach((seg) => {
      const resultName = chains.length > 1 ? `${name}_${seg}` : name;
      domains.push({
        name: resultName,
        segid: [seg],
        resid: resid || null,
        color,
        transparency,
        ...params,
      });
    });
  });
  return domains;
}

// Reads all domain rows as-is (one entry per row, chains kept as a list,
// not expanded per chain) -- the same shape applyDomainSpecToRow expects,
// used for round-tripping through a saved session state.
function collectDomainsRaw() {
  return Array.from(document.querySelectorAll(".domain-row")).map((row) => ({
    name: row.querySelector(".d-name").value.trim(),
    segid: selectedChains(row),
    resid: row.querySelector(".d-resid").value.trim() || null,
    color: hexToRgb01(row.querySelector(".d-color").value),
    transparency: parseFloat(row.querySelector(".d-transparency").value),
    showStructure: row.querySelector(".d-show-structure").checked,
    sigma: parseFloat(row.querySelector(".d-sigma").value),
    smoothing_iterations: parseInt(row.querySelector(".d-smoothing").value, 10),
    decimate_faces: parseInt(row.querySelector(".d-decimate").value, 10),
    grid_spacing: parseFloat(row.querySelector(".d-spacing").value),
    basis: row.querySelector(".d-basis").value,
    threshold: row.querySelector(".d-threshold-mode").value === "manual"
      ? parseFloat(row.querySelector(".d-threshold-value").value)
      : "auto",
  }));
}

// ---------- Generate ----------

const generateStatus = document.getElementById("generate-status");
const downloadsBlock = document.getElementById("downloads-block");
const downloadsList = document.getElementById("downloads");
const logPre = document.getElementById("log");
const progressWrap = document.getElementById("progress-wrap");
const progressFill = document.getElementById("progress-bar-fill");
const progressLabel = document.getElementById("progress-label");

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function countCompletedDomains(logLines) {
  return logLines.filter((l) => l.includes("faces, vol=")).length;
}

function showProgress(totalDomains) {
  progressWrap.hidden = false;
  progressFill.classList.remove("indeterminate");
  progressFill.style.width = "2%";
  progressLabel.textContent = `0 / ${totalDomains} envelopes · 0.0s`;
}

function updateProgress(logLines, totalDomains, elapsed) {
  const done = countCompletedDomains(logLines);
  const pct = totalDomains > 0 ? Math.max(4, Math.min(100, (done / totalDomains) * 100)) : 4;
  progressFill.style.width = `${pct}%`;
  progressLabel.textContent = `${done} / ${totalDomains} envelopes · ${elapsed.toFixed(1)}s`;
}

function finishProgress(elapsed) {
  progressFill.style.width = "100%";
  progressLabel.textContent = `Done · ${elapsed.toFixed(1)}s`;
  setTimeout(() => { progressWrap.hidden = true; }, 1200);
}

generateBtn.addEventListener("click", async () => {
  if (!state.sessionId) {
    generateStatus.textContent = "Upload a PDB first.";
    generateStatus.classList.add("error");
    return;
  }
  // Domains with no chain selected are silently skipped, not an error --
  // only complain if that leaves nothing at all to generate.
  const domains = collectDomains();
  if (domains.length === 0) {
    generateStatus.textContent = "No domain has a chain selected -- nothing to generate.";
    generateStatus.classList.add("error");
    return;
  }
  if (domains.some((d) => !d.name)) {
    generateStatus.textContent = "Every domain needs a name.";
    generateStatus.classList.add("error");
    return;
  }

  generateBtn.disabled = true;
  generateStatus.classList.remove("error");
  generateStatus.textContent = "";
  showProgress(domains.length);

  const payload = {
    session_id: state.sessionId,
    global: collectGlobal(),
    domains,
  };

  try {
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || res.statusText);

    const jobId = data.job_id;
    let statusData;
    while (true) {
      await sleep(400);
      const statusRes = await fetch(`/api/generate/${jobId}`);
      statusData = await statusRes.json();
      updateProgress(statusData.log, data.total_domains, statusData.elapsed);
      if (statusData.status === "done" || statusData.status === "error") break;
    }

    if (statusData.status === "error") throw new Error(statusData.error);

    finishProgress(statusData.elapsed);
    const result = statusData.result;
    generateStatus.textContent = `Done: ${result.domains.length} envelope(s) generated in ${statusData.elapsed.toFixed(1)}s.`;
    renderMeshes(result.domains);
    renderDownloads(result);
    renderLog(statusData.log);
  } catch (err) {
    progressWrap.hidden = true;
    generateStatus.textContent = `Error: ${err.message}`;
    generateStatus.classList.add("error");
  } finally {
    generateBtn.disabled = false;
  }
});

function clearShapes() {
  state.shapeComps.forEach((c) => stage.removeComponent(c));
  state.shapeComps = [];
}

function renderMeshes(domains) {
  clearShapes();
  domains.forEach((d) => {
    const position = new Float32Array(d.vertices);
    const index = new Uint32Array(d.faces);
    const normal = new Float32Array(d.normals);

    const color = new Float32Array(d.n_verts * 3);
    for (let i = 0; i < d.n_verts; i++) {
      color[i * 3] = d.color[0];
      color[i * 3 + 1] = d.color[1];
      color[i * 3 + 2] = d.color[2];
    }

    const shape = new NGL.Shape(`env_${d.name}`);
    shape.addMesh(position, color, index, normal, d.name);
    const shapeComp = stage.addComponentFromObject(shape);
    shapeComp.addRepresentation("buffer", {
      opacity: 1 - d.transparency,
      side: "double",
      openBackface: true,
      ...(SURFACE_STYLES[surfaceStyleSelect.value] || SURFACE_STYLES.plastic),
    });
    state.shapeComps.push(shapeComp);
  });
  stage.autoView();
}

function renderDownloads(data) {
  downloadsList.innerHTML = "";
  data.domains.forEach((d) => {
    const li = document.createElement("li");

    const nameDiv = document.createElement("div");
    nameDiv.className = "dl-name";
    nameDiv.textContent = d.name;
    li.appendChild(nameDiv);

    const a = document.createElement("a");
    a.href = d.obj_url;
    a.download = `${d.name}_envelope.obj`;
    a.textContent = "viewer .obj";
    li.appendChild(a);

    const highres = document.createElement("span");
    highres.className = "dl-highres";
    highres.append("high-res: ");
    ["obj", "stl", "ply", "glb"].forEach((fmt, i) => {
      if (i > 0) highres.append(" · ");
      const link = document.createElement("a");
      link.href = d.highres_urls[fmt];
      link.download = `${d.name}_highres.${fmt}`;
      link.textContent = fmt;
      highres.appendChild(link);
    });
    li.appendChild(highres);

    const vol = document.createElement("span");
    vol.className = "vol";
    vol.textContent = `${d.n_verts}v / ${d.n_faces}f / ${d.volume.toFixed(0)} Å³`;
    li.appendChild(vol);

    downloadsList.appendChild(li);
  });

  const li = document.createElement("li");
  const a = document.createElement("a");
  a.href = data.scene_py_url;
  a.download = "scene.py";
  a.textContent = "scene.py (PyMOL script, all domains)";
  li.appendChild(a);
  downloadsList.appendChild(li);

  downloadsBlock.hidden = false;
}

function renderLog(lines) {
  logPre.textContent = (lines || []).join("\n");
}

initViewer();
