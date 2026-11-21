///////////////////////////////////////////////////////////////////////////
// extract.js
//  Turns an uploaded file (or pasted text) into clean text, kept page by
//  page. It is used by the DBQ packet, the custom-template source, and the
//  Material tab.
//
//  Result shape (every kind of file returns the same thing):
//    { kind: "pdf" | "docx" | "txt", name, paged, hasPageLabels,
//      pageCount, charCount, warnings: [string],
//      pages: [ { index, label, text } ] }
//
//  - PDFs are paged: one entry per PDF page, index counted from 0, and
//    label the page number printed on the page when the PDF defines page
//    labels (for example "xii" or "214"), otherwise the position as a string.
//  - Word and text files have no real pages, so paged is false. Their text is
//    cut into pieces of about 3,500 characters at paragraph boundaries so the
//    source viewer and the quote finder have something page-sized to work
//    with. These pieces have label null: nothing should ever show them to a
//    student as page numbers.
//
//  PDF cleanup is the AI Document Reader's, adapted to keep pages apart:
//    1. Hyphens at line wraps ("mathe-" + "matics") are rejoined.
//    2. Footnote-marker digits are dropped (small pure-digit items).
//    3. Running headers, footers, and page numbers are removed.
//    4. Drop caps split into their own run ("T he term") are merged back.
//  Added here: reading order for two-column pages (with full-width titles),
//  paragraphs that wrap from one column to the next, and detection of
//  scanned PDFs. Tables and unusual layouts may still need a manual check.
//
//  pdf.js and mammoth are loaded from the CDN the first time they are needed,
//  not at startup, so they cost nothing until a file is chosen.
//
//  Oliver Emerson - 2026
///////////////////////////////////////////////////////////////////////////

const PDFJS_VERSION = "2.16.105";
const MAMMOTH_VERSION = "1.12.3";

const LIBRARIES = {
  pdf: {
    global: "pdfjsLib",
    url: `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.min.js`,
    workerUrl: `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.worker.min.js`
  },
  mammoth: {
    global: "mammoth",
    url: `https://cdnjs.cloudflare.com/ajax/libs/mammoth/${MAMMOTH_VERSION}/mammoth.browser.min.js`
  }
};

// Limits (Architecture section 10). File sizes are only a safety net; the
// character limit applied to the extracted text is the real gate.
const MAX_FILE_BYTES = {
  txt: 1 * 1024 * 1024,
  pdf: 10 * 1024 * 1024,
  docx: 10 * 1024 * 1024
};
const SOURCE_MAX_CHARS = 200000;           // per source (Material tab, DBQ packet)
const CUSTOM_TEMPLATE_MAX_CHARS = 60000;   // custom template source material

const SUPPORTED_EXTENSIONS = ["txt", "pdf", "docx"];

// Pieces for files with no real pages.
const PSEUDO_PAGE_CHARS = 3500;

// PDF layout tuning, in PDF points (1 point is 1/72 inch).
const LINE_TOLERANCE = 3;        // items this close in height share a line
const GUTTER_BIN = 2;            // column search resolution
const MIN_GUTTER_PT = 10;        // narrowest gap between columns we'll trust
const EDGE_ZONE = 0.07;          // top and bottom share of a page where headers and footers live

// A PDF averaging fewer characters per page than this is treated as a scan.
const MIN_CHARS_PER_PAGE = 30;

const LIGATURES = { "\ufb00": "ff", "\ufb01": "fi", "\ufb02": "fl", "\ufb03": "ffi", "\ufb04": "ffl" };

///////////////////////////////////////////////////////////////////////////
//  Class: ExtractError
//  Fields: code, message
//  Summary: Thrown for every problem the student can act on. message is
//    written for a student to read. Codes: "unsupported", "too_large",
//    "too_long", "empty", "scanned", "password", "corrupt", "library",
//    "cancelled".
///////////////////////////////////////////////////////////////////////////
class ExtractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ExtractError";
    this.code = code;
  }
}

///////////////////////////////////////////////////////////////////////////
//  Function: approxWords
//  Inputs: chars
//  Outputs: Rough word count (about 6 characters per word), rounded to 100
///////////////////////////////////////////////////////////////////////////
function approxWords(chars) {
  return Math.max(100, Math.round(chars / 6 / 100) * 100);
}

///////////////////////////////////////////////////////////////////////////
//  Function: extensionOf
//  Inputs: fileName
//  Outputs: The lowercase extension without the dot ("" if none)
///////////////////////////////////////////////////////////////////////////
function extensionOf(fileName) {
  const dot = String(fileName || "").lastIndexOf(".");
  return dot === -1 ? "" : fileName.slice(dot + 1).toLowerCase();
}

///////////////////////////////////////////////////////////////////////////
//  Function: isSupportedFile
//  Inputs: file (a File, or anything with a name)
//  Outputs: true for .txt, .pdf, and .docx
///////////////////////////////////////////////////////////////////////////
function isSupportedFile(file) {
  return SUPPORTED_EXTENSIONS.includes(extensionOf(file && file.name));
}

///////////////////////////////////////////////////////////////////////////
// Loading pdf.js and mammoth
///////////////////////////////////////////////////////////////////////////

const loadingLibraries = {}; // name -> Promise, so each loads once

///////////////////////////////////////////////////////////////////////////
//  Function: loadScript
//  Inputs: url
//  Outputs: Promise — resolves when the script has loaded
///////////////////////////////////////////////////////////////////////////
function loadScript(url) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = url;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Couldn't load ${url}`));
    document.head.appendChild(script);
  });
}

///////////////////////////////////////////////////////////////////////////
//  Function: ensureLibrary
//  Inputs: name ("pdf" | "mammoth")
//  Outputs: Promise<the library object> (pdfjsLib or mammoth)
//  Summary: Loads the script on first use. A library that is already on the
//    page (as in tests) is used as it is. A failed load can be retried.
///////////////////////////////////////////////////////////////////////////
function ensureLibrary(name) {
  const lib = LIBRARIES[name];

  if (globalThis[lib.global]) return Promise.resolve(globalThis[lib.global]);

  if (!loadingLibraries[name]) {
    loadingLibraries[name] = loadScript(lib.url)
      .then(() => {
        const loaded = globalThis[lib.global];
        if (!loaded) throw new Error(`${lib.global} didn't appear after loading`);
        if (name === "pdf" && !loaded.GlobalWorkerOptions.workerSrc) {
          loaded.GlobalWorkerOptions.workerSrc = lib.workerUrl;
        }
        return loaded;
      })
      .catch(err => {
        delete loadingLibraries[name];
        console.error("EXTRACT: couldn't load a library:", err);
        throw new ExtractError(
          "library",
          "Couldn't load the file reader. Check your connection and try again."
        );
      });
  }
  return loadingLibraries[name];
}

///////////////////////////////////////////////////////////////////////////
// Text helpers
///////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////
//  Function: cleanText
//  Inputs: s
//  Outputs: The text with ligatures expanded ("ﬁ" to "fi"), invisible
//    characters and soft hyphens removed, non-breaking spaces turned into
//    spaces, runs of spaces collapsed, and the ends trimmed
//  Summary: Done everywhere, so a quote copied from a PDF matches what the
//    quote finder later searches for.
///////////////////////////////////////////////////////////////////////////
function cleanText(s) {
  return String(s || "")
    .replace(/[\ufb00-\ufb04]/g, ch => LIGATURES[ch])
    .replace(/[\u00ad\u200b\ufeff]/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

///////////////////////////////////////////////////////////////////////////
//  Function: joinWrapped
//  Inputs: paragraph (the text so far), nextLineText
//  Outputs: The two joined with a space, or with no space and no hyphen when
//    the first ends in "letter-" and the next starts with a lowercase letter
//    (Fix 1: "mathe-" + "matics")
///////////////////////////////////////////////////////////////////////////
function joinWrapped(paragraph, nextLineText) {
  const trimmed = paragraph.replace(/\s+$/, "");
  const next = nextLineText.trimStart();
  if (/[a-z]-$/.test(trimmed) && /^[a-z]/.test(next)) {
    return trimmed.slice(0, -1) + next;
  }
  return paragraph + " " + nextLineText;
}

///////////////////////////////////////////////////////////////////////////
//  Function: fixDropCap
//  Inputs: text (one paragraph)
//  Outputs: The text with a split drop cap merged ("T he" to "The")
//  Summary: Fix 4. A capital, a space, then a lowercase letter at the start
//    of a paragraph is almost never real English, with two exceptions: "A"
//    and "I" are real one-letter words ("A study", "I think"), so they are
//    left alone.
///////////////////////////////////////////////////////////////////////////
function fixDropCap(text) {
  return text.replace(/^([B-HJ-Z]) ([a-z])/, "$1$2");
}

///////////////////////////////////////////////////////////////////////////
//  Function: paragraphsFromPlainText
//  Inputs: raw (the text of a .txt file or pasted text)
//  Outputs: [string] — the paragraphs
//  Summary: If the text has blank lines, they separate paragraphs and single
//    line breaks inside a paragraph are treated as wrapping (so a text file
//    hard-wrapped at 72 columns reads properly). If it has none, every line
//    is a paragraph.
///////////////////////////////////////////////////////////////////////////
function paragraphsFromPlainText(raw) {
  const text = String(raw || "").replace(/\r\n?/g, "\n");
  const blocks = text.split(/\n[ \t]*\n+/);

  let paragraphs;
  if (blocks.length > 1) {
    paragraphs = blocks.map(block =>
      block.split("\n").map(line => line.trim()).filter(Boolean).reduce(
        (joined, line) => (joined ? joinWrapped(joined, line) : line),
        ""
      )
    );
  } else {
    paragraphs = text.split("\n");
  }

  return paragraphs.map(cleanText).filter(p => p.length > 0);
}

///////////////////////////////////////////////////////////////////////////
//  Function: paginateParagraphs
//  Inputs: paragraphs ([string])
//  Outputs: [{ index, label: null, text }] — pieces of about
//    PSEUDO_PAGE_CHARS, never splitting a paragraph
///////////////////////////////////////////////////////////////////////////
function paginateParagraphs(paragraphs) {
  const groups = [];
  let current = [];
  let size = 0;

  paragraphs.forEach(p => {
    if (current.length > 0 && size + p.length > PSEUDO_PAGE_CHARS) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(p);
    size += p.length + 2;
  });
  if (current.length > 0) groups.push(current);

  return groups.map((paras, index) => ({ index, label: null, text: paras.join("\n\n") }));
}

///////////////////////////////////////////////////////////////////////////
//  Function: buildResult
//  Inputs: { kind, name, pages, paged, hasPageLabels, warnings }
//  Outputs: The standard result object, with pageCount and charCount filled in
///////////////////////////////////////////////////////////////////////////
function buildResult({ kind, name, pages, paged, hasPageLabels = false, warnings = [] }) {
  return {
    kind,
    name,
    paged,
    hasPageLabels,
    pageCount: pages.length,
    charCount: pages.reduce((n, p) => n + p.text.length, 0),
    warnings,
    pages
  };
}

///////////////////////////////////////////////////////////////////////////
// PDF: one page's items into paragraphs
///////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////
//  Function: dominantItemHeight
//  Inputs: items (pdf.js text items)
//  Outputs: The most common (rounded) height among non-blank items, 0 if none
///////////////////////////////////////////////////////////////////////////
function dominantItemHeight(items) {
  const counts = new Map();
  items.forEach(item => {
    if (!item.str.trim()) return;
    const h = Math.round(Math.abs(item.height) || 0);
    if (h > 0) counts.set(h, (counts.get(h) || 0) + 1);
  });

  let best = 0;
  let bestCount = 0;
  counts.forEach((count, h) => {
    if (count > bestCount) {
      bestCount = count;
      best = h;
    }
  });
  return best;
}

///////////////////////////////////////////////////////////////////////////
//  Function: dropFootnoteMarkers
//  Inputs: items, dominant (from dominantItemHeight)
//  Outputs: items without footnote markers (Fix 2)
//  Summary: A marker is a run of digits ("1", "12", "1,2", "3-5") that is
//    superscript. Much smaller than the body text (under 80% of its height) is
//    enough. Only slightly smaller (80% to 95%) counts when it is also raised
//    above the text beside it, because some PDFs use a larger superscript.
///////////////////////////////////////////////////////////////////////////
function dropFootnoteMarkers(items, dominant) {
  if (!(dominant > 0)) return items;

  const looksLikeMarker = text => /^\d{1,3}(?:[,\u2013-]\d{1,3})*$/.test(text.trim());

  return items.filter(item => {
    if (!looksLikeMarker(item.str)) return true;

    const h = Math.abs(item.height) || 0;
    if (h <= 0 || h >= dominant * 0.95) return true;
    if (h < dominant * 0.8) return false;

    // Slightly smaller: only a marker if raised above neighbouring text.
    const x0 = item.transform[4];
    const x1 = x0 + (item.width || 0);
    const y = item.transform[5];
    const raisedAboveNeighbour = items.some(other => {
      if (other === item || !other.str.trim() || looksLikeMarker(other.str)) return false;
      const otherEnd = other.transform[4] + (other.width || 0);
      const nextToIt = other.transform[4] <= x1 + 3 && otherEnd >= x0 - 3;
      const lift = y - other.transform[5];
      return nextToIt && lift >= dominant * 0.2 && lift <= dominant;
    });
    return !raisedAboveNeighbour;
  });
}

///////////////////////////////////////////////////////////////////////////
//  Function: joinLineItems
//  Inputs: items (the pieces of one line, sorted left to right)
//  Outputs: The line's text. A space is added between two pieces that have a
//    visible gap and no space of their own.
///////////////////////////////////////////////////////////////////////////
function joinLineItems(items) {
  let text = "";
  let previousEnd = null;

  items.forEach((item, i) => {
    if (i > 0) {
      const gap = item.transform[4] - previousEnd;
      const height = Math.abs(item.height) || 10;
      if (gap > height * 0.15 && !/\s$/.test(text) && !/^\s/.test(item.str)) text += " ";
    }
    text += item.str;
    previousEnd = item.transform[4] + (item.width || 0);
  });

  return text;
}

///////////////////////////////////////////////////////////////////////////
//  Function: buildLines
//  Inputs: items (pdf.js text items from one region of a page)
//  Outputs: [{ y, items, text }] from top to bottom
//  Summary: Items are sorted by height, grouped into lines by shared
//    baseline, then ordered left to right within each line. Sorting means the
//    result doesn't depend on the order the PDF happened to store them in.
///////////////////////////////////////////////////////////////////////////
function buildLines(items) {
  const sorted = [...items].sort(
    (a, b) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4]
  );

  const lines = [];
  sorted.forEach(item => {
    const y = item.transform[5];
    const line = lines[lines.length - 1];
    if (line && Math.abs(line.y - y) <= LINE_TOLERANCE) {
      line.items.push(item);
    } else {
      lines.push({ y, items: [item] });
    }
  });

  lines.forEach(line => {
    line.items.sort((a, b) => a.transform[4] - b.transform[4]);
    line.text = joinLineItems(line.items);
  });

  return lines.filter(line => line.text.trim().length > 0);
}

///////////////////////////////////////////////////////////////////////////
//  Function: findGutter
//  Inputs: items, view (the page's [x0, y0, x1, y1])
//  Outputs: The x position of the gap between two text columns, or null for
//    a single-column page
//  Summary: Looks for a vertical strip near the middle of the page that
//    (almost) no text crosses, with real text on both sides. A few
//    full-width lines, like a title or abstract, are tolerated.
///////////////////////////////////////////////////////////////////////////
function findGutter(items, view) {
  if (items.length < 30) return null;

  const pageLeft = view[0];
  const pageWidth = view[2] - view[0];
  if (!(pageWidth > 0)) return null;

  const bins = Math.ceil(pageWidth / GUTTER_BIN);
  const cover = new Array(bins).fill(0);

  items.forEach(item => {
    const x0 = item.transform[4] - pageLeft;
    const x1 = x0 + (item.width || 0);
    const first = Math.max(0, Math.floor(x0 / GUTTER_BIN));
    const last = Math.min(bins - 1, Math.floor(x1 / GUTTER_BIN));
    for (let b = first; b <= last; b++) cover[b]++;
  });

  const tolerance = Math.max(1, Math.floor(items.length * 0.04));
  const low = Math.floor(bins * 0.35);
  const high = Math.ceil(bins * 0.65);

  let best = null;
  let runStart = null;
  for (let b = low; b <= high; b++) {
    const open = b < high && cover[b] <= tolerance;
    if (open && runStart === null) runStart = b;
    if (!open && runStart !== null) {
      const length = b - runStart;
      if (!best || length > best.length) best = { start: runStart, length };
      runStart = null;
    }
  }
  if (!best || best.length * GUTTER_BIN < MIN_GUTTER_PT) return null;

  const gutterX = pageLeft + (best.start + best.length / 2) * GUTTER_BIN;

  const centerOf = item => item.transform[4] + (item.width || 0) / 2;
  const leftCount = items.filter(item => centerOf(item) < gutterX).length;
  const rightCount = items.length - leftCount;
  if (leftCount < items.length * 0.25 || rightCount < items.length * 0.25) return null;

  return gutterX;
}

///////////////////////////////////////////////////////////////////////////
//  Function: readingFlows
//  Inputs: items (a page's text items), view
//  Outputs: [{ kind, lines }] in reading order. kind is "single" for a
//    one-column page; for two columns it alternates "left", "right" for each
//    band, with "span" for full-width lines (a title, say) between bands.
///////////////////////////////////////////////////////////////////////////
function readingFlows(items, view) {
  const gutterX = findGutter(items, view);
  if (gutterX === null) return [{ kind: "single", lines: buildLines(items) }];

  const slop = 2;
  const spanning = [];
  const leftItems = [];
  const rightItems = [];

  items.forEach(item => {
    const x0 = item.transform[4];
    const x1 = x0 + (item.width || 0);
    if (x0 < gutterX - slop && x1 > gutterX + slop) spanning.push(item);
    else if ((x0 + x1) / 2 < gutterX) leftItems.push(item);
    else rightItems.push(item);
  });

  // Full-width lines divide the page into bands read one after another.
  const spanLines = buildLines(spanning);
  const bandOf = item => spanLines.filter(sl => sl.y - item.transform[5] > LINE_TOLERANCE).length;

  const flows = [];
  for (let band = 0; band <= spanLines.length; band++) {
    const left = buildLines(leftItems.filter(item => bandOf(item) === band));
    const right = buildLines(rightItems.filter(item => bandOf(item) === band));
    if (left.length) flows.push({ kind: "left", lines: left });
    if (right.length) flows.push({ kind: "right", lines: right });
    if (spanLines[band]) flows.push({ kind: "span", lines: [spanLines[band]] });
  }
  return flows;
}

///////////////////////////////////////////////////////////////////////////
//  Function: pageParagraphs
//  Inputs: items (a page's pdf.js text items), view (the page's
//    [x0, y0, x1, y1])
//  Outputs: [{ text, isEdge }] in reading order. isEdge marks paragraphs
//    that could be a running header, footer, or page number (the first and
//    last paragraphs, plus single lines in the top or bottom strip of the
//    page); they are only removed later, if they repeat across pages (or are
//    a bare page number).
///////////////////////////////////////////////////////////////////////////
function pageParagraphs(items, view) {
  const usable = items.filter(item => typeof item.str === "string" && item.str.length > 0);
  const kept = dropFootnoteMarkers(usable, dominantItemHeight(usable));
  const flows = readingFlows(kept, view);

  // A gap well above the page's median line spacing marks a paragraph break.
  const deltas = [];
  flows.forEach(flow => {
    for (let i = 1; i < flow.lines.length; i++) {
      deltas.push(Math.abs(flow.lines[i - 1].y - flow.lines[i].y));
    }
  });
  deltas.sort((a, b) => a - b);
  const median = deltas.length > 0 ? deltas[Math.floor(deltas.length / 2)] : 0;
  const threshold = median * 1.5 || 20;

  // Split each flow into paragraphs.
  const flowParagraphs = flows.map(flow => {
    const paragraphs = [];
    let current = null;
    flow.lines.forEach((line, i) => {
      const gap = i > 0 ? Math.abs(flow.lines[i - 1].y - line.y) : 0;
      if (!current || gap > threshold) {
        current = { text: line.text, y: line.y, lineCount: 1 };
        paragraphs.push(current);
      } else {
        current.text = joinWrapped(current.text, line.text);
        current.lineCount++;
      }
    });
    return { kind: flow.kind, paragraphs };
  });

  // A paragraph that runs from the bottom of the left column to the top of the
  // right column is one paragraph: the left one doesn't end a sentence and the
  // right one starts lowercase.
  const continuesAcross = (before, after) =>
    !/[.!?\u2026:;"\u201d')\]]$/.test(before.trim()) && /^[a-z]/.test(after.trim());

  flowParagraphs.forEach((flow, i) => {
    const next = flowParagraphs[i + 1];
    if (flow.kind !== "left" || !next || next.kind !== "right") return;
    const last = flow.paragraphs[flow.paragraphs.length - 1];
    const first = next.paragraphs[0];
    if (last && first && continuesAcross(last.text, first.text)) {
      last.text = joinWrapped(last.text, first.text);
      last.lineCount += first.lineCount;
      next.paragraphs.shift();
    }
  });

  const all = flowParagraphs.flatMap(flow => flow.paragraphs);

  const pageHeight = view[3] - view[1];
  const topLimit = view[3] - EDGE_ZONE * pageHeight;
  const bottomLimit = view[1] + EDGE_ZONE * pageHeight;

  return all
    .map((p, i) => ({
      text: fixDropCap(cleanText(p.text)),
      isEdge:
        i === 0 ||
        i === all.length - 1 ||
        (p.lineCount === 1 && (p.y >= topLimit || p.y <= bottomLimit))
    }))
    .filter(p => p.text.length > 0);
}

///////////////////////////////////////////////////////////////////////////
// PDF: removing headers, footers, and page numbers
///////////////////////////////////////////////////////////////////////////

// "12", "Page 12", "12 of 40", "12 / 40", "- 12 -"
const PAGE_NUMBER_PATTERN = /^(?:page\s+)?\d{1,4}(?:\s*(?:of|\/)\s*\d{1,4})?$|^[-\u2013\u2014]\s*\d{1,4}\s*[-\u2013\u2014]$/i;

///////////////////////////////////////////////////////////////////////////
//  Function: normalizeForRepeatDetection
//  Inputs: text
//  Outputs: Lowercase text with leading and trailing digits and extra spaces
//    removed, so "2 journal of world history" and "3 journal of world
//    history" match
///////////////////////////////////////////////////////////////////////////
function normalizeForRepeatDetection(text) {
  return text
    .toLowerCase()
    .replace(/^\d+\s*/, "")
    .replace(/\s*\d+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

///////////////////////////////////////////////////////////////////////////
//  Function: removeHeadersAndFooters
//  Inputs: pageParagraphLists ([[{ text, isEdge }, ...], ...], one list per
//    page)
//  Outputs: [[string, ...], ...] — each page's remaining paragraph texts
//  Summary: Fix 3. Only edge paragraphs are candidates, so repeated body text
//    is never removed. An edge paragraph goes if it is a bare page number, or
//    if its normalized text (short, and not empty) also appears at the edge
//    of at least one other page.
///////////////////////////////////////////////////////////////////////////
function removeHeadersAndFooters(pageParagraphLists) {
  const pagesSeenOn = new Map(); // normalized text -> Set of page indexes

  pageParagraphLists.forEach((paragraphs, pageIndex) => {
    paragraphs.forEach(p => {
      if (!p.isEdge) return;
      const norm = normalizeForRepeatDetection(p.text);
      if (!norm || norm.length > 150) return;
      if (!pagesSeenOn.has(norm)) pagesSeenOn.set(norm, new Set());
      pagesSeenOn.get(norm).add(pageIndex);
    });
  });

  return pageParagraphLists.map(paragraphs =>
    paragraphs
      .filter(p => {
        if (!p.isEdge) return true;
        if (PAGE_NUMBER_PATTERN.test(p.text.trim())) return false;
        const norm = normalizeForRepeatDetection(p.text);
        const seen = pagesSeenOn.get(norm);
        return !(norm && seen && seen.size >= 2);
      })
      .map(p => p.text)
  );
}

///////////////////////////////////////////////////////////////////////////
// PDF
///////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////
//  Function: extractPdf
//  Inputs: arrayBuffer (the .pdf file's bytes), options ({ onProgress,
//    shouldStop })
//  Outputs: Promise<{ pages, hasPageLabels, warnings }>
//  Summary: Reads every page, builds its paragraphs, removes headers and
//    footers across pages, and reads printed page labels. Throws an
//    ExtractError for a password-protected, damaged, or scanned PDF.
///////////////////////////////////////////////////////////////////////////
async function extractPdf(arrayBuffer, { onProgress, shouldStop } = {}) {
  const pdfjs = await ensureLibrary("pdf");

  let pdf;
  try {
    pdf = await pdfjs.getDocument({ data: new Uint8Array(arrayBuffer), isEvalSupported: false }).promise;
  } catch (err) {
    if (err && err.name === "PasswordException") {
      throw new ExtractError("password", "That PDF is password protected. Remove the password and try again.");
    }
    console.error("EXTRACT: couldn't open the PDF:", err);
    throw new ExtractError("corrupt", "Couldn't read that PDF. Make sure it's a valid PDF file that isn't damaged.");
  }

  try {
    let labels = null;
    try {
      labels = await pdf.getPageLabels();
    } catch {
      // Labels are optional; the position is used instead.
    }

    const paragraphLists = [];
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      if (shouldStop && shouldStop()) throw new ExtractError("cancelled", "Stopped.");

      const page = await pdf.getPage(pageNum);
      const content = await page.getTextContent();
      paragraphLists.push(pageParagraphs(content.items, page.view));
      page.cleanup();

      if (onProgress) onProgress({ done: pageNum, total: pdf.numPages });
    }

    const pageTexts = removeHeadersAndFooters(paragraphLists).map(paragraphs => paragraphs.join("\n\n"));

    const pages = pageTexts.map((text, index) => ({
      index,
      label: labels && typeof labels[index] === "string" && labels[index] ? labels[index] : String(index + 1),
      text
    }));

    // Scanned (picture-only) PDFs have little or no text.
    const totalChars = pages.reduce((n, p) => n + p.text.length, 0);
    const pagesWithText = pages.filter(p => p.text.length >= MIN_CHARS_PER_PAGE).length;
    const looksScanned =
      totalChars === 0 ||
      totalChars / pages.length < MIN_CHARS_PER_PAGE ||
      (pages.length >= 4 && pagesWithText / pages.length < 0.25);

    if (looksScanned) {
      throw new ExtractError(
        "scanned",
        "That PDF looks like a scan (pictures of pages, not text), so there's nothing to read. Try pasting the text instead, or use a PDF whose text can be selected."
      );
    }

    const warnings = [];
    const emptyPages = pages.length - pagesWithText;
    if (emptyPages > 0) {
      warnings.push(
        `${emptyPages} of ${pages.length} page${pages.length === 1 ? "" : "s"} had little or no readable text (they may be pictures, or scanned pages).`
      );
    }

    const hasPageLabels = !!labels && labels.some((label, i) => label !== String(i + 1));
    return { pages, hasPageLabels, warnings };
  } finally {
    try {
      await pdf.destroy();
    } catch {
      // Nothing to do if cleanup fails.
    }
  }
}

///////////////////////////////////////////////////////////////////////////
// Word and text files
///////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////
//  Function: extractDocx
//  Inputs: arrayBuffer (the .docx file's bytes)
//  Outputs: Promise<[{ index, label, text }]> — pieces of about 3,500
//    characters
//  Summary: .docx has real paragraph markup, so mammoth's raw text is far more
//    reliable than the PDF heuristics.
///////////////////////////////////////////////////////////////////////////
async function extractDocx(arrayBuffer) {
  const mammothLib = await ensureLibrary("mammoth");

  let result;
  try {
    result = await mammothLib.extractRawText({ arrayBuffer });
  } catch (err) {
    console.error("EXTRACT: couldn't read the Word file:", err);
    throw new ExtractError("corrupt", "Couldn't read that Word file. Make sure it's a valid .docx file (older .doc files aren't supported).");
  }

  const paragraphs = String(result.value || "").split("\n").map(cleanText).filter(p => p.length > 0);
  return paginateParagraphs(paragraphs);
}

///////////////////////////////////////////////////////////////////////////
// The front door
///////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////
//  Function: checkLength
//  Inputs: result (from buildResult), maxChars
//  Outputs: Throws an ExtractError if there is no text, or too much
///////////////////////////////////////////////////////////////////////////
function checkLength(result, maxChars) {
  if (result.charCount === 0) {
    throw new ExtractError(
      "empty",
      "No readable text was found. If it's a scanned or image-only file, try pasting the text instead."
    );
  }

  if (result.charCount > maxChars) {
    throw new ExtractError(
      "too_long",
      `This is about ${approxWords(result.charCount).toLocaleString()} words (${result.charCount.toLocaleString()} characters), which is over the limit of about ${approxWords(maxChars).toLocaleString()} words (${maxChars.toLocaleString()} characters). Try a shorter file, or just the part you need.`
    );
  }
}

///////////////////////////////////////////////////////////////////////////
//  Function: extractFile
//  Inputs: file (a File), options ({ maxChars (default SOURCE_MAX_CHARS),
//    onProgress({ done, total }) for PDFs, shouldStop() })
//  Outputs: Promise of the result shape described at the top of this file.
//    Throws an ExtractError (its message is fit to show) for an unsupported
//    type, a file over the size limit, a damaged, protected, or scanned file,
//    a file with no text, or one over maxChars.
///////////////////////////////////////////////////////////////////////////
async function extractFile(file, { maxChars = SOURCE_MAX_CHARS, onProgress, shouldStop } = {}) {
  const extension = extensionOf(file && file.name);

  if (!SUPPORTED_EXTENSIONS.includes(extension)) {
    throw new ExtractError("unsupported", "Unsupported file type. Please use a .txt, .pdf, or .docx file.");
  }

  const maxBytes = MAX_FILE_BYTES[extension];
  if (file.size > maxBytes) {
    const toMb = bytes => (bytes / (1024 * 1024)).toFixed(1);
    throw new ExtractError(
      "too_large",
      `That file is ${toMb(file.size)} MB, which is over the ${toMb(maxBytes)} MB limit for .${extension} files. Try a smaller file, or just the part you need.`
    );
  }

  let result;

  if (extension === "pdf") {
    const { pages, hasPageLabels, warnings } = await extractPdf(await file.arrayBuffer(), { onProgress, shouldStop });
    result = buildResult({ kind: "pdf", name: file.name, pages, paged: true, hasPageLabels, warnings });
  } else if (extension === "docx") {
    const pages = await extractDocx(await file.arrayBuffer());
    result = buildResult({ kind: "docx", name: file.name, pages, paged: false });
  } else {
    const pages = paginateParagraphs(paragraphsFromPlainText(await file.text()));
    result = buildResult({ kind: "txt", name: file.name, pages, paged: false });
  }

  checkLength(result, maxChars);
  return result;
}

///////////////////////////////////////////////////////////////////////////
//  Function: extractPastedText
//  Inputs: text, options ({ name (default "Pasted text"), maxChars (default
//    SOURCE_MAX_CHARS) })
//  Outputs: The same result shape as extractFile, with kind "txt". Throws an
//    ExtractError for empty or over-long text.
//  Summary: For the custom template's paste box, so pasted and uploaded
//    material take exactly the same path from here on.
///////////////////////////////////////////////////////////////////////////
function extractPastedText(text, { name = "Pasted text", maxChars = SOURCE_MAX_CHARS } = {}) {
  const pages = paginateParagraphs(paragraphsFromPlainText(text));
  const result = buildResult({ kind: "txt", name, pages, paged: false });
  checkLength(result, maxChars);
  return result;
}

export {
  ExtractError,
  extractFile,
  extractPastedText,
  isSupportedFile,
  extensionOf,
  approxWords,
  SOURCE_MAX_CHARS,
  CUSTOM_TEMPLATE_MAX_CHARS,
  MAX_FILE_BYTES,
  SUPPORTED_EXTENSIONS
};