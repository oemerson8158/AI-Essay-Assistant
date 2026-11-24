///////////////////////////////////////////////////////////////////////////
// templateEditor.js
//  Screen C: the preview for a template the wizard just made, and the editor
//  for a saved one. It lives in #tpl-editor inside #template-editor-screen.
//
//  The editor works on one in-memory draft:
//    New mode   — the wizard emits TEMPLATE_PREVIEW with a draft. Back asks
//                 the wizard to show Screen B again (WIZARD_RESUME) and
//                 discards nothing. Save creates the template, and the
//                 document packet too, if there is one.
//    Edit mode  — OPEN_TEMPLATE. The record is read again from Firestore
//                 (the list on Home may be stale), shown, and saved back.
//
//  Every change to the sections goes through templateOps.js. The cards are
//  native buttons, with no drag and drop, so everything works on an iPad.
//  Typing into a box updates the draft and the card's header in place
//  without redrawing the list, so the cursor never jumps; only Duplicate,
//  Remove, and Move redraw it.
//
//  The draft: { mode, templateId, title, themeId, category, answers,
//    sections, changes, notice, packet ({ extracted, name } or null),
//    hasPacket, packetInfo ({ name, pageCount, paged, charCount } or null),
//    isCustom }
//
//  Untrusted text (names, prompts, file names) only ever enters the page
//  through textContent or the value property.
//
//  Oliver Emerson - 2026
///////////////////////////////////////////////////////////////////////////

import { state, setState, on, emit, EVENTS } from "./state.js";
import { showScreen } from "./router.js";
import { confirmDialog } from "./modal.js";
import { getTemplateRecord, createTemplateRecord, saveTemplateRecord } from "./firebase.js";
import { listSavedSources, saveExtractedSource } from "./sourceStore.js";
import { CATEGORIES, getDefaultTheme } from "./defaultTemplates.js";
import { cleanAnswers } from "./personalize.js";
import { approxWords } from "./extract.js";
import * as ops from "./templateOps.js";

const editor = {
  mode: null,        // "new" | "edit" | null (nothing open)
  draft: null,
  dirty: false,
  saving: false,
  expanded: new Set(), // ids of the cards that are open (UI only, never saved)
  openToken: 0       // so a slow read for an old open is ignored
};

let els = {}; // the elements render() makes, by name

///////////////////////////////////////////////////////////////////////////
//  Function: h
//  Inputs: tag, props (attributes; "class" and "text" are special),
//    children (elements or strings)
//  Outputs: A new element. Strings become text nodes, so nothing is parsed
//    as HTML.
///////////////////////////////////////////////////////////////////////////
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  Object.entries(props).forEach(([key, value]) => {
    if (value === undefined || value === null || value === false) return;
    if (key === "class") el.className = value;
    else if (key === "text") el.textContent = value;
    else el.setAttribute(key, value === true ? "" : String(value));
  });
  children.flat().forEach(child => {
    if (child === null || child === undefined || child === false) return;
    el.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  });
  return el;
}

///////////////////////////////////////////////////////////////////////////
//  Function: autoGrow
//  Inputs: textarea
//  Outputs: Sets the textarea's height to fit its text (does nothing while
//    it is hidden inside a collapsed card)
///////////////////////////////////////////////////////////////////////////
function autoGrow(textarea) {
  textarea.style.height = "auto";
  if (textarea.scrollHeight) textarea.style.height = `${textarea.scrollHeight + 2}px`;
}

///////////////////////////////////////////////////////////////////////////
//  Function: getSection
//  Inputs: sectionId
//  Outputs: The draft's current section with that id, or undefined
///////////////////////////////////////////////////////////////////////////
function getSection(sectionId) {
  return editor.draft.sections.find(s => s.id === sectionId);
}

///////////////////////////////////////////////////////////////////////////
//  Function: setStatus
//  Inputs: text, isError (boolean)
//  Outputs: Shows a line next to the Save button (red when isError)
///////////////////////////////////////////////////////////////////////////
function setStatus(text, isError = false) {
  if (!els.status) return;
  els.status.textContent = text;
  els.status.classList.toggle("tpl-status-error", isError);
}

///////////////////////////////////////////////////////////////////////////
//  Function: announce
//  Inputs: text
//  Outputs: Puts text in the live region so screen readers say it
///////////////////////////////////////////////////////////////////////////
function announce(text) {
  if (els.live) els.live.textContent = text;
}

///////////////////////////////////////////////////////////////////////////
//  Function: markDirty
//  Inputs: None
//  Outputs: Records that the student has changed something since the last
//    save, and clears an old "Saved." or error line
///////////////////////////////////////////////////////////////////////////
function markDirty() {
  editor.dirty = true;
  if (!editor.saving) setStatus("");
}

///////////////////////////////////////////////////////////////////////////
//  Function: goHome
//  Inputs: None
//  Outputs: Forgets the open template and asks for Home's Templates list
///////////////////////////////////////////////////////////////////////////
function goHome() {
  setState({ currentTemplateId: null });
  emit(EVENTS.HOME_REQUESTED, { view: "templates" });
}

///////////////////////////////////////////////////////////////////////////
//  Function: resetEditor
//  Inputs: None
//  Outputs: Forgets the draft and empties the screen. Used on sign-out so
//    the next person never sees the last student's template.
///////////////////////////////////////////////////////////////////////////
function resetEditor() {
  editor.openToken++;
  editor.mode = null;
  editor.draft = null;
  editor.dirty = false;
  editor.saving = false;
  editor.expanded = new Set();
  els = {};
  const root = document.getElementById("tpl-editor");
  if (root) root.textContent = "";
}

///////////////////////////////////////////////////////////////////////////
//  Function: pagesText
//  Inputs: info ({ pageCount, paged, charCount })
//  Outputs: "12 pages" for a paged file, otherwise "about 800 words"
///////////////////////////////////////////////////////////////////////////
function pagesText(info) {
  if (info.paged !== false && info.pageCount > 0) {
    return `${info.pageCount} page${info.pageCount === 1 ? "" : "s"}`;
  }
  return `about ${approxWords(info.charCount || 0)} words`;
}

///////////////////////////////////////////////////////////////////////////
//  Function: packetLine
//  Inputs: None
//  Outputs: The read-only packet note for the draft, or "" if the template
//    has no packet
///////////////////////////////////////////////////////////////////////////
function packetLine() {
  const d = editor.draft;
  let info = d.packetInfo;
  if (d.packet && d.packet.extracted) {
    info = {
      name: d.packet.name,
      pageCount: d.packet.extracted.pageCount,
      paged: d.packet.extracted.paged,
      charCount: d.packet.extracted.charCount
    };
  }

  if (info) {
    return `Document packet: ${info.name} (${pagesText(info)}). It will be added to the Material tab of any document you start from this template.`;
  }
  if (d.hasPacket) {
    return "Document packet: attached. It will be added to the Material tab of any document you start from this template.";
  }
  return "";
}

///////////////////////////////////////////////////////////////////////////
//  Function: changeLines
//  Inputs: changes ([{ kind, name, reason }])
//  Outputs: One line per change, such as "Added a section: Counterargument.
//    The prompt requires one."
///////////////////////////////////////////////////////////////////////////
function changeLines(changes) {
  const verbs = { added: "Added a section", duplicated: "Duplicated a section", removed: "Removed a section" };
  return changes.map(c => `${verbs[c.kind] || "Changed a section"}: ${c.name}. ${c.reason}`);
}

///////////////////////////////////////////////////////////////////////////
// Building the screen
///////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////
//  Function: buildTextField
//  Inputs: { id, label, value, maxLength, onInput }
//  Outputs: A wrapper holding a label and a text input (16 px, so iPad
//    Safari doesn't zoom)
///////////////////////////////////////////////////////////////////////////
function buildTextField({ id, label, value, maxLength, onInput }) {
  const input = h("input", { type: "text", id, class: "tpl-input", maxlength: maxLength });
  input.value = value;
  input.addEventListener("input", () => onInput(input.value));
  return h("div", { class: "tpl-field" }, h("label", { for: id, text: label }), input);
}

///////////////////////////////////////////////////////////////////////////
//  Function: buildCard
//  Inputs: section, index, total (how many sections there are)
//  Outputs: One <li> card: a header button that opens and closes it, four
//    action buttons, and the editable content
///////////////////////////////////////////////////////////////////////////
function buildCard(section, index, total) {
  const id = section.id;
  const bodyId = `tpl-body-${id}`;
  const expanded = editor.expanded.has(id);

  const markerEl = h("span", { class: "tpl-card-marker", text: ops.sectionMarker(index) });
  const nameEl = h("span", { class: "tpl-card-name", text: section.name });
  const countEl = h("span", {
    class: "tpl-card-count",
    text: `${section.fields.length} field${section.fields.length === 1 ? "" : "s"}`
  });

  const toggle = h("button", {
    type: "button",
    class: "tpl-card-toggle",
    "aria-expanded": String(expanded),
    "aria-controls": bodyId,
    "data-toggle": id
  }, markerEl, nameEl, countEl);

  const body = h("div", { class: "tpl-card-body", id: bodyId });
  body.hidden = !expanded;

  toggle.addEventListener("click", () => {
    const open = body.hidden;
    body.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    if (open) {
      editor.expanded.add(id);
      body.querySelectorAll("textarea").forEach(autoGrow);
    } else {
      editor.expanded.delete(id);
    }
  });

  const makeAction = (action, label, onClick, disabled) => {
    const btn = h("button", {
      type: "button",
      class: "tpl-action" + (action === "remove" ? " tpl-action-danger" : ""),
      "data-action": `${action}-${id}`,
      "aria-label": `${label} ${section.name}`,
      text: label
    });
    btn.disabled = disabled;
    btn.addEventListener("click", onClick);
    return btn;
  };

  const actions = h("div", { class: "tpl-card-actions" },
    makeAction("duplicate", "Duplicate", () => duplicate(id), total >= ops.MAX_SECTIONS),
    makeAction("remove", "Remove", () => remove(id), total <= ops.MIN_SECTIONS),
    makeAction("up", "Move up", () => move(id, -1), index === 0),
    makeAction("down", "Move down", () => move(id, 1), index === total - 1)
  );

  // ---- Editable content ----
  const nameInput = h("input", { type: "text", id: `tpl-name-${id}`, class: "tpl-input", maxlength: ops.MAX_NAME_CHARS });
  nameInput.value = section.name;
  nameInput.addEventListener("input", () => {
    editor.draft.sections = ops.updateSection(editor.draft.sections, id, { name: nameInput.value });
    const currentName = getSection(id).name;
    nameEl.textContent = currentName;
    card.querySelectorAll("[data-action]").forEach(btn => {
      btn.setAttribute("aria-label", `${btn.textContent} ${currentName}`);
    });
    markDirty();
  });

  const purposeInput = h("textarea", { id: `tpl-purpose-${id}`, class: "tpl-textarea", rows: "2", maxlength: ops.MAX_PURPOSE_CHARS });
  purposeInput.value = section.purpose || "";
  purposeInput.addEventListener("input", () => {
    editor.draft.sections = ops.updateSection(editor.draft.sections, id, { purpose: purposeInput.value });
    autoGrow(purposeInput);
    markDirty();
  });

  body.append(
    h("div", { class: "tpl-field" }, h("label", { for: nameInput.id, text: "Section name" }), nameInput),
    h("div", { class: "tpl-field" }, h("label", { for: purposeInput.id, text: "Purpose" }), purposeInput)
  );

  section.fields.forEach(field => {
    const fid = field.id;
    const labelInput = h("input", { type: "text", id: `tpl-label-${fid}`, class: "tpl-input", maxlength: ops.MAX_LABEL_CHARS });
    labelInput.value = field.label;
    labelInput.addEventListener("input", () => {
      editor.draft.sections = ops.updateField(editor.draft.sections, id, fid, { label: labelInput.value });
      markDirty();
    });

    const promptInput = h("textarea", { id: `tpl-prompt-${fid}`, class: "tpl-textarea", rows: "2", maxlength: ops.MAX_PROMPT_CHARS });
    promptInput.value = field.prompt || "";
    promptInput.addEventListener("input", () => {
      editor.draft.sections = ops.updateField(editor.draft.sections, id, fid, { prompt: promptInput.value });
      autoGrow(promptInput);
      markDirty();
    });

    const optionalInput = h("input", { type: "checkbox", id: `tpl-optional-${fid}` });
    optionalInput.checked = field.optional === true;
    optionalInput.addEventListener("change", () => {
      editor.draft.sections = ops.updateField(editor.draft.sections, id, fid, { optional: optionalInput.checked });
      markDirty();
    });

    body.appendChild(h("div", { class: "tpl-field-group" },
      h("div", { class: "tpl-field" }, h("label", { for: labelInput.id, text: "Field label" }), labelInput),
      h("div", { class: "tpl-field" }, h("label", { for: promptInput.id, text: "Prompt" }), promptInput),
      h("div", { class: "tpl-check" }, optionalInput, h("label", { for: optionalInput.id, text: "Optional" }))
    ));
  });

  const card = h("li", { class: "tpl-card", "data-section-id": id },
    h("div", { class: "tpl-card-head" }, toggle, actions),
    body
  );

  if (expanded) body.querySelectorAll("textarea").forEach(autoGrow);
  return card;
}

///////////////////////////////////////////////////////////////////////////
//  Function: renderSections
//  Inputs: None
//  Outputs: Redraws every card from the draft. Used only after Duplicate,
//    Remove, or Move, so a card never loses focus while someone types.
///////////////////////////////////////////////////////////////////////////
function renderSections() {
  const list = els.list;
  list.textContent = "";

  const sections = editor.draft.sections;
  if (sections.length === 0) {
    list.appendChild(h("li", { class: "tool-hint", text: "This template has no sections. Delete it from Home and create a new one." }));
    return;
  }
  sections.forEach((section, i) => list.appendChild(buildCard(section, i, sections.length)));
}

///////////////////////////////////////////////////////////////////////////
//  Function: focusInCard
//  Inputs: selector
//  Outputs: Moves keyboard focus to the first matching element in the list
///////////////////////////////////////////////////////////////////////////
function focusInCard(selector) {
  const target = els.list.querySelector(selector);
  if (target && !target.disabled) target.focus();
}

///////////////////////////////////////////////////////////////////////////
//  Function: duplicate
//  Inputs: sectionId
//  Outputs: Adds a copy after the section, opens it, and moves focus to its
//    header
///////////////////////////////////////////////////////////////////////////
function duplicate(sectionId) {
  const result = ops.duplicateSection(editor.draft.sections, sectionId);
  if (!result) return;

  editor.draft.sections = result.sections;
  editor.expanded.add(result.newId);
  markDirty();
  renderSections();
  announce("Section duplicated");
  focusInCard(`[data-toggle="${result.newId}"]`);
}

///////////////////////////////////////////////////////////////////////////
//  Function: remove
//  Inputs: sectionId
//  Outputs: After a confirmation, removes the section and moves focus to the
//    card that took its place
///////////////////////////////////////////////////////////////////////////
async function remove(sectionId) {
  const section = getSection(sectionId);
  if (!section) return;

  const confirmed = await confirmDialog({
    title: "Remove this section?",
    message: `"${section.name}" will be removed from this template.`,
    confirmLabel: "Remove",
    danger: true
  });
  if (!confirmed || !editor.draft) return;

  const index = editor.draft.sections.findIndex(s => s.id === sectionId);
  const next = ops.removeSection(editor.draft.sections, sectionId);
  if (!next) return;

  editor.draft.sections = next;
  editor.expanded.delete(sectionId);
  markDirty();
  renderSections();
  announce("Section removed");

  const neighbor = next[Math.min(index, next.length - 1)];
  if (neighbor) focusInCard(`[data-toggle="${neighbor.id}"]`);
}

///////////////////////////////////////////////////////////////////////////
//  Function: move
//  Inputs: sectionId, delta (-1 up, +1 down)
//  Outputs: Moves the section and keeps focus on the same button, or on the
//    card's header if that button is now disabled at an end
///////////////////////////////////////////////////////////////////////////
function move(sectionId, delta) {
  const next = ops.moveSection(editor.draft.sections, sectionId, delta);
  if (!next) return;

  editor.draft.sections = next;
  markDirty();
  renderSections();
  announce(delta < 0 ? "Section moved up" : "Section moved down");

  const button = els.list.querySelector(`[data-action="${delta < 0 ? "up" : "down"}-${sectionId}"]`);
  if (button && !button.disabled) button.focus();
  else focusInCard(`[data-toggle="${sectionId}"]`);
}

///////////////////////////////////////////////////////////////////////////
//  Function: render
//  Inputs: None (reads editor.draft)
//  Outputs: Builds the whole screen: header, name, type, notices, the
//    section list, and the Save footer
///////////////////////////////////////////////////////////////////////////
function render() {
  const root = document.getElementById("tpl-editor");
  if (!root || !editor.draft) return;

  const d = editor.draft;
  root.textContent = "";
  els = {};

  // ---- Header ----
  const backBtn = h("button", { type: "button", class: "btn-secondary", id: "tpl-back", text: "\u2190 Back" });
  backBtn.addEventListener("click", handleBack);

  els.heading = h("h2", {
    class: "tpl-heading",
    id: "tpl-heading",
    tabindex: "-1",
    text: editor.mode === "edit" ? "Edit template" : "Review your template"
  });

  const helpBtn = h("button", {
    type: "button",
    class: "help-btn",
    "data-help": "wizard",
    title: "How this screen works",
    "aria-label": "How this screen works",
    "aria-haspopup": "dialog",
    "aria-expanded": "false",
    text: "?"
  });

  root.appendChild(h("div", { class: "tpl-header" }, backBtn, els.heading, helpBtn));

  // ---- Name and type ----
  root.appendChild(buildTextField({
    id: "tpl-title",
    label: "Template name",
    value: d.title,
    maxLength: ops.MAX_TITLE_CHARS,
    onInput: value => { d.title = value; markDirty(); }
  }));

  if (d.isCustom) {
    const select = h("select", { id: "tpl-category", class: "tpl-input" });
    CATEGORIES.forEach(c => {
      const option = h("option", { value: c.id, text: c.label });
      option.selected = c.id === d.category;
      select.appendChild(option);
    });
    select.addEventListener("change", () => { d.category = select.value; markDirty(); });

    root.appendChild(h("div", { class: "tpl-field" },
      h("label", { for: "tpl-category", text: "Template type" }),
      select,
      h("p", {
        class: "tool-hint tpl-field-hint",
        text: "This controls whether argument analysis is offered. Argument analysis isn't offered for narrative or lab report templates."
      })
    ));
  }

  // ---- Notice, changes, packet ----
  if (d.notice) {
    root.appendChild(h("p", { class: "tpl-notice", role: "status", text: d.notice }));
  }

  if (Array.isArray(d.changes) && d.changes.length > 0) {
    const banner = h("div", { class: "tpl-banner" },
      h("h3", { class: "tpl-banner-title", text: "Changes made while personalizing" }),
      h("ul", { class: "tpl-banner-list" }, changeLines(d.changes).map(line => h("li", { text: line })))
    );
    if (editor.mode === "edit") {
      banner.appendChild(h("p", {
        class: "tool-hint tpl-banner-note",
        text: "These notes describe what personalization changed. Edits you make later aren't tracked here."
      }));
    }
    root.appendChild(banner);
  }

  const packet = packetLine();
  if (packet) root.appendChild(h("p", { class: "tpl-packet", text: packet }));

  // ---- Sections ----
  els.list = h("ol", { class: "tpl-list", "aria-label": "Sections" });
  root.appendChild(els.list);
  renderSections();

  els.live = h("p", { class: "tpl-live", "aria-live": "polite" });
  root.appendChild(els.live);

  // ---- Footer ----
  els.save = h("button", { type: "button", class: "btn-primary", id: "tpl-save", text: "Save" });
  els.save.addEventListener("click", save);
  els.status = h("p", { class: "tpl-status", id: "tpl-status", role: "status" });
  root.appendChild(h("div", { class: "tpl-footer" }, els.save, els.status));
}

///////////////////////////////////////////////////////////////////////////
// Back and Save
///////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////
//  Function: handleBack
//  Inputs: None
//  Outputs: New mode: asks the wizard to show Screen B again, with nothing
//    discarded (unless the template was already created by an earlier Save,
//    in which case it goes Home). Edit mode: goes Home, asking first if
//    there are unsaved changes.
///////////////////////////////////////////////////////////////////////////
async function handleBack() {
  if (editor.saving || !editor.draft) return;

  if (editor.mode === "new") {
    if (editor.draft.templateId) {
      goHome();
    } else {
      emit(EVENTS.WIZARD_RESUME);
    }
    return;
  }

  if (editor.dirty) {
    const discard = await confirmDialog({
      title: "Discard your changes?",
      message: "Your changes to this template haven't been saved.",
      confirmLabel: "Discard",
      danger: true
    });
    if (!discard) return;
  }
  editor.dirty = false;
  goHome();
}

///////////////////////////////////////////////////////////////////////////
//  Function: sectionsForSave
//  Inputs: None
//  Outputs: A copy of the draft's sections for Firestore
///////////////////////////////////////////////////////////////////////////
function sectionsForSave() {
  return ops.cloneSections(editor.draft.sections);
}

///////////////////////////////////////////////////////////////////////////
//  Function: save
//  Inputs: None
//  Outputs: Checks the draft and saves it.
//    New mode: creates the template record once (and remembers its id), then
//      saves the packet under it, then marks hasPacket. If the packet fails,
//      the template stays and the next Save retries only the packet.
//    Edit mode: updates the title and sections (and the type, for a custom
//      template).
//    Then goes Home to the Templates list.
///////////////////////////////////////////////////////////////////////////
async function save() {
  if (editor.saving || !editor.draft) return;
  const d = editor.draft;
  const user = state.currentUser;
  if (!user) return;

  const title = d.title.trim().slice(0, ops.MAX_TITLE_CHARS);
  const check = ops.validateTemplate({ title, themeId: d.themeId, category: d.category, sections: d.sections });
  if (!check.ok) {
    setStatus(check.problems.join(" "), true);
    return;
  }

  editor.saving = true;
  els.save.disabled = true;
  setStatus("Saving...");
  const draftAtStart = d;

  try {
    if (editor.mode === "edit") {
      const data = { title, sections: sectionsForSave() };
      if (d.isCustom) data.category = d.category;
      try {
        await saveTemplateRecord(d.templateId, data);
      } catch (err) {
        console.error("TEMPLATE EDITOR: couldn't save the template:", err);
        if (editor.draft === draftAtStart) setStatus("Couldn't save the template. Try again in a moment.", true);
        return;
      }
    } else {
      if (!d.templateId) {
        try {
          d.templateId = await createTemplateRecord(user.uid, {
            title,
            themeId: d.themeId,
            category: d.category,
            answers: cleanAnswers(d.answers),
            sections: sectionsForSave(),
            changes: d.changes || [],
            hasPacket: false
          });
        } catch (err) {
          console.error("TEMPLATE EDITOR: couldn't create the template:", err);
          if (editor.draft === draftAtStart) setStatus("Couldn't save the template. Try again in a moment.", true);
          return;
        }
      } else {
        // A retry after the packet failed: keep any edits made since.
        try {
          await saveTemplateRecord(d.templateId, { title, category: d.category, sections: sectionsForSave() });
        } catch (err) {
          console.error("TEMPLATE EDITOR: couldn't save the template:", err);
          if (editor.draft === draftAtStart) setStatus("Couldn't save the template. Try again in a moment.", true);
          return;
        }
      }

      if (d.packet && !d.packetFlagged) {
        try {
          if (!d.packetSaved) {
            await saveExtractedSource("template", d.templateId, d.packet.extracted, { kind: "packet", name: d.packet.name });
            d.packetSaved = true;
          }
          await saveTemplateRecord(d.templateId, { hasPacket: true });
          d.packetFlagged = true;
        } catch (err) {
          console.error("TEMPLATE EDITOR: couldn't save the document packet:", err);
          if (editor.draft === draftAtStart) {
            setStatus("The template was saved, but the document packet couldn't be. Try Save again to retry the packet.", true);
          }
          return;
        }
      }
    }

    if (editor.draft !== draftAtStart) return; // signed out or replaced meanwhile
    editor.dirty = false;
    setStatus("Saved.");
    goHome();
  } finally {
    editor.saving = false;
    if (els.save) els.save.disabled = false;
  }
}

///////////////////////////////////////////////////////////////////////////
// Opening
///////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////
//  Function: showPreview
//  Inputs: detail (the wizard's draft)
//  Outputs: Takes a copy of the draft and draws it in new mode. The wizard
//    shows the screen itself, so only the contents are made here. Only the
//    first card starts open.
///////////////////////////////////////////////////////////////////////////
function showPreview(detail) {
  if (!detail || typeof detail !== "object") return;

  editor.openToken++;
  editor.mode = "new";
  editor.dirty = false;
  editor.saving = false;

  const sections = ops.cloneSections(Array.isArray(detail.sections) ? detail.sections : []);
  editor.draft = {
    mode: "new",
    templateId: detail.templateId || null,
    title: typeof detail.title === "string" ? detail.title : "Untitled template",
    themeId: detail.themeId || "custom",
    category: detail.category || "argumentative",
    answers: detail.answers || { about: "", prompt: "", requirements: "" },
    sections,
    changes: Array.isArray(detail.changes) ? detail.changes : [],
    notice: typeof detail.notice === "string" ? detail.notice : "",
    packet: detail.packet || null,
    hasPacket: detail.hasPacket === true,
    packetInfo: detail.packetInfo || null,
    isCustom: detail.isCustom === true,
    packetSaved: false,
    packetFlagged: false
  };

  editor.expanded = new Set(sections.length ? [sections[0].id] : []);
  render();
}

///////////////////////////////////////////////////////////////////////////
//  Function: openForEdit
//  Inputs: record (from Home's list; only its id is trusted)
//  Outputs: Reads the template again, normalizes it, finds its packet, and
//    shows the screen in edit mode. A template that is gone sends the
//    student Home with a short message.
///////////////////////////////////////////////////////////////////////////
async function openForEdit(record) {
  if (!record || typeof record.id !== "string") return;
  const token = ++editor.openToken;
  const user = state.currentUser;

  let fresh;
  try {
    fresh = await getTemplateRecord(record.id);
  } catch (err) {
    console.error("TEMPLATE EDITOR: couldn't read the template:", err);
    if (token !== editor.openToken) return;
    alert("Couldn't open that template. Try again in a moment.");
    goHome();
    return;
  }
  if (token !== editor.openToken || !state.currentUser || state.currentUser !== user) return;

  if (!fresh) {
    alert("That template couldn't be found. It may have been deleted.");
    goHome();
    return;
  }

  const t = ops.normalizeLoadedTemplate(fresh);

  let packetInfo = null;
  try {
    const sources = await listSavedSources("template", record.id);
    const packet = sources.find(s => s.kind === "packet") || null;
    if (packet) {
      packetInfo = {
        name: typeof packet.name === "string" ? packet.name : "Packet",
        pageCount: Number(packet.pageCount) || 0,
        paged: packet.paged === true,
        charCount: Number(packet.charCount) || 0
      };
    }
  } catch (err) {
    console.error("TEMPLATE EDITOR: couldn't read the template's packet:", err);
  }
  if (token !== editor.openToken) return;

  editor.mode = "edit";
  editor.dirty = false;
  editor.saving = false;
  editor.draft = {
    mode: "edit",
    templateId: record.id,
    title: t.title,
    themeId: t.themeId,
    category: t.category,
    answers: t.answers,
    sections: t.sections,
    changes: t.changes,
    notice: "",
    packet: null,
    hasPacket: t.hasPacket || packetInfo !== null,
    packetInfo,
    isCustom: !getDefaultTheme(t.themeId)
  };
  editor.expanded = new Set();

  setState({ currentTemplateId: record.id });
  render();
  showScreen("template-editor");
  if (els.heading) els.heading.focus(); // (SCREEN_CHANGED does it too when the screen changes)
}

///////////////////////////////////////////////////////////////////////////
//  Function: initTemplateEditor
//  Inputs: None
//  Outputs: Wires up Screen C. Call once at startup.
///////////////////////////////////////////////////////////////////////////
function initTemplateEditor() {
  on(EVENTS.TEMPLATE_PREVIEW, showPreview);
  on(EVENTS.OPEN_TEMPLATE, openForEdit);
  on(EVENTS.AUTH_CHANGED, user => { if (!user) resetEditor(); });

  // Keyboard focus can only move into the screen once it is showing.
  on(EVENTS.SCREEN_CHANGED, ({ to }) => {
    if (to === "template-editor" && els.heading) els.heading.focus();
  });

  // Warn about unsaved changes only while this screen is showing.
  window.addEventListener("beforeunload", (e) => {
    if (state.currentScreen === "template-editor" && editor.dirty) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
}

export { initTemplateEditor };