///////////////////////////////////////////////////////////////////////////
// personalize.js
//  The browser side of template personalization (the worker route is
//  /template/personalize). It:
//    1. cleans the wizard's three answers (blank and "no" answers are removed
//       before anything is sent, and if nothing is left no AI call is made),
//    2. sends the template and the cleaned answers through the shared request
//       queue,
//    3. verifies the worker's answer on its own, without trusting it, and
//    4. returns a template built from the ORIGINAL sections plus only what
//       was verified: new prompt text, and any section the rules allowed to be
//       added. Names, labels, ids, and order of the original sections never
//       come from the worker's copy.
//
//  When anything is wrong, the unpersonalized template comes back with a
//  message, so the student can always continue.
//
//  Result shapes of personalizeTemplate():
//    { ok: true, sections, changes, personalized, promptsRewritten,
//      fallback?, skipped?, message? }
//    { ok: false, message }               — the request itself failed
//    { ok: false, cancelled: true }       — the student pressed Stop
//  where changes is [{ kind: "added" | "duplicated" | "removed", sectionId,
//  name, reason }], for the preview's banner.
//
//  Oliver Emerson - 2026
///////////////////////////////////////////////////////////////////////////

import { requestWithRetry } from "./api.js";

const ANSWER_MAX_CHARS = 1500;
const MAX_ADDED_SECTIONS = 2;
const MAX_SECTIONS = 20;
const PROMPT_MAX_CHARS = 500;

// Tags the worker uses to fence untrusted text. Copies are removed from
// answers so they can't close a fence early. Keep in sync with the worker.
const FENCE_TAGS = ["topic", "assignment_prompt", "requirements", "template"];

// Answers that mean "nothing" (compared after lowercasing and removing
// everything except letters, digits, and "/"). Keep in sync with the worker.
const NO_ANSWERS = new Set([
  "no", "none", "n/a", "na", "nope", "nothing", "nah", "nil", "notapplicable",
  "norequirements", "nospecificrequirements", "nothanks"
]);

const FALLBACK_MESSAGE =
  "Couldn't personalize this template, so the standard version is shown. You can edit it on the next screen.";

///////////////////////////////////////////////////////////////////////////
// Cleaning the answers
///////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////
//  Function: cleanAnswer
//  Inputs: value (a wizard answer)
//  Outputs: The answer trimmed and capped, with copies of the fence tags
//    removed, or "" if it is blank or clearly "no" ("no", "none", "n/a",
//    "nope", "nothing", and a few similar)
//  Summary: "No more than 5 pages" and "None yet, ask my teacher" are real
//    answers and are kept; only an answer that is nothing but "no" is dropped.
///////////////////////////////////////////////////////////////////////////
function cleanAnswer(value) {
  if (typeof value !== "string") return "";

  const tagPattern = new RegExp(`</?\\s*(?:${FENCE_TAGS.join("|")})\\s*>`, "gi");
  const text = value
    .replace(/\r\n?/g, "\n")
    .replace(tagPattern, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, ANSWER_MAX_CHARS);

  const compact = text.toLowerCase().replace(/[^a-z0-9/]/g, "");
  if (!compact || NO_ANSWERS.has(compact)) return "";
  return text;
}

///////////////////////////////////////////////////////////////////////////
//  Function: cleanAnswers
//  Inputs: raw ({ about, prompt, requirements }, any may be missing)
//  Outputs: { about, prompt, requirements } with each cleaned ("" if unused)
///////////////////////////////////////////////////////////////////////////
function cleanAnswers(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    about: cleanAnswer(source.about),
    prompt: cleanAnswer(source.prompt),
    requirements: cleanAnswer(source.requirements)
  };
}

///////////////////////////////////////////////////////////////////////////
//  Function: hasAnyAnswer
//  Inputs: cleaned (from cleanAnswers)
//  Outputs: true if at least one answer is left
///////////////////////////////////////////////////////////////////////////
function hasAnyAnswer(cleaned) {
  return !!(cleaned.about || cleaned.prompt || cleaned.requirements);
}

///////////////////////////////////////////////////////////////////////////
// Verifying the worker's answer
///////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////
//  Function: cloneSections
//  Inputs: sections
//  Outputs: A deep copy
///////////////////////////////////////////////////////////////////////////
function cloneSections(sections) {
  return JSON.parse(JSON.stringify(sections));
}

///////////////////////////////////////////////////////////////////////////
//  Function: isUsableText
//  Inputs: value, max
//  Outputs: true for a non-empty string of at most max characters
///////////////////////////////////////////////////////////////////////////
function isUsableText(value, max) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

///////////////////////////////////////////////////////////////////////////
//  Function: verifyPersonalization
//  Inputs: original (the template's sections), resultSections and changes
//    (from the worker)
//  Outputs: { ok: true } or { ok: false, reason }
//  Summary: Checks, independently of the worker, that:
//    - the result has 1 to 20 sections;
//    - every original section is either still there, in the original order,
//      with the same field ids, labels, and count, or listed as removed with a
//      reason;
//    - no section appears that isn't listed as added or duplicated (with a
//      reason), and no more than two are;
//    - every prompt is usable text.
///////////////////////////////////////////////////////////////////////////
function verifyPersonalization(original, resultSections, changes) {
  const fail = reason => ({ ok: false, reason });

  if (!Array.isArray(resultSections) || !Array.isArray(changes)) return fail("shape");
  if (resultSections.length < 1 || resultSections.length > MAX_SECTIONS) return fail("section_count");

  const originalById = new Map(original.map(s => [s.id, s]));
  const removedIds = new Set();
  const createdIds = new Set();

  for (const change of changes) {
    const validChange =
      change &&
      typeof change.sectionId === "string" &&
      typeof change.reason === "string" &&
      change.reason.trim().length > 0;
    if (!validChange) return fail("bad_change");

    if (change.kind === "removed") removedIds.add(change.sectionId);
    else if (change.kind === "added" || change.kind === "duplicated") createdIds.add(change.sectionId);
    else return fail("bad_change_kind");
  }

  if (createdIds.size > MAX_ADDED_SECTIONS) return fail("too_many_added");
  for (const id of removedIds) {
    if (!originalById.has(id)) return fail("removed_unknown_section");
  }

  const keptIds = [];
  const seenCreated = new Set();

  for (const section of resultSections) {
    if (!section || typeof section.id !== "string" || !Array.isArray(section.fields)) return fail("bad_section");

    const source = originalById.get(section.id);
    if (source) {
      if (removedIds.has(section.id)) return fail("removed_but_present");
      if (section.fields.length !== source.fields.length) return fail("fields_changed");

      for (let i = 0; i < source.fields.length; i++) {
        const field = section.fields[i];
        if (!field || field.id !== source.fields[i].id || field.label !== source.fields[i].label) {
          return fail("fields_changed");
        }
        if (!isUsableText(field.prompt, PROMPT_MAX_CHARS)) return fail("bad_prompt");
      }
      keptIds.push(section.id);
    } else if (createdIds.has(section.id)) {
      if (seenCreated.has(section.id)) return fail("repeated_section");
      seenCreated.add(section.id);

      if (!isUsableText(section.name, 120) || section.fields.length < 1) return fail("bad_new_section");
      for (const field of section.fields) {
        if (!field || typeof field.id !== "string" || !isUsableText(field.label, 80) || !isUsableText(field.prompt, PROMPT_MAX_CHARS)) {
          return fail("bad_new_section");
        }
      }
    } else {
      return fail("unlisted_section");
    }
  }

  if (seenCreated.size !== createdIds.size) return fail("missing_new_section");

  const expectedKept = original.filter(s => !removedIds.has(s.id)).map(s => s.id);
  if (keptIds.join("\n") !== expectedKept.join("\n")) return fail("order_or_missing");

  return { ok: true };
}

///////////////////////////////////////////////////////////////////////////
//  Function: mergePersonalization
//  Inputs: original (the template's sections), resultSections (already
//    verified)
//  Outputs: The final sections. An original section is the ORIGINAL object
//    with only its prompts replaced; a new section is built from the worker's
//    copy, field by field.
///////////////////////////////////////////////////////////////////////////
function mergePersonalization(original, resultSections) {
  const originalById = new Map(original.map(s => [s.id, s]));

  return resultSections.map(section => {
    const source = originalById.get(section.id);

    if (source) {
      const copy = cloneSections([source])[0];
      copy.fields.forEach((field, i) => {
        field.prompt = section.fields[i].prompt.trim();
      });
      return copy;
    }

    return {
      id: section.id,
      name: section.name.trim(),
      purpose: typeof section.purpose === "string" ? section.purpose.trim() : "",
      fields: section.fields.map(field => ({
        id: field.id,
        label: field.label.trim(),
        prompt: field.prompt.trim(),
        optional: field.optional === true
      }))
    };
  });
}

///////////////////////////////////////////////////////////////////////////
//  Function: normalizeChanges
//  Inputs: changes (verified, from the worker)
//  Outputs: [{ kind, sectionId, name, reason }] with only those four fields
///////////////////////////////////////////////////////////////////////////
function normalizeChanges(changes) {
  return changes.map(change => ({
    kind: change.kind,
    sectionId: change.sectionId,
    name: typeof change.name === "string" ? change.name : "",
    reason: change.reason.trim()
  }));
}

///////////////////////////////////////////////////////////////////////////
// The request
///////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////
//  Function: unchanged
//  Inputs: original (sections), extra (fields to add to the result)
//  Outputs: A successful result holding an untouched copy of the template
///////////////////////////////////////////////////////////////////////////
function unchanged(original, extra = {}) {
  return {
    ok: true,
    sections: cloneSections(original),
    changes: [],
    personalized: false,
    promptsRewritten: 0,
    ...extra
  };
}

///////////////////////////////////////////////////////////////////////////
//  Function: personalizeTemplate
//  Inputs: { sections, answers, allowStructure, isStale, shouldStop,
//    setStatus }
//      sections — the template's sections
//      answers — the raw wizard answers { about, prompt, requirements }
//      allowStructure — false to forbid adding or removing sections (default
//        true)
//      isStale(), shouldStop(), setStatus(text) — as for requestWithRetry, so
//        the progress screen's Stop button and the rate-limit countdown work
//  Outputs: Promise of one of the result shapes at the top of this file
///////////////////////////////////////////////////////////////////////////
async function personalizeTemplate({
  sections,
  answers,
  allowStructure = true,
  isStale = () => false,
  shouldStop = () => false,
  setStatus = () => {}
}) {
  const cleaned = cleanAnswers(answers);

  // Nothing to personalize with: no request, no budget used.
  if (!hasAnyAnswer(cleaned)) return unchanged(sections, { skipped: true });

  const result = await requestWithRetry({
    path: "/template/personalize",
    body: { sections, answers: cleaned, allowStructure },
    label: "Personalizing...",
    isStale,
    shouldStop,
    setStatus,
    fallbackMessage: "Couldn't personalize the template right now. Try again in a moment."
  });

  if (result.cancelled) return { ok: false, cancelled: true };

  // Too big to personalize in one request: carry on with the standard version.
  if (result.tooLong) {
    return unchanged(sections, {
      fallback: true,
      message: result.message || "This template is too large to personalize in one step, so it is shown as it is."
    });
  }

  if (!result.ok) return { ok: false, message: result.message };

  const data = result.data;

  // The worker skipped the AI or fell back on its own.
  if (data.personalized !== true) {
    if (data.fallback === true && typeof data.reason === "string") {
      console.error(`PERSONALIZE: the worker used the standard template (${data.reason}).`);
    }
    return unchanged(sections, {
      skipped: data.skipped === true,
      fallback: data.fallback === true,
      message: typeof data.message === "string" ? data.message : undefined
    });
  }

  const check = verifyPersonalization(sections, data.sections, data.changes);
  if (!check.ok) {
    console.error(`PERSONALIZE: the worker's answer failed verification (${check.reason}); using the standard template.`);
    return unchanged(sections, { fallback: true, message: FALLBACK_MESSAGE });
  }

  return {
    ok: true,
    sections: mergePersonalization(sections, data.sections),
    changes: normalizeChanges(data.changes),
    personalized: true,
    promptsRewritten: Number.isInteger(data.promptsRewritten) ? data.promptsRewritten : 0
  };
}

export {
  personalizeTemplate,
  cleanAnswer,
  cleanAnswers,
  hasAnyAnswer,
  verifyPersonalization,
  mergePersonalization,
  ANSWER_MAX_CHARS,
  MAX_ADDED_SECTIONS
};