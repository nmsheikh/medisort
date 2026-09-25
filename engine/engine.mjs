// medisort engine: OCRs each uploaded page/image, sorts them into one PDF by
// date (doctor bill, then prescription, then medicine bill), and pulls
// claim-form fields out of the text. Runs entirely on the user's device -
// nothing is uploaded anywhere. Same code powers the website and the
// desktop app.
import { PDFDocument, degrees } from "../vendor/pdf-lib.esm.min.js";
import * as pdfjs from "../vendor/pdf.min.mjs";

pdfjs.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdf.worker.min.mjs", import.meta.url).href;

const THUMB_WIDTH = 180;
const LOAD = { updateMetadata: false }; // don't stamp "pdf-lib" as producer

class ToolError extends Error {}

// ---------- request/response helpers ----------

const str = (fd, name, dflt = "") => (fd.get(name) ?? dflt).toString();
const isPdfLike = (f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function sendBytes(bytes, filename) {
  return new Response(new Blob([bytes], { type: "application/pdf" }), {
    headers: { "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}` },
  });
}

const save = (doc) => doc.save({ useObjectStreams: true });

// ---------- PDF/page helpers ----------

async function loadPdf(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    return await PDFDocument.load(bytes, LOAD);
  } catch (_) {
    throw new ToolError(`'${file.name}' is not a valid PDF file, or it's password-protected.`);
  }
}

async function openPdfjs(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  try {
    return await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  } catch (e) {
    if (e?.name === "PasswordException") throw new ToolError(`'${file.name}' is password-protected.`);
    throw new ToolError(`Couldn't open '${file.name}'. Is it a damaged PDF?`);
  }
}

function closePdfjs(doc) {
  // pdf.js v6 frees a document through its loading task.
  (doc.loadingTask || doc).destroy?.();
}

async function renderPage(page, scale) {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // "print" intent renders without requestAnimationFrame, so it keeps going
  // even when the window or tab is in the background.
  await page.render({ canvas, canvasContext: ctx, viewport, intent: "print" }).promise;
  return canvas;
}

const canvasBytes = (canvas, type, quality) => new Promise((resolve, reject) =>
  canvas.toBlob((b) => (b ? b.arrayBuffer().then((ab) => resolve(new Uint8Array(ab))) : reject(new Error("Image encoding failed"))), type, quality));

function pageRotation(page) {
  return ((page.getRotation().angle % 360) + 360) % 360;
}

function rotateCanvas(canvas, angle) {
  if (!angle) return canvas;
  const swap = angle % 180 !== 0;
  const out = document.createElement("canvas");
  out.width = swap ? canvas.height : canvas.width;
  out.height = swap ? canvas.width : canvas.height;
  const ctx = out.getContext("2d");
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate((angle * Math.PI) / 180);
  ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  return out;
}

// A small preview image for the review grid - separate from the full-resolution
// canvas used for OCR, so the JSON response stays a reasonable size.
function canvasThumb(canvas, maxWidth = THUMB_WIDTH) {
  const scale = Math.min(1, maxWidth / canvas.width);
  const w = Math.max(1, Math.round(canvas.width * scale)), h = Math.max(1, Math.round(canvas.height * scale));
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  out.getContext("2d").drawImage(canvas, 0, 0, w, h);
  return out.toDataURL("image/jpeg", 0.7);
}

// ---------- date extraction ----------

const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4,
  jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8,
  oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

// Best-effort: pull the first recognizable date out of noisy OCR text. Returns a
// Date, or null. No date in the text is a normal outcome (blank page, no date visible).
// Real bills routinely have several dates on one page (a patient's date of
// birth, a bill date, an admission/discharge date, a medicine's expiry date...).
// Grabbing the first date-shaped text anywhere is how a DOB or an expiry date
// ends up mistaken for the bill's own date. Instead, find every date-shaped
// match, then use the label text just before each one to exclude the ones that
// are never the right answer (DOB, expiry) and prefer the ones that are.
function extractDate(text) {
  const t = (text || "").replace(/\s+/g, " ");
  const validDay = (d) => d >= 1 && d <= 31;
  const MIN_YEAR = 1990, MAX_YEAR = new Date().getFullYear() + 1;
  const build = (year, month, day) => {
    if (!validDay(day) || month < 0 || month > 11) return null;
    if (year < MIN_YEAR || year > MAX_YEAR) return null; // rejects OCR-garbled years like "3060"
    const d = new Date(year, month, day);
    return d.getMonth() === month ? d : null; // rejects e.g. 31 Feb rolling into March
  };
  const normYear = (y) => (y < 100 ? y + (y < 50 ? 2000 : 1900) : y);

  const PATTERNS = [
    { re: /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g, parse: (m) => build(+m[1], +m[2] - 1, +m[3]) },
    {
      re: /\b(\d{1,2})(?:st|nd|rd|th)?[\s.-]+([A-Za-z]{3,9})\.?[\s,.-]*(\d{2,4})?\b/g,
      parse: (m) => (MONTHS[m[2].toLowerCase()] !== undefined
        ? build(m[3] ? normYear(+m[3]) : new Date().getFullYear(), MONTHS[m[2].toLowerCase()], +m[1]) : null),
    },
    {
      re: /\b([A-Za-z]{3,9})\.?[\s.-]+(\d{1,2})(?:st|nd|rd|th)?[\s,.-]*(\d{2,4})?\b/g,
      parse: (m) => (MONTHS[m[1].toLowerCase()] !== undefined
        ? build(m[3] ? normYear(+m[3]) : new Date().getFullYear(), MONTHS[m[1].toLowerCase()], +m[2]) : null),
    },
    {
      re: /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/g,
      parse: (m) => {
        const year = normYear(+m[3]);
        // Day-first (DD/MM/YYYY) unless the first number can't be a month, in
        // which case it must be interpreted month-first instead.
        return build(year, +m[2] - 1, +m[1]) || build(year, +m[1] - 1, +m[2]);
      },
    },
  ];

  const candidates = [];
  for (const { re, parse } of PATTERNS) {
    for (const m of t.matchAll(re)) {
      const date = parse(m);
      if (date) candidates.push({ date, index: m.index });
    }
  }
  if (!candidates.length) return null;

  const contextBefore = (index) => t.slice(Math.max(0, index - 30), index);
  const NEVER_THE_DATE = /\b(dob|date of birth|birth|expiry|exp\.?\s*date|mfg|manufactur)/i;
  const LOWER_PRIORITY = /\b(admission date|discharge date)\b/i;

  const usable = candidates.filter((c) => !NEVER_THE_DATE.test(contextBefore(c.index)));
  const pool = usable.length ? usable : candidates; // never return nothing just because every date looked excluded
  const preferred = pool.find((c) => !LOWER_PRIORITY.test(contextBefore(c.index)));
  return (preferred || pool[0]).date;
}

// ---------- document classification ----------

// sub-order for same-day documents; "not-medical" always sorts last
const BILL_TYPES = ["doctor", "prescription", "medicine", "other", "not-medical"];
const BILL_KEYWORDS = {
  doctor: ["consultation", "consult", "opd", "visit fee", "doctor", "dr.", "physician", "clinic", "checkup", "check-up"],
  prescription: ["prescription", "rx", "prescribed", "sig:", "dosage", "take as directed", "refill"],
  medicine: ["pharmacy", "medicine", "medicines", "tablet", "capsule", "syrup", "chemist", "drug store", "mrp", "batch no"],
};
// Broader than BILL_KEYWORDS: any hint at all that this is a medical/health
// document, even if it doesn't clearly say which of the three sub-types it is.
const MEDICAL_SIGNAL_WORDS = [
  ...BILL_KEYWORDS.doctor, ...BILL_KEYWORDS.prescription, ...BILL_KEYWORDS.medicine,
  "hospital", "medical", "health", "patient", "diagnosis", "treatment", "lab test",
  "laboratory", "nursing home", "surgeon", "surgery", "ward", "admission", "discharge summary",
];

// Keyword-count classification: whichever sub-type has the most hits wins. No hits
// at all for doctor/prescription/medicine, but SOME broader medical signal, means
// "other" (a medical document, just an unclear kind) - flagged for the user to
// assign by hand. No medical signal at all means "not-medical": this filters out
// files that clearly aren't hospital/pharmacy paperwork (a random photo, an
// unrelated PDF) instead of quietly treating them as just another "other" bill.
// A resume/CV can easily mention "clinic", "patient care" or "health" from someone's
// work history, which would otherwise score as a medical document. Structural resume
// wording (2+ hits) overrides any keyword match below - nobody's CV is a hospital bill.
const RESUME_SIGNAL_WORDS = [
  "resume", "curriculum vitae", "career objective", "professional summary", "work experience",
  "employment history", "references available", "linkedin.com/in/", "objective:", "education:", "skills:",
];
function looksLikeResume(t) {
  return RESUME_SIGNAL_WORDS.reduce((n, kw) => n + (t.includes(kw) ? 1 : 0), 0) >= 2;
}

function classifyBillType(text) {
  const t = (text || "").toLowerCase();
  if (looksLikeResume(t)) return "not-medical";
  let best = "other", bestScore = 0;
  for (const type of ["doctor", "prescription", "medicine"]) {
    const score = BILL_KEYWORDS[type].reduce((n, kw) => n + (t.includes(kw) ? 1 : 0), 0);
    if (score > bestScore) { best = type; bestScore = score; }
  }
  if (bestScore > 0) return best;
  return MEDICAL_SIGNAL_WORDS.some((kw) => t.includes(kw)) ? "other" : "not-medical";
}

// ---------- claims-data extraction (best-effort regex) ----------

const QUALIFICATIONS = ["MBBS", "MD", "MS", "DNB", "DM", "BDS", "MRCP", "FRCS", "BAMS", "BHMS", "MCh", "DGO"];

// Drop a leading "Dr"/OCR-misread "Or" title (so the field holds just the name,
// not "Dr. X") and a trailing qualification the match swept up ("Dr. Kumar MBBS").
// Rejects a garbage/blank capture (a stray "-" or "." where a name should be).
function cleanDoctorName(raw) {
  const s = (raw || "").trim().replace(/^(?:dr|or)\.?\s*/i, "").trim();
  const words = s.split(/\s+/).filter(Boolean);
  while (words.length > 1 && QUALIFICATIONS.includes(words[words.length - 1].replace(/[.,]$/, "").toUpperCase())) {
    words.pop();
  }
  const name = words.join(" ").replace(/[.,]$/, "").trim();
  return /[A-Za-z]{2,}/.test(name) ? name : "";
}

// Labeled fields ("Consultant:", "Doctor Name:") are tried first - far less likely
// to pick up the wrong name (e.g. a clinic's own letterhead vs the actual
// consulting doctor). Falling back to a bare "Dr. <name>" scan otherwise, tolerant
// of OCR reading "Dr." as "Or." (the letters are easily confused) and of no space
// after the title ("Dr.Onkar").
function extractDoctorName(text) {
  const t = text || "";
  const labeled = t.match(/\b(?:consultant|doctor name|treating doctor|attending doctor|physician)\b\s*[:.]?\s*([^\n(]{2,60})/i);
  if (labeled) {
    const name = cleanDoctorName(labeled[1].split(/ {2,}|[|\t]/)[0]);
    if (name) return name;
  }
  // [ \t] (not \s) so the match can't cross a line break onto the next line's text.
  // A period OR a space is required after "Dr" (not both optional) - allowing
  // neither made "DRUGS", "DRESSING" etc. match as "Dr" + capital-starting "name"
  // (all-caps bill headers are common, so the letter after "DR" is often capital).
  const m = t.match(/\b(?:[Dd][Rr]\.[ \t]*|[Dd][Rr][ \t]+|[Oo][Rr]\.[ \t]*)([A-Z][\w.]*(?:[ \t]+[A-Z][\w.]*){0,3})/);
  return m ? cleanDoctorName(m[1]) : "";
}
function extractQualification(text) {
  const t = text || "";
  for (const q of QUALIFICATIONS) {
    if (new RegExp(`\\b${q}\\b`, "i").test(t)) return q;
  }
  return "";
}

// The "no./number/#" token is REQUIRED (not optional) - "Bill Cum Receipt" (a
// common Indian document title, not a number) was matching "bill" alone and
// capturing "Cum" as if it were the bill number. Requiring a digit in the
// captured value catches the rest of that false-positive shape. Falls back to
// an admission number when there's genuinely no bill/invoice/receipt number on
// the document (e.g. a provisional hospital bill).
// The separator between "No" and the actual value tolerates 0-2 junk characters
// (not just ":"/"."), since OCR often turns a colon into stray punctuation
// (a real observed case: "Bill No ©1A200124B000439", the colon read as "©").
function extractBillNumber(text) {
  const t = text || "";
  const SEP = "\\s*[^A-Za-z0-9\\s]{0,2}\\s*";
  const m = t.match(new RegExp(`\\b(?:bill|invoice|receipt)\\s*(?:no\\.?|number|#)${SEP}([A-Za-z0-9/-]{2,25})`, "i"))
    || t.match(new RegExp(`\\badmission\\s*(?:no\\.?|number|#)${SEP}([A-Za-z0-9/-]{2,25})`, "i"));
  if (!m) return "";
  const value = m[1].replace(/[.,/-]+$/, "");
  return /\d/.test(value) ? value : "";
}

function extractFacilityName(text, type) {
  const lines = (text || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const pattern = type === "medicine" ? /pharmacy|chemist|drug store/i : /clinic|hospital/i;
  // A charges/total line item ("Total Hospital Charges: 23,999.00") can contain
  // the same keyword as the actual letterhead name - prefer a line that doesn't
  // also look like a line item, but still fall back to any match rather than blank.
  const looksLikeLineItem = /\d{2,}|charges?|amount|payable|\bfee\b|\btotal\b/i;
  return lines.find((l) => pattern.test(l) && !looksLikeLineItem.test(l))
    || lines.find((l) => pattern.test(l))
    || "";
}

// Real bills usually state the amount actually payable as "Total: 5150.00" or
// "Amount Payable: 3650.00" with no currency symbol at all (requiring one meant
// this never matched on plenty of real bills). Search line by line so a labeled
// figure is matched against the number(s) on THAT line, in priority order: the
// specific "payable" amount first, then a grand/net total, then a bare "total"
// (which risks being just one line item's subtotal), then a balance-due figure.
const AMOUNT_LABEL_TIERS = [
  /\b(?:patient payable|amount payable|payable amount)\b/i,
  /\b(?:grand total|net amount|total bill amount|net payable)\b/i,
  /\btotal\b/i,
  /\b(?:balance due|amount due|balance to pay)\b/i,
];
function extractAmount(text) {
  const lines = (text || "").split("\n");
  for (const labelRe of AMOUNT_LABEL_TIERS) {
    let last = null;
    for (const line of lines) {
      if (!labelRe.test(line)) continue;
      const nums = [...line.matchAll(/\d[\d,]*(?:\.\d{1,2})?/g)]
        .map((m) => parseFloat(m[0].replace(/,/g, "")))
        .filter((n) => Number.isFinite(n) && n > 0);
      if (nums.length) last = Math.max(...nums);
    }
    if (last !== null) return String(last);
  }
  return "";
}

function claimFields(text, type) {
  // Don't run bill-shaped regexes over a document that isn't a bill at all -
  // they can still coincidentally match noise and produce junk fields.
  if (type === "not-medical") return { doctorName: "", qualification: "", billNumber: "", facility: "", amount: "" };
  return {
    doctorName: extractDoctorName(text),
    qualification: extractQualification(text),
    billNumber: extractBillNumber(text),
    facility: extractFacilityName(text, type),
    amount: extractAmount(text),
  };
}

// ---------- OCR ----------

let ocrWorkerPromise;
function loadOcrWorker() {
  return (ocrWorkerPromise ||= (async () => {
    const { createWorker, OEM } = (await import("../vendor/tesseract.esm.min.js")).default;
    return createWorker("eng", OEM.LSTM_ONLY, {
      workerPath: new URL("../vendor/tesseract-worker.min.js", import.meta.url).href,
      corePath: new URL("../vendor/tesseract-core-simd-lstm.js", import.meta.url).href,
      langPath: new URL("../vendor/", import.meta.url).href,
      cacheMethod: "none",
      gzip: true,
      // Not a blob-wrapped worker: the core's wasm loader resolves its .wasm file
      // relative to the worker script's own URL, which only works when that URL is
      // a real same-origin path (blob: URLs break that relative resolution).
      workerBlobURL: false,
      logger: () => {},
    });
  })());
}

// Real phone photos of bills are often small (well under 1000px) and OCR on them
// is dramatically worse than on the same page at a real working resolution -
// tesseract goes from reading two or three words per line to reading almost the
// whole page correctly. Never downscale (that only hurts), and cap the scale
// factor so a tiny thumbnail doesn't balloon into a multi-second, huge canvas.
function upscaleForOcr(canvas, targetLongEdge = 2000, maxScale = 4) {
  const longEdge = Math.max(canvas.width, canvas.height);
  if (longEdge >= targetLongEdge) return canvas;
  const scale = Math.min(maxScale, targetLongEdge / longEdge);
  const out = document.createElement("canvas");
  out.width = Math.round(canvas.width * scale);
  out.height = Math.round(canvas.height * scale);
  const ctx = out.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(canvas, 0, 0, out.width, out.height);
  return out;
}

// Try the page upright, then rotated, until a date is found - this solves both
// "what's the date" and "which way is up" in the same OCR pass. Also returns the
// OCR text (at whichever rotation won, or upright if none found) so callers that
// need more than the date - e.g. classifying what kind of document this is - don't
// have to run OCR a second time.
async function analyzePage(canvas) {
  const worker = await loadOcrWorker();
  const ocrCanvas = upscaleForOcr(canvas);
  let firstText = "";
  for (const angle of [0, 90, 180, 270]) {
    const { data } = await worker.recognize(rotateCanvas(ocrCanvas, angle));
    if (angle === 0) firstText = data.text;
    const date = extractDate(data.text);
    if (date) return { date, rotation: angle, text: data.text };
  }
  return { date: null, rotation: 0, text: firstText };
}

function reportProgress(message) {
  window.dispatchEvent(new CustomEvent("medisort:progress", { detail: { message } }));
}

// ---------- analyze, then finalize ----------
// Two-step: analyzeMedicalBills reports what it found (date, type, thumbnail,
// claim fields) per page/image without building anything, so the UI can show a
// review grid and let the user fix a wrong guess or fill in a flagged
// "other"/no-date page; finalizeMedicalBills takes the user-approved plan and
// the same files (resubmitted, not re-uploaded) and builds the actual PDF.

async function analyzeMedicalBills(fd) {
  const files = fd.getAll("files").filter((f) => f && f.name);
  if (!files.length) throw new ToolError("Add at least one PDF or image.");
  for (const f of files) {
    if (!isPdfLike(f) && !f.type.startsWith("image/")) throw new ToolError(`'${f.name}' isn't a PDF or an image.`);
  }

  const units = [];
  let doneUnits = 0;
  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    const f = files[fileIndex];
    if (isPdfLike(f)) {
      const pdfjsDoc = await openPdfjs(f);
      try {
        for (let i = 1; i <= pdfjsDoc.numPages; i++) {
          reportProgress(`Reading pages… ${doneUnits + 1} so far (${f.name}, page ${i}/${pdfjsDoc.numPages})`);
          const page = await pdfjsDoc.getPage(i);
          const canvas = await renderPage(page, 200 / 72);
          const { date, rotation, text } = await analyzePage(canvas);
          const type = classifyBillType(text);
          units.push({
            fileIndex, pageIndex: i - 1, rotation,
            date: date ? isoDate(date) : null,
            type,
            thumb: canvasThumb(rotateCanvas(canvas, rotation)),
            text, // the raw OCR text, kept for debugging extraction misses - never sent anywhere
            ...claimFields(text, type),
          });
          canvas.width = canvas.height = 0;
          page.cleanup();
          doneUnits++;
        }
      } finally {
        closePdfjs(pdfjsDoc);
      }
    } else {
      reportProgress(`Reading pages… ${doneUnits + 1} so far (${f.name})`);
      const bitmap = await createImageBitmap(f, { imageOrientation: "from-image" });
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("2d").drawImage(bitmap, 0, 0);
      const { date, rotation, text } = await analyzePage(canvas);
      const type = classifyBillType(text);
      units.push({
        fileIndex, pageIndex: null, rotation,
        date: date ? isoDate(date) : null,
        type,
        thumb: canvasThumb(rotateCanvas(canvas, rotation)),
        text,
        ...claimFields(text, type),
      });
      doneUnits++;
    }
  }
  return json({ units });
}

async function finalizeMedicalBills(fd) {
  const files = fd.getAll("files").filter((f) => f && f.name);
  if (!files.length) throw new ToolError("Add at least one PDF or image.");
  let plan;
  try { plan = JSON.parse(str(fd, "plan", "[]")); } catch (_) { throw new ToolError("Invalid plan."); }
  if (!Array.isArray(plan) || !plan.length) throw new ToolError("Nothing to arrange.");

  const typeRank = (t) => { const i = BILL_TYPES.indexOf(t); return i === -1 ? BILL_TYPES.length : i; };
  const ordered = plan
    .map((p, order) => ({ ...p, order }))
    .sort((a, b) => {
      const byDate = (a.date || "9999-99-99").localeCompare(b.date || "9999-99-99");
      if (byDate) return byDate;
      const byType = typeRank(a.type) - typeRank(b.type);
      return byType || a.order - b.order;
    });

  reportProgress("Putting the pages together…");
  const out = await PDFDocument.create();
  const srcDocs = new Map(); // fileIndex -> loaded pdf-lib document (reused across its pages)
  for (const item of ordered) {
    const f = files[item.fileIndex];
    if (!f) throw new ToolError("The files don't match the plan. Please analyze again.");
    const rotation = ((parseInt(item.rotation, 10) || 0) % 360 + 360) % 360;
    if (item.pageIndex === null || item.pageIndex === undefined) {
      const bitmap = await createImageBitmap(f, { imageOrientation: "from-image" });
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("2d").drawImage(bitmap, 0, 0);
      const img = await out.embedPng(await canvasBytes(rotateCanvas(canvas, rotation), "image/png"));
      const w = (img.width * 72) / 100, h = (img.height * 72) / 100;
      out.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
    } else {
      let src = srcDocs.get(item.fileIndex);
      if (!src) { src = await loadPdf(f); srcDocs.set(item.fileIndex, src); }
      const [page] = await out.copyPages(src, [item.pageIndex]);
      out.addPage(page);
      if (rotation) page.setRotation(degrees((pageRotation(page) + rotation) % 360));
    }
  }
  return sendBytes(await save(out), "medical-records.pdf");
}

// ---------- router ----------

const ROUTES = {
  "/api/analyze-medical-bills": analyzeMedicalBills,
  "/api/finalize-medical-bills": finalizeMedicalBills,
};

export async function handle(url, fd) {
  const route = ROUTES[url];
  if (!route) return json({ error: "Unknown tool." }, 404);
  try {
    return await route(fd);
  } catch (e) {
    if (e instanceof ToolError) return json({ error: e.message }, 400);
    console.error(e);
    return json({ error: "Something went wrong while processing the file." }, 500);
  }
}
