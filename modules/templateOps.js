///////////////////////////////////////////////////////////////////////////
// templateOps.js
//  Pure functions on a template's sections, used by the template editor
//  (Screen C). There is no DOM and no Firebase here, and no function changes
//  what it is given: each returns a new array or object. That keeps every
//  rule about editing a template in one place where it can be tested without
//  a browser.
//
//  A section is { id, name, purpose, fields: [ { id, label, prompt,
//  optional } ] }. The "(Section N)" marker is never stored: sectionMarker()
//  makes it from a section's position every time sections are shown.
//
//  Section ids are the keys a document's outline answers use later, so
//  nothing here ever changes the id of an existing section or field.
//
//  Oliver Emerson - 2026
///////////////////////////////////////////////////////////////////////////

import { CATEGORIES } from "./defaultTemplates.js";

const MIN_SECTIONS = 1;
const MAX_SECTIONS = 20;
const MAX_TITLE_CHARS = 120;
const MAX_NAME_CHARS = 120;
const MAX_LABEL_CHARS = 80;
const MAX_PURPOSE_CHARS = 300;
const MAX_PROMPT_CHARS = 500;
const MAX_ANSWER_CHARS = 1500;
const MAX_REASON_CHARS = 240;
const MAX_FIELDS_PER_SECTION = 12;

// Ids made by code must match this (the worker checks the same pattern).
const ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

const CATEGORY_IDS = CATEGORIES.map(c => c.id);
const CHANGE_KINDS = ["added", "duplicated", "removed"];

///////////////////////////////////////////////////////////////////////////
//  Function: oneLine
//  Inputs: value, max
//  Outputs: The text with all whitespace collapsed to single spaces,
//    trimmed, and cut to max characters ("" if value isn't a string)
///////////////////////////////////////////////////////////////////////////
function oneLine(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max).trim();
}

///////////////////////////////////////////////////////////////////////////
//  Function: trimmed
//  Inputs: value, max
//  Outputs: The text trimmed and cut to max characters, keeping its line
//    breaks ("" if value isn't a string)
///////////////////////////////////////////////////////////////////////////
function trimmed(value, max) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max).trim();
}

///////////////////////////////////////////////////////////////////////////
//  Function: newSectionId
//  Inputs: taken (optional Set of ids already in use)
//  Outputs: "sec-" plus 8 random hex characters, not in taken
///////////////////////////////////////////////////////////////////////////
function newSectionId(taken = new Set()) {
  let id;
  do {
    id = `sec-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
  } while (taken.has(id));
  return id;
}

///////////////////////////////////////////////////////////////////////////
//  Function: sectionMarker
//  Inputs: index (zero-based position)
//  Outputs: "(Section N)" where N is index + 1
///////////////////////////////////////////////////////////////////////////
function sectionMarker(index) {
  return `(Section ${index + 1})`;
}

///////////////////////////////////////////////////////////////////////////
//  Function: cloneSections
//  Inputs: sections
//  Outputs: A deep copy
///////////////////////////////////////////////////////////////////////////
function cloneSections(sections) {
  return JSON.parse(JSON.stringify(sections));
}

///////////////////////////////////////////////////////////////////////////
//  Function: duplicateSection
//  Inputs: sections, sectionId
//  Outputs: { sections, newId } with a copy inserted directly after the
//    original, or null if the template already has 20 sections or the id is
//    unknown
//  Summary: The copy has a new section id, new field ids (<newId>-f1,
//    <newId>-f2, ...), the same labels, prompts, purpose, and optional
//    flags, and the name "<name> (copy)" cut to 120 characters.
///////////////////////////////////////////////////////////////////////////
function duplicateSection(sections, sectionId) {
  const index = sections.findIndex(s => s.id === sectionId);
  if (index === -1 || sections.length >= MAX_SECTIONS) return null;

  const original = sections[index];
  const taken = new Set(sections.map(s => s.id));
  sections.forEach(s => s.fields.forEach(f => taken.add(f.id)));
  const newId = newSectionId(taken);

  const copy = {
    id: newId,
    name: `${original.name} (copy)`.slice(0, MAX_NAME_CHARS).trim(),
    purpose: original.purpose,
    fields: original.fields.map((f, i) => ({
      id: `${newId}-f${i + 1}`,
      label: f.label,
      prompt: f.prompt,
      optional: f.optional === true
    }))
  };

  const next = cloneSections(sections);
  next.splice(index + 1, 0, copy);
  return { sections: next, newId };
}

///////////////////////////////////////////////////////////////////////////
//  Function: removeSection
//  Inputs: sections, sectionId
//  Outputs: A new array without that section, or null if only one section
//    remains or the id is unknown
///////////////////////////////////////////////////////////////////////////
function removeSection(sections, sectionId) {
  if (sections.length <= MIN_SECTIONS) return null;
  if (!sections.some(s => s.id === sectionId)) return null;
  return cloneSections(sections.filter(s => s.id !== sectionId));
}

///////////////////////////////////////////////////////////////////////////
//  Function: moveSection
//  Inputs: sections, sectionId, delta (-1 for up, +1 for down)
//  Outputs: A new array with the section moved. At either end the array is
//    returned unchanged (as a copy). An unknown id returns null.
///////////////////////////////////////////////////////////////////////////
function moveSection(sections, sectionId, delta) {
  const index = sections.findIndex(s => s.id === sectionId);
  if (index === -1) return null;

  const next = cloneSections(sections);
  const target = index + (delta < 0 ? -1 : 1);
  if (target < 0 || target >= next.length) return next;

  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

///////////////////////////////////////////////////////////////////////////
//  Function: updateSection
//  Inputs: sections, sectionId, patch ({ name?, purpose? })
//  Outputs: A new array. The name is collapsed to one line and cut to 120
//    characters, and an empty name is ignored (the old name stays). The
//    purpose is trimmed and cut to 300 characters. An unknown id changes
//    nothing.
///////////////////////////////////////////////////////////////////////////
function updateSection(sections, sectionId, patch = {}) {
  const next = cloneSections(sections);
  const section = next.find(s => s.id === sectionId);
  if (!section) return next;

  if (typeof patch.name === "string") {
    const name = oneLine(patch.name, MAX_NAME_CHARS);
    if (name) section.name = name;
  }
  if (typeof patch.purpose === "string") {
    section.purpose = trimmed(patch.purpose, MAX_PURPOSE_CHARS);
  }
  return next;
}

///////////////////////////////////////////////////////////////////////////
//  Function: updateField
//  Inputs: sections, sectionId, fieldId, patch ({ label?, prompt?,
//    optional? })
//  Outputs: A new array. The label is collapsed to one line and cut to 80
//    characters, and an empty label is ignored. The prompt is trimmed and
//    cut to 500 characters, and an empty prompt is allowed (a field may have
//    no hint). optional must be true or false to count. Unknown ids change
//    nothing.
///////////////////////////////////////////////////////////////////////////
function updateField(sections, sectionId, fieldId, patch = {}) {
  const next = cloneSections(sections);
  const section = next.find(s => s.id === sectionId);
  const field = section && section.fields.find(f => f.id === fieldId);
  if (!field) return next;

  if (typeof patch.label === "string") {
    const label = oneLine(patch.label, MAX_LABEL_CHARS);
    if (label) field.label = label;
  }
  if (typeof patch.prompt === "string") {
    field.prompt = trimmed(patch.prompt, MAX_PROMPT_CHARS);
  }
  if (typeof patch.optional === "boolean") {
    field.optional = patch.optional;
  }
  return next;
}

///////////////////////////////////////////////////////////////////////////
//  Function: validateTemplate
//  Inputs: draft ({ title, themeId, category, sections })
//  Outputs: { ok: true } or { ok: false, problems: [string] }, where each
//    problem is written for a student to read
//  Summary: Checks the title (not empty, at most 120 characters), 1 to 20
//    sections, a name and at least one field in every section, a label in
//    every field, ids that match the id pattern and are unique across the
//    whole template, a known category, and a theme id.
///////////////////////////////////////////////////////////////////////////
function validateTemplate(draft) {
  const problems = [];
  const d = draft && typeof draft === "object" ? draft : {};

  const title = typeof d.title === "string" ? d.title.trim() : "";
  if (!title) problems.push("Give the template a name.");
  else if (title.length > MAX_TITLE_CHARS) problems.push(`The template name must be ${MAX_TITLE_CHARS} characters or fewer.`);

  if (!CATEGORY_IDS.includes(d.category)) problems.push("Choose a template type.");
  if (typeof d.themeId !== "string" || !d.themeId.trim()) problems.push("This template has no theme.");

  const sections = Array.isArray(d.sections) ? d.sections : null;
  if (!sections || sections.length < MIN_SECTIONS) {
    problems.push("A template needs at least 1 section.");
    return { ok: false, problems };
  }
  if (sections.length > MAX_SECTIONS) problems.push(`A template can have at most ${MAX_SECTIONS} sections.`);

  const seen = new Set();
  let duplicateId = false;
  let badId = false;
  const noteId = id => {
    if (typeof id !== "string" || !ID_PATTERN.test(id)) { badId = true; return; }
    if (seen.has(id)) duplicateId = true;
    seen.add(id);
  };

  sections.forEach((section, i) => {
    const marker = sectionMarker(i);
    if (!section || typeof section !== "object") {
      problems.push(`${marker} can't be read.`);
      return;
    }
    noteId(section.id);
    if (typeof section.name !== "string" || !section.name.trim()) {
      problems.push(`${marker} needs a name.`);
    }
    const fields = Array.isArray(section.fields) ? section.fields : [];
    if (fields.length < 1) problems.push(`${marker} needs at least one field.`);
    fields.forEach((field, j) => {
      if (!field || typeof field !== "object") {
        problems.push(`${marker}, field ${j + 1} can't be read.`);
        return;
      }
      noteId(field.id);
      if (typeof field.label !== "string" || !field.label.trim()) {
        problems.push(`${marker}, field ${j + 1} needs a label.`);
      }
    });
  });

  if (badId) problems.push("Something in this template has an invalid id.");
  if (duplicateId) problems.push("Two parts of this template share the same id.");

  return problems.length ? { ok: false, problems } : { ok: true };
}

///////////////////////////////////////////////////////////////////////////
//  Function: normalizeLoadedTemplate
//  Inputs: record (a template read from Firestore; anything at all)
//  Outputs: { title, themeId, category, answers, sections, changes,
//    hasPacket } with every part coerced to the right type and capped. A
//    section or field with a bad or repeated id, or with no name or label, is
//    dropped; a section left with no fields is dropped. The category
//    defaults to "argumentative". Never throws.
///////////////////////////////////////////////////////////////////////////
function normalizeLoadedTemplate(record) {
  const r = record && typeof record === "object" ? record : {};
  const usedIds = new Set();

  const claimId = id => {
    if (typeof id !== "string" || !ID_PATTERN.test(id) || usedIds.has(id)) return false;
    usedIds.add(id);
    return true;
  };

  const sections = [];
  const rawSections = Array.isArray(r.sections) ? r.sections : [];

  for (const raw of rawSections) {
    if (sections.length >= MAX_SECTIONS) break;
    if (!raw || typeof raw !== "object") continue;

    const name = oneLine(raw.name, MAX_NAME_CHARS);
    if (!name || typeof raw.id !== "string" || !ID_PATTERN.test(raw.id) || usedIds.has(raw.id)) continue;

    const fields = [];
    const rawFields = Array.isArray(raw.fields) ? raw.fields : [];
    const claimedHere = [];

    for (const f of rawFields) {
      if (fields.length >= MAX_FIELDS_PER_SECTION) break;
      if (!f || typeof f !== "object") continue;
      const label = oneLine(f.label, MAX_LABEL_CHARS);
      if (!label || typeof f.id !== "string" || !ID_PATTERN.test(f.id) || usedIds.has(f.id) || f.id === raw.id) continue;
      usedIds.add(f.id);
      claimedHere.push(f.id);
      fields.push({ id: f.id, label, prompt: trimmed(f.prompt, MAX_PROMPT_CHARS), optional: f.optional === true });
    }

    if (fields.length === 0) continue;
    usedIds.add(raw.id);
    sections.push({ id: raw.id, name, purpose: trimmed(raw.purpose, MAX_PURPOSE_CHARS), fields });
  }

  const rawAnswers = r.answers && typeof r.answers === "object" ? r.answers : {};
  const answers = {
    about: trimmed(rawAnswers.about, MAX_ANSWER_CHARS),
    prompt: trimmed(rawAnswers.prompt, MAX_ANSWER_CHARS),
    requirements: trimmed(rawAnswers.requirements, MAX_ANSWER_CHARS)
  };

  const changes = [];
  (Array.isArray(r.changes) ? r.changes : []).forEach(c => {
    if (!c || typeof c !== "object" || !CHANGE_KINDS.includes(c.kind)) return;
    const reason = oneLine(c.reason, MAX_REASON_CHARS);
    if (!reason) return;
    changes.push({
      kind: c.kind,
      sectionId: typeof c.sectionId === "string" ? c.sectionId : "",
      name: oneLine(c.name, MAX_NAME_CHARS),
      reason
    });
  });

  return {
    title: oneLine(r.title, MAX_TITLE_CHARS) || "Untitled template",
    themeId: typeof r.themeId === "string" && r.themeId.trim() ? r.themeId.trim().slice(0, 100) : "custom",
    category: CATEGORY_IDS.includes(r.category) ? r.category : "argumentative",
    answers,
    sections,
    changes,
    hasPacket: r.hasPacket === true
  };
}

export {
  MIN_SECTIONS,
  MAX_SECTIONS,
  MAX_TITLE_CHARS,
  MAX_NAME_CHARS,
  MAX_LABEL_CHARS,
  MAX_PURPOSE_CHARS,
  MAX_PROMPT_CHARS,
  newSectionId,
  sectionMarker,
  cloneSections,
  duplicateSection,
  removeSection,
  moveSection,
  updateSection,
  updateField,
  validateTemplate,
  normalizeLoadedTemplate
};