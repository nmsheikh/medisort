// medisort front-end: upload -> OCR review -> extract & sort -> download.
// All processing happens on this device via engine/engine.mjs (OCR, PDF
// building) - nothing is ever uploaded anywhere.
import { handle } from "./engine/engine.mjs";

const DESKTOP = document.body.dataset.desktop === "1";
const $ = (id) => document.getElementById(id);
const esc = (s) => (s ?? "").toString().replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`);

async function post(url, fd) {
  return handle(url, fd);
}

let files = [];
let medUnits = [];
let claimRows = [];
let downloadUrl = null;

const BILL_TYPE_LABELS = {
  doctor: "Doctor bill", prescription: "Prescription", medicine: "Medicine bill",
  other: "Other (medical)", "not-medical": "Not a medical document",
};
const CLAIM_COLUMNS = [
  ["familyMember", "Family Member"], ["birthDate", "Birth Date"], ["gender", "Gender"],
  ["doctorName", "Doctor Name"], ["qualification", "Doctor Qualification"], ["billNumber", "Bill Number"],
  ["consultationDate", "Consultation Date"], ["billDate", "Bill Date"], ["natureOfClaim", "Nature of Claim"],
  ["medicalAppliance", "Medical Appliance"], ["applicantRemark", "Applicant Remark"], ["facility", "Name of Pharmacy/Hospital/Laboratory"],
  ["amount", "Requested Amount"],
];

// ---------- file upload ----------

function showError(msg) {
  const el = $("errorMsg");
  el.textContent = msg || "";
  el.hidden = !msg;
}

function warnOnDropzone(message) {
  const el = $("dzWarn");
  el.textContent = message;
  el.hidden = false;
  setTimeout(() => { el.hidden = true; }, 6000);
}

function addFiles(list) {
  const incoming = [...list].filter((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name) || f.type.startsWith("image/"));
  if (incoming.length !== list.length) warnOnDropzone("Only PDFs and images are accepted - other files were skipped.");
  if (!incoming.length) return;
  files.push(...incoming);
  $("fileInput").value = "";
  renderFileList();
  $("stepUpload").hidden = true;
  $("stepReview").hidden = false;
  initMedicalReview();
}

function renderFileList() {
  const list = $("fileList");
  list.innerHTML = files.map((f, i) => `
    <div class="file-row" data-i="${i}">
      <span class="fname" title="${esc(f.name)}">${esc(f.name)}</span>
      <span class="fsize">${fmtSize(f.size)}</span>
      <button type="button" class="mini" data-act="del" data-i="${i}" title="Remove" aria-label="Remove">${xIcon()}</button>
    </div>`).join("") + `
    <button type="button" class="add-tile" id="addTile">
      <span class="add-plus">${plusIcon()}</span>
      <span>Add more files</span>
    </button>`;

  $("addTile").addEventListener("click", pickMoreFiles);
  list.querySelectorAll("[data-act='del']").forEach((b) => b.addEventListener("click", () => {
    const i = +b.dataset.i;
    files.splice(i, 1);
    if (!files.length) return startOver();
    renderFileList();
    initMedicalReview();
  }));

  $("filesCount").textContent = files.length === 1 ? files[0].name : `${files.length} files`;
}

function pickMoreFiles() {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.accept = "application/pdf,image/*";
  input.addEventListener("change", () => addFiles(input.files));
  input.click();
}

function startOver() {
  files = [];
  medUnits = [];
  claimRows = [];
  showError("");
  $("stepReview").hidden = true;
  $("stepDone").hidden = true;
  $("stepUpload").hidden = false;
}

const dropzone = $("dropzone");
$("fileInput").addEventListener("change", (e) => addFiles(e.target.files));
dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("drag"); });
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("drag"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("drag");
  addFiles(e.dataTransfer.files);
});
$("startOverBtn").addEventListener("click", startOver);

// ---------- OCR review grid ----------

function initMedicalReview() {
  medUnits = [];
  claimRows = [];
  $("claimsWrap").hidden = true;
  $("downloadPdfBtn").hidden = true;
  showError("");

  const grid = $("pageGrid");
  grid.innerHTML = `<div class="pages-msg"><div class="spinner"></div><span id="progressMsg">Reading pages…</span></div>`;
  const onProgress = (e) => { const el = $("progressMsg"); if (el) el.textContent = e.detail.message; };
  window.addEventListener("medisort:progress", onProgress);

  (async () => {
    try {
      const fd = new FormData();
      files.forEach((f) => fd.append("files", f));
      const res = await post("/api/analyze-medical-bills", fd);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Something went wrong.");
      medUnits = data.units;
      sortMedUnits();
      renderMedicalReview();
      $("extractSortBtn").disabled = false;
    } catch (e) {
      grid.innerHTML = `<div class="pages-msg">${esc(e.message)}</div>`;
    } finally {
      window.removeEventListener("medisort:progress", onProgress);
    }
  })();
}

// Same date-then-type ordering finalize uses to build the PDF, applied here
// too so the review grid always shows the order the final PDF will come out in.
function sortMedUnits() {
  const typeOrder = Object.keys(BILL_TYPE_LABELS);
  const typeRank = (t) => { const i = typeOrder.indexOf(t); return i === -1 ? typeOrder.length : i; };
  medUnits.sort((a, b) => {
    const byDate = (a.date || "9999-99-99").localeCompare(b.date || "9999-99-99");
    return byDate || typeRank(a.type) - typeRank(b.type);
  });
}

function eyeIcon() {
  return '<svg class="ui badge-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
}
function plusIcon() {
  return '<svg class="ui" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg>';
}
function xIcon() {
  return '<svg class="ui" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
}

function renderMedicalReview() {
  const grid = $("pageGrid");
  grid.innerHTML = medUnits.map((u, i) => {
    const notMedical = u.type === "not-medical";
    const flagged = !u.date || u.type === "other" || notMedical;
    return `
    <div class="page med-page${flagged ? " needs-review" : ""}" data-i="${i}">
      <img src="${u.thumb}" alt="Page ${i + 1}">
      ${flagged ? `<span class="badge med-flag">${eyeIcon()} ${notMedical ? "Not medical" : "Needs review"}</span>` : ""}
      <div class="med-fields">
        <select data-field="type" aria-label="Document type">
          ${Object.entries(BILL_TYPE_LABELS).map(([v, label]) => `<option value="${v}" ${u.type === v ? "selected" : ""}>${esc(label)}</option>`).join("")}
        </select>
        <input type="date" data-field="date" value="${u.date || ""}" aria-label="Document date">
      </div>
    </div>`;
  }).join("") || `<div class="pages-msg">No pages found.</div>`;

  grid.querySelectorAll(".med-page").forEach((card) => {
    const i = +card.dataset.i;
    card.querySelectorAll("[data-field]").forEach((el) => el.addEventListener("change", () => {
      medUnits[i][el.dataset.field] = el.value || null;
      sortMedUnits();
      renderMedicalReview();
      // A correction here can change the sort order or a claim field the table
      // already extracted - make the person re-run "Extract and sort" rather than
      // downloading a PDF that no longer matches what the table shows.
      $("claimsWrap").hidden = true;
      $("downloadPdfBtn").hidden = true;
    }));
  });

  const flaggedCount = medUnits.filter((u) => !u.date || u.type === "other" || u.type === "not-medical").length;
  $("medCount").textContent = `${medUnits.length} page${medUnits.length === 1 ? "" : "s"}${flaggedCount ? `, ${flaggedCount} need${flaggedCount === 1 ? "s" : ""} review` : ""}`;
}

// ---------- claims data grid ----------

function claimRowFromUnit(u) {
  return {
    familyMember: "", birthDate: "", gender: "",
    doctorName: u.doctorName || "", qualification: u.qualification || "", billNumber: u.billNumber || "",
    consultationDate: (u.type === "doctor" || u.type === "prescription") ? (u.date || "") : "",
    billDate: u.type === "medicine" ? (u.date || "") : "",
    natureOfClaim: "", medicalAppliance: "", applicantRemark: "",
    facility: u.facility || "", exceptionAllowed: false, amount: u.amount || "",
  };
}
const blankClaimRow = () => claimRowFromUnit({});

function renderClaimsGrid() {
  const table = $("claimsGrid");
  const head = `<tr><th>Line No.</th>${CLAIM_COLUMNS.map(([, label]) => `<th>${esc(label)}</th>`).join("")}<th>Exception Allowed</th></tr>`;
  const body = claimRows.map((row, i) => `
    <tr data-i="${i}">
      <td class="claim-line">${String(i + 1).padStart(4, "0")}</td>
      ${CLAIM_COLUMNS.map(([key]) => `<td><input data-field="${key}" value="${esc(row[key] || "")}"></td>`).join("")}
      <td class="claim-check"><input type="checkbox" data-field="exceptionAllowed" ${row.exceptionAllowed ? "checked" : ""}></td>
    </tr>`).join("");
  table.innerHTML = head + body;

  table.querySelectorAll("tr[data-i] input").forEach((el) => el.addEventListener("change", () => {
    const i = +el.closest("tr").dataset.i;
    claimRows[i][el.dataset.field] = el.type === "checkbox" ? el.checked : el.value;
  }));
  table.querySelectorAll("tr[data-i]").forEach((tr) => tr.addEventListener("focusin", () => {
    table.querySelectorAll("tr").forEach((r) => r.classList.remove("selected"));
    tr.classList.add("selected");
  }));
  $("claimTotal").textContent = "";
}

$("claimAddLine").addEventListener("click", () => { claimRows.push(blankClaimRow()); renderClaimsGrid(); });
$("claimDelLine").addEventListener("click", () => {
  const selected = $("claimsGrid").querySelector("tr.selected");
  const i = selected ? +selected.dataset.i : claimRows.length - 1;
  if (i >= 0) claimRows.splice(i, 1);
  renderClaimsGrid();
});
$("claimCalc").addEventListener("click", () => {
  const total = claimRows.reduce((sum, r) => sum + (parseFloat(r.amount) || 0), 0);
  $("claimTotal").textContent = `Total requested amount: ${total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
});
$("extractSortBtn").addEventListener("click", () => {
  claimRows = medUnits.map((u) => claimRowFromUnit(u));
  renderClaimsGrid();
  $("claimsWrap").hidden = false;
  $("downloadPdfBtn").hidden = false;
});

// ---------- build & download the PDF ----------

$("downloadPdfBtn").addEventListener("click", async () => {
  if (medUnits.some((u) => !u.date)) return showError("Set the date for every page flagged for review.");
  if (medUnits.some((u) => u.type === "other" || u.type === "not-medical")) {
    return showError("Set the document type for every page flagged for review.");
  }
  showError("");
  $("downloadPdfBtn").disabled = true;
  $("downloadPdfBtn").textContent = "Building…";
  try {
    const fd = new FormData();
    files.forEach((f) => fd.append("files", f));
    fd.append("plan", JSON.stringify(medUnits.map((u) => (
      { fileIndex: u.fileIndex, pageIndex: u.pageIndex, date: u.date, type: u.type, rotation: u.rotation }))));
    const res = await post("/api/finalize-medical-bills", fd);
    if (!res.ok) { const data = await res.json(); throw new Error(data.error || "Something went wrong."); }
    const blob = await res.blob();
    const name = "medical-records.pdf";
    const meta = `${name} · ${fmtSize(blob.size)} · ${medUnits.length} page${medUnits.length === 1 ? "" : "s"}`;
    $("stepReview").hidden = true;
    $("stepDone").hidden = false;
    if (DESKTOP) {
      // Desktop app: ask where to save with a native Save dialog (Tauri command
      // in src-tauri), same as pdforge's own desktop build.
      $("saveBtn").hidden = true;
      try {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const path = await window.__TAURI__.core.invoke("save_file", bytes, {
          headers: { "x-filename": encodeURIComponent(name) },
        });
        $("doneMeta").textContent = path ? `Saved to ${path}` : meta;
      } catch (err) {
        showError(`Couldn't save the file: ${err}`);
      }
    } else {
      $("saveBtn").hidden = false;
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
      downloadUrl = URL.createObjectURL(blob);
      $("saveBtn").href = downloadUrl;
      $("saveBtn").download = name;
      $("doneMeta").textContent = meta;
    }
  } catch (e) {
    showError(e.message);
  } finally {
    $("downloadPdfBtn").disabled = false;
    $("downloadPdfBtn").textContent = "Download PDF";
  }
});

$("againBtn").addEventListener("click", startOver);
