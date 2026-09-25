# medisort

Sort doctor bills, prescriptions and medicine bills into one PDF &mdash; by date,
then doctor bill, prescription, medicine bill &mdash; with insurance
claim-form data (doctor name, bill number, amount, facility...) pulled out
for you into an editable table.

Everything runs on your own device: pages are read with OCR in the browser
or the desktop app, nothing is ever uploaded anywhere.

Spun out of [pdforge](https://github.com/nmsheikh/pdforge)'s "Arrange
medical bills" tool into its own focused product.

## How it works

1. **Upload** your PDFs and photos of bills.
2. **Review**: each page is OCR'd to guess its date and document type
   (doctor bill / prescription / medicine bill). Fix anything flagged.
3. **Extract and sort**: pulls claim-form fields out of the text into an
   editable table, in the order the final PDF will use.
4. **Download**: one combined PDF, sorted by date.

## Running it locally

It's a static site - no build step, no server:

```bash
python3 -m http.server 8000
```

Then open http://127.0.0.1:8000.

## Desktop app

Same tool, packaged as a small (~10 MB) native app with [Tauri](https://tauri.app)
so it works offline with no browser required. Get it from
[Releases](https://github.com/nmsheikh/medisort/releases/latest).

The app isn't signed with a paid certificate yet, so the first time you open it:
on macOS, right-click the app and choose **Open** (or run `xattr -cr` on it if
macOS calls it "damaged"); on Windows, click **More info**, then **Run anyway**.

**Building it yourself:**
- Requirements: Node.js and [Rust](https://rustup.rs).
- `cd desktop && npm install && npm run build`.
- Pushing a tag such as `v1.0.0` makes GitHub Actions build every platform and
  publish a release.

## How extraction works

`engine/engine.mjs` OCRs each page with [tesseract.js](https://github.com/naptha/tesseract.js),
then:
- finds the document's own date (not a nearby date of birth or expiry date)
  using the label text around each date-shaped match,
- classifies the document (doctor bill / prescription / medicine bill /
  other / not medical) by keyword scoring, filtering out things like resumes
  that happen to mention "clinic" or "patient care",
- pulls out the doctor's name, bill number, amount and facility name with a
  set of regexes tuned against real bills (see the comments in
  `engine/engine.mjs` for the specific OCR-misread cases each one guards
  against).

[pdf-lib](https://pdf-lib.js.org) builds the final combined PDF; [pdf.js](https://mozilla.github.io/pdf.js/)
renders PDF pages to images for OCR.
