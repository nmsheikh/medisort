// Build desktop/dist: the website's page and static files, turned into a
// self-contained app that processes files locally (no server). Unlike
// pdforge, this site has no Flask templating to strip - it's already plain
// static HTML, so this is just a copy plus the data-desktop flag.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const dist = join(here, "..", "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const html = readFileSync(join(root, "index.html"), "utf8").replace("<body>", '<body data-desktop="1">');
writeFileSync(join(dist, "index.html"), html);
for (const f of ["style.css", "app.js", "logo.svg"]) cpSync(join(root, f), join(dist, f));
cpSync(join(root, "fonts"), join(dist, "fonts"), { recursive: true });
cpSync(join(root, "engine"), join(dist, "engine"), { recursive: true });
cpSync(join(root, "vendor"), join(dist, "vendor"), { recursive: true });
console.log("build-dist: wrote desktop/dist");
