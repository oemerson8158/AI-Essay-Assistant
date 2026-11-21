///////////////////////////////////////////////////////////////////////////
// sourceStore.js
//  Saves, reads, copies, and deletes sources: the extracted text of an
//  uploaded file, kept page by page. A source belongs to either a template (a
//  DBQ packet) or a document (the Material tab), with the same shape in both:
//
//    {parent}/sources/{sourceId}            metadata (see below)
//    {parent}/sources/{sourceId}/pages/{n}  { n, pages: [ { index, label, text } ] }
//    {parent}/sources/{sourceId}/vectors/{n}  { n, items: [...] }  (Phase 7)
//
//  parentKind is "template" or "document", and parentId is that record's id.
//
//  Page text is grouped so each Firestore document stays well under its 1 MB
//  limit (about 200,000 characters, and also capped by bytes, since
//  non-English text takes more bytes per character).
//
//  Source metadata:
//    name, kind ("pdf" | "docx" | "txt" | "packet"), fileKind (the file's own
//    type), pageCount, charCount, paged, hasPageLabels, groupCount,
//    saveStatus ("saving" | "saved"), indexStatus ("pending" | "indexing" |
//    "ready" | "failed"), embeddingModel, chunkCount, fromTemplate.
//
//  A source is created with saveStatus "saving" and flipped to "saved" only
//  after every page group has been written. If anything fails along the way,
//  the partial source is deleted, so a half-written source never shows up.
//  Anything left "saving" by a closed tab can be swept away with
//  removeIncompleteSources().
//
//  Vectors are not copied from a template to a document: the quote finder's
//  index is built in the document (Phase 7). When one document is copied to
//  another, a source that is already indexed can bring its vectors along.
//
//  Oliver Emerson - 2026
///////////////////////////////////////////////////////////////////////////

import {
  createSourceRecord,
  updateSourceRecord,
  getSourceRecord,
  listSources,
  deleteSourceRecord,
  saveSourceGroup,
  listSourceGroups
} from "./firebase.js";

const GROUP_MAX_CHARS = 200000;   // about 200,000 characters per pages document
const GROUP_MAX_BYTES = 700000;   // and never more than this many bytes of text
const PAGE_OVERHEAD_BYTES = 64;   // room for each page's index and label
const MAX_SINGLE_PAGE_BYTES = 900000;

// Architecture section 10: 200,000 characters per source (see extract.js) and
// 500,000 per document.
const DOCUMENT_SOURCE_MAX_CHARS = 500000;

///////////////////////////////////////////////////////////////////////////
//  Function: utf8Length
//  Inputs: text
//  Outputs: The number of bytes the text takes in UTF-8, which is how
//    Firestore counts it
///////////////////////////////////////////////////////////////////////////
function utf8Length(text) {
  return new TextEncoder().encode(text).length;
}

///////////////////////////////////////////////////////////////////////////
//  Function: groupPages
//  Inputs: pages ([{ index, label, text }])
//  Outputs: [[page, ...], ...] — consecutive pages, grouped so each group
//    stays under GROUP_MAX_CHARS and GROUP_MAX_BYTES. A page is never split.
//    Throws if one page alone can't fit.
///////////////////////////////////////////////////////////////////////////
function groupPages(pages) {
  const groups = [];
  let current = [];
  let chars = 0;
  let bytes = 0;

  pages.forEach(page => {
    const pageChars = page.text.length;
    const pageBytes = utf8Length(page.text) + PAGE_OVERHEAD_BYTES;

    if (pageBytes > MAX_SINGLE_PAGE_BYTES) {
      throw new Error(`Page ${page.index + 1} is too large to store (${pageBytes} bytes).`);
    }

    if (current.length > 0 && (chars + pageChars > GROUP_MAX_CHARS || bytes + pageBytes > GROUP_MAX_BYTES)) {
      groups.push(current);
      current = [];
      chars = 0;
      bytes = 0;
    }

    current.push(page);
    chars += pageChars;
    bytes += pageBytes;
  });

  if (current.length > 0) groups.push(current);
  return groups;
}

///////////////////////////////////////////////////////////////////////////
//  Function: onlyPageFields
//  Inputs: page
//  Outputs: { index, label, text } and nothing else
///////////////////////////////////////////////////////////////////////////
function onlyPageFields({ index, label, text }) {
  return { index, label: label === undefined ? null : label, text };
}

///////////////////////////////////////////////////////////////////////////
//  Function: saveExtractedSource
//  Inputs: parentKind, parentId, extracted (the result of extract.js),
//    options ({ name, kind, fromTemplate, onProgress({ done, total }) })
//      name — the source's display name (default: the file's name)
//      kind — override the stored kind, for example "packet" for a DBQ packet
//      fromTemplate — true for a source that came from a template
//  Outputs: Promise<string> — the new source's id. Rejects if any write
//    fails, after deleting whatever was written.
///////////////////////////////////////////////////////////////////////////
async function saveExtractedSource(parentKind, parentId, extracted, options = {}) {
  const { name, kind, fromTemplate = false, onProgress } = options;
  const groups = groupPages(extracted.pages);

  const sourceId = await createSourceRecord(parentKind, parentId, {
    name: name || extracted.name,
    kind: kind || extracted.kind,
    fileKind: extracted.kind,
    pageCount: extracted.pageCount,
    charCount: extracted.charCount,
    paged: extracted.paged === true,
    hasPageLabels: extracted.hasPageLabels === true,
    groupCount: groups.length,
    saveStatus: "saving",
    indexStatus: "pending",
    embeddingModel: null,
    chunkCount: 0,
    fromTemplate: fromTemplate === true
  });

  try {
    for (let i = 0; i < groups.length; i++) {
      await saveSourceGroup(parentKind, parentId, sourceId, "pages", i, {
        pages: groups[i].map(onlyPageFields)
      });
      if (onProgress) onProgress({ done: i + 1, total: groups.length });
    }
    await updateSourceRecord(parentKind, parentId, sourceId, { saveStatus: "saved" });
  } catch (err) {
    await discardSource(parentKind, parentId, sourceId);
    throw err;
  }

  return sourceId;
}

///////////////////////////////////////////////////////////////////////////
//  Function: discardSource
//  Inputs: parentKind, parentId, sourceId
//  Outputs: Promise — deletes a source after a failure; never throws
///////////////////////////////////////////////////////////////////////////
async function discardSource(parentKind, parentId, sourceId) {
  try {
    await deleteSourceRecord(parentKind, parentId, sourceId);
  } catch (err) {
    console.error("SOURCES: couldn't clean up a partly saved source:", err);
  }
}

///////////////////////////////////////////////////////////////////////////
//  Function: listSavedSources
//  Inputs: parentKind, parentId
//  Outputs: Promise<object[]> — the parent's complete sources, oldest first
//    (a source still being written is left out)
///////////////////////////////////////////////////////////////////////////
async function listSavedSources(parentKind, parentId) {
  const sources = await listSources(parentKind, parentId);
  return sources.filter(source => source.saveStatus !== "saving");
}

///////////////////////////////////////////////////////////////////////////
//  Function: getSource
//  Inputs: parentKind, parentId, sourceId
//  Outputs: Promise<object | null> — the source's metadata
///////////////////////////////////////////////////////////////////////////
function getSource(parentKind, parentId, sourceId) {
  return getSourceRecord(parentKind, parentId, sourceId);
}

///////////////////////////////////////////////////////////////////////////
//  Function: loadSourcePages
//  Inputs: parentKind, parentId, sourceId
//  Outputs: Promise<[{ index, label, text }]> — every page, in order
///////////////////////////////////////////////////////////////////////////
async function loadSourcePages(parentKind, parentId, sourceId) {
  const groups = await listSourceGroups(parentKind, parentId, sourceId, "pages");
  return groups
    .flatMap(group => group.pages || [])
    .sort((a, b) => a.index - b.index);
}

///////////////////////////////////////////////////////////////////////////
//  Function: renameSource
//  Inputs: parentKind, parentId, sourceId, name
//  Outputs: Promise — resolves when renamed
///////////////////////////////////////////////////////////////////////////
function renameSource(parentKind, parentId, sourceId, name) {
  return updateSourceRecord(parentKind, parentId, sourceId, { name: String(name).trim().slice(0, 200) });
}

///////////////////////////////////////////////////////////////////////////
//  Function: removeSource
//  Inputs: parentKind, parentId, sourceId
//  Outputs: Promise — resolves when the source, its pages, and its vectors
//    are deleted
///////////////////////////////////////////////////////////////////////////
function removeSource(parentKind, parentId, sourceId) {
  return deleteSourceRecord(parentKind, parentId, sourceId);
}

///////////////////////////////////////////////////////////////////////////
//  Function: removeIncompleteSources
//  Inputs: parentKind, parentId
//  Outputs: Promise<number> — how many were removed
//  Summary: Sweeps away sources left "saving" by a tab that closed mid-upload.
///////////////////////////////////////////////////////////////////////////
async function removeIncompleteSources(parentKind, parentId) {
  const sources = await listSources(parentKind, parentId);
  const incomplete = sources.filter(source => source.saveStatus === "saving");
  for (const source of incomplete) {
    await discardSource(parentKind, parentId, source.id);
  }
  return incomplete.length;
}

///////////////////////////////////////////////////////////////////////////
//  Function: totalSourceChars
//  Inputs: sources (metadata records)
//  Outputs: The sum of their charCount
///////////////////////////////////////////////////////////////////////////
function totalSourceChars(sources) {
  return sources.reduce((n, source) => n + (source.charCount || 0), 0);
}

///////////////////////////////////////////////////////////////////////////
//  Function: copySource
//  Inputs: fromKind, fromId, toKind, toId, sourceId, options
//    ({ includeVectors, fromTemplate, onProgress })
//      includeVectors — also copy the quote finder's vectors, but only for a
//        source that is already indexed ("ready"); otherwise the copy starts
//        unindexed. Leave false for template-to-document copies.
//      fromTemplate — true, false, or null (keep the source's own flag)
//  Outputs: Promise<string> — the new source's id. Rejects after deleting the
//    partial copy if anything fails.
///////////////////////////////////////////////////////////////////////////
async function copySource(fromKind, fromId, toKind, toId, sourceId, options = {}) {
  const { includeVectors = false, fromTemplate = null, onProgress } = options;

  const record = await getSourceRecord(fromKind, fromId, sourceId);
  if (!record) throw new Error("That source couldn't be found.");

  const keepVectors = includeVectors && record.indexStatus === "ready";
  const pageGroups = await listSourceGroups(fromKind, fromId, sourceId, "pages");
  const vectorGroups = keepVectors ? await listSourceGroups(fromKind, fromId, sourceId, "vectors") : [];

  const { id, createdAt, updatedAt, ...fields } = record;
  const copyFields = {
    ...fields,
    saveStatus: "saving",
    fromTemplate: fromTemplate === null ? fields.fromTemplate === true : fromTemplate === true
  };
  if (!keepVectors) {
    copyFields.indexStatus = "pending";
    copyFields.embeddingModel = null;
    copyFields.chunkCount = 0;
  }

  const newId = await createSourceRecord(toKind, toId, copyFields);
  const total = pageGroups.length + vectorGroups.length;

  try {
    let done = 0;
    for (const group of pageGroups) {
      await saveSourceGroup(toKind, toId, newId, "pages", group.n, { pages: group.pages });
      if (onProgress) onProgress({ done: ++done, total });
    }
    for (const group of vectorGroups) {
      await saveSourceGroup(toKind, toId, newId, "vectors", group.n, { items: group.items });
      if (onProgress) onProgress({ done: ++done, total });
    }
    await updateSourceRecord(toKind, toId, newId, { saveStatus: "saved" });
  } catch (err) {
    await discardSource(toKind, toId, newId);
    throw err;
  }

  return newId;
}

///////////////////////////////////////////////////////////////////////////
//  Function: copyAllSources
//  Inputs: fromKind, fromId, toKind, toId, options (as for copySource)
//  Outputs: Promise<string[]> — the new sources' ids. If one fails, the
//    copies already made by this call are deleted and the error is rethrown,
//    so a copy is all or nothing.
//  Summary: Used when a template with a packet is copied, when a DBQ template
//    is imported into a document, and when a document is copied.
///////////////////////////////////////////////////////////////////////////
async function copyAllSources(fromKind, fromId, toKind, toId, options = {}) {
  const sources = await listSavedSources(fromKind, fromId);
  const created = [];

  try {
    for (const source of sources) {
      created.push(await copySource(fromKind, fromId, toKind, toId, source.id, options));
    }
  } catch (err) {
    for (const newId of created) await discardSource(toKind, toId, newId);
    throw err;
  }

  return created;
}

export {
  saveExtractedSource,
  listSavedSources,
  getSource,
  loadSourcePages,
  renameSource,
  removeSource,
  removeIncompleteSources,
  totalSourceChars,
  copySource,
  copyAllSources,
  groupPages,
  DOCUMENT_SOURCE_MAX_CHARS
};