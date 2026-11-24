///////////////////////////////////////////////////////////////////////////
// customTemplate.js
//  The browser side of "Custom Theme": copying the structure of a source the
//  student supplies (an essay, article, lab report, or story) into a
//  template. It is a map-reduce over the source:
//
//    Map.    The source is cut into sections of at most 6,500 characters at
//            paragraph boundaries. Each is sent, one request at a time, to
//            /template/outline-map, which answers with a compact structural
//            map: what each run of paragraphs does.
//    Reduce. The maps are merged and sent to /template/custom, which returns
//            a section list (names, purposes, fields, prompts) and a
//            category. The reduce step sees only abstract roles and short
//            notes, never the source's text, so a custom template can't copy
//            the source's content.
//
//  Everything the worker returns is verified here before it is used. If a
//  step fails partway, the result carries a `resume` state, so "Try again"
//  continues from the section that failed instead of re-reading the ones
//  already done.
//
//  Result of buildCustomTemplate():
//    { ok: true, template: { category, sections }, groups }
//    { ok: false, cancelled: true, resume }
//    { ok: false, message, retryAfterSeconds?, resume }
//
//  Nothing here logs the source text or the model's notes.
//
//  Oliver Emerson - 2026
///////////////////////////////////////////////////////////////////////////

import { requestWithRetry, splitIntoSections } from "./api.js";
import { CATEGORIES } from "./defaultTemplates.js";

const MAP_SECTION_CHARS = 6500;  // the most source text sent in one map request
const MAX_REDUCE_GROUPS = 120;   // the most map entries sent to the reduce step
const MAX_MAP_PARAGRAPHS = 200;  // the worker's limit per map request

const ROLE_MAX = 40;
const NOTE_MAX = 80;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const CATEGORY_IDS = CATEGORIES.map(c => c.id);

const UNEXPECTED = "The server sent back something unexpected. Try again.";
const TOO_COMPLEX = "This source is too complex to turn into a template. Try a shorter piece, or choose a default theme.";
const COULDNT_BUILD = "Couldn't build a template from that source. Try again.";

///////////////////////////////////////////////////////////////////////////
//  Function: paragraphsOf
//  Inputs: extracted (the result of extract.js)
//  Outputs: [{ text }] — every page's text split on blank lines, trimmed,
//    with empties dropped, in order. A paragraph's global index is its
//    position in this array.
///////////////////////////////////////////////////////////////////////////
function paragraphsOf(extracted) {
  const pages = extracted && Array.isArray(extracted.pages) ? extracted.pages : [];
  const paragraphs = [];

  pages.forEach(page => {
    String((page && page.text) || "").split(/\n\s*\n/).forEach(chunk => {
      const text = chunk.trim();
      if (text) paragraphs.push({ text });
    });
  });

  return paragraphs;
}

///////////////////////////////////////////////////////////////////////////
//  Function: mapSections
//  Inputs: paragraphs ([{ text }])
//  Outputs: [{ startIndex, paragraphs: [text], chars }] — the sections to
//    send, at most 6,500 characters each (a single longer paragraph stands
//    alone) and at most 200 paragraphs each
///////////////////////////////////////////////////////////////////////////
function mapSections(paragraphs) {
  const sections = [];

  splitIntoSections(paragraphs, MAP_SECTION_CHARS).forEach(section => {
    for (let i = 0; i < section.paragraphs.length; i += MAX_MAP_PARAGRAPHS) {
      const chunk = section.paragraphs.slice(i, i + MAX_MAP_PARAGRAPHS);
      sections.push({
        startIndex: section.startIndex + i,
        paragraphs: chunk,
        chars: chunk.reduce((n, p) => n + p.length, 0)
      });
    }
  });

  return sections;
}

///////////////////////////////////////////////////////////////////////////
//  Function: condenseGroups
//  Inputs: groups ([{ from, to, role, note }], in order), maxEntries
//  Outputs: A new list that is no longer than maxEntries. Pure.
//  Summary: First merges consecutive groups with the same role (the first
//    one's start and note, the last one's end). If more than maxEntries
//    remain, repeatedly merges the adjacent pair with the smallest combined
//    paragraph span, keeping the role and note of the longer of the two,
//    until the list fits. Order and coverage are preserved.
///////////////////////////////////////////////////////////////////////////
function condenseGroups(groups, maxEntries) {
  const merged = [];

  groups.forEach(group => {
    const last = merged[merged.length - 1];
    if (last && last.role === group.role) {
      last.to = group.to;
    } else {
      merged.push({ from: group.from, to: group.to, role: group.role, note: group.note });
    }
  });

  const span = g => g.to - g.from + 1;

  while (merged.length > Math.max(1, maxEntries)) {
    let bestIndex = 0;
    let bestSize = Infinity;

    for (let i = 0; i < merged.length - 1; i++) {
      const size = merged[i + 1].to - merged[i].from + 1;
      if (size < bestSize) {
        bestSize = size;
        bestIndex = i;
      }
    }

    const a = merged[bestIndex];
    const b = merged[bestIndex + 1];
    const keep = span(b) > span(a) ? b : a;
    merged.splice(bestIndex, 2, { from: a.from, to: b.to, role: keep.role, note: keep.note });
  }

  return merged;
}

///////////////////////////////////////////////////////////////////////////
//  Function: cleanGroups
//  Inputs: raw (the worker's `groups`), firstIndex, lastIndex (the range of
//    paragraph numbers this request covered)
//  Outputs: The usable entries, in order: integer from and to inside the
//    range with from <= to, no overlap with the entry before, a role and a
//    note that are strings within their caps. Bad entries are dropped.
///////////////////////////////////////////////////////////////////////////
function cleanGroups(raw, firstIndex, lastIndex) {
  if (!Array.isArray(raw)) return [];

  const kept = [];
  const sorted = raw
    .filter(g => g && Number.isInteger(g.from) && Number.isInteger(g.to) && g.from <= g.to && g.from >= firstIndex && g.to <= lastIndex)
    .sort((a, b) => a.from - b.from);

  sorted.forEach(g => {
    const last = kept[kept.length - 1];
    if (last && g.from <= last.to) return;

    const role = typeof g.role === "string" ? g.role.replace(/\s+/g, " ").trim().slice(0, ROLE_MAX).toLowerCase() : "";
    const note = typeof g.note === "string" ? g.note.replace(/\s+/g, " ").trim().slice(0, NOTE_MAX) : "";
    kept.push({ from: g.from, to: g.to, role: role || "other", note });
  });

  return kept;
}

///////////////////////////////////////////////////////////////////////////
//  Function: isText
//  Inputs: value, max
//  Outputs: true for a non-empty string of at most max characters
///////////////////////////////////////////////////////////////////////////
function isText(value, max) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

///////////////////////////////////////////////////////////////////////////
//  Function: verifyCustomTemplate
//  Inputs: data (the /template/custom answer)
//  Outputs: { category, sections } if it is sound, otherwise null
//  Summary: The category must be one of the five (anything else becomes
//    "argumentative"); there must be 1 to 20 sections with names, purposes,
//    and 1 to 8 fields each; ids must match the id pattern and be unique
//    across the whole template; every string must be non-empty and within
//    its cap.
///////////////////////////////////////////////////////////////////////////
function verifyCustomTemplate(data) {
  if (!data || typeof data !== "object" || !Array.isArray(data.sections)) return null;
  if (data.sections.length < 1 || data.sections.length > 20) return null;

  const used = new Set();
  const claim = id => {
    if (typeof id !== "string" || !ID_PATTERN.test(id) || used.has(id)) return false;
    used.add(id);
    return true;
  };

  const sections = [];
  for (const s of data.sections) {
    if (!s || typeof s !== "object" || !claim(s.id)) return null;
    if (!isText(s.name, 120) || !isText(s.purpose, 300)) return null;
    if (!Array.isArray(s.fields) || s.fields.length < 1 || s.fields.length > 8) return null;

    const fields = [];
    for (const f of s.fields) {
      if (!f || typeof f !== "object" || !claim(f.id)) return null;
      if (!isText(f.label, 80) || !isText(f.prompt, 500)) return null;
      fields.push({ id: f.id, label: f.label.trim(), prompt: f.prompt.trim(), optional: f.optional === true });
    }
    sections.push({ id: s.id, name: s.name.trim(), purpose: s.purpose.trim(), fields });
  }

  return {
    category: CATEGORY_IDS.includes(data.category) ? data.category : "argumentative",
    sections
  };
}

///////////////////////////////////////////////////////////////////////////
//  Function: buildCustomTemplate
//  Inputs: { extracted, resume, isStale, shouldStop, setStatus, onProgress }
//      extracted — the result of extract.js for the source
//      resume — { nextSection, groups } from an earlier failed or stopped
//        run on the same source, to carry on from; or null
//      isStale(), shouldStop(), setStatus(text) — as for requestWithRetry
//      onProgress({ done, total }) — called after each map section
//  Outputs: Promise of one of the result shapes at the top of this file
///////////////////////////////////////////////////////////////////////////
async function buildCustomTemplate({
  extracted,
  resume = null,
  isStale = () => false,
  shouldStop = () => false,
  setStatus = () => {},
  onProgress = () => {}
}) {
  const paragraphs = paragraphsOf(extracted);
  if (paragraphs.length === 0) {
    return { ok: false, message: "There was no text to read in that source.", resume: null };
  }

  const sections = mapSections(paragraphs);
  const total = sections.length;

  let nextSection = resume && Number.isInteger(resume.nextSection) ? Math.max(0, resume.nextSection) : 0;
  const groups = resume && Array.isArray(resume.groups) ? resume.groups.slice() : [];

  // ---- Map: one request per section ----
  for (let i = nextSection; i < total; i++) {
    const resumeHere = () => ({ nextSection: i, groups: groups.slice() });
    if (shouldStop()) return { ok: false, cancelled: true, resume: resumeHere() };

    const label = total === 1 ? "Reading..." : `Reading section ${i + 1} of ${total}...`;
    setStatus(i === 0 && total > 1
      ? `${label} A long source takes a few minutes because of the AI's per-minute limit.`
      : label);

    const section = sections[i];
    const result = await requestWithRetry({
      path: "/template/outline-map",
      body: { paragraphs: section.paragraphs, startIndex: section.startIndex },
      label,
      isStale,
      shouldStop,
      setStatus,
      fallbackMessage: "Couldn't read that part of the source right now. Try again in a moment."
    });

    if (result.cancelled) return { ok: false, cancelled: true, resume: resumeHere() };
    if (!result.ok) {
      return {
        ok: false,
        message: result.message || "Couldn't read that part of the source right now. Try again in a moment.",
        retryAfterSeconds: result.retryAfterSeconds,
        resume: resumeHere()
      };
    }

    const valid = cleanGroups(
      result.data && result.data.groups,
      section.startIndex,
      section.startIndex + section.paragraphs.length - 1
    );
    if (valid.length === 0) {
      console.error("CUSTOM TEMPLATE: a map answer had no usable entries.");
      return { ok: false, message: UNEXPECTED, resume: resumeHere() };
    }

    groups.push(...valid);
    nextSection = i + 1;
    onProgress({ done: i + 1, total });
  }

  // ---- Reduce: one request for the whole template ----
  const reduceResume = () => ({ nextSection: total, groups: groups.slice() });
  if (shouldStop()) return { ok: false, cancelled: true, resume: reduceResume() };

  const condensed = condenseGroups(groups, MAX_REDUCE_GROUPS);
  setStatus("Building your template...");

  const result = await requestWithRetry({
    path: "/template/custom",
    body: { groups: condensed, paragraphCount: paragraphs.length },
    label: "Building your template...",
    isStale,
    shouldStop,
    setStatus,
    fallbackMessage: "Couldn't build the template right now. Try again in a moment."
  });

  if (result.cancelled) return { ok: false, cancelled: true, resume: reduceResume() };
  if (result.tooLong) return { ok: false, message: TOO_COMPLEX, resume: null };
  if (!result.ok) {
    return {
      ok: false,
      message: result.message || "Couldn't build the template right now. Try again in a moment.",
      retryAfterSeconds: result.retryAfterSeconds,
      resume: reduceResume()
    };
  }

  const template = verifyCustomTemplate(result.data);
  if (!template) {
    console.error("CUSTOM TEMPLATE: the worker's template failed verification.");
    return { ok: false, message: COULDNT_BUILD, resume: reduceResume() };
  }

  return { ok: true, template, groups: condensed };
}

export {
  buildCustomTemplate,
  condenseGroups,
  paragraphsOf,
  MAP_SECTION_CHARS,
  MAX_REDUCE_GROUPS
};