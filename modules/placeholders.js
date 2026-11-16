///////////////////////////////////////////////////////////////////////////
// placeholders.js
//  Stand-in screens so the Home screen's lists can be tested end to end
//  before the real ones exist:
//    - a document placeholder (the editor, built in Phase 5)
//    - a template placeholder (the template editor, built in Phase 4)
//  Each shows a few facts from the record, which makes it easy to check that
//  the right one opened, and has a Home button.
//
//  They listen for the same events the real screens will: OPEN_DOCUMENT and
//  OPEN_TEMPLATE. To replace one, have the new module listen for its event
//  instead and stop calling initPlaceholders() for that screen.
//
//  Oliver Emerson - 2026
///////////////////////////////////////////////////////////////////////////

import { setState, on, emit, EVENTS } from "./state.js";
import { showScreen } from "./router.js";
import { getThemeName } from "./defaultTemplates.js";

const $ = id => document.getElementById(id);

///////////////////////////////////////////////////////////////////////////
//  Function: goHome
//  Inputs: None
//  Outputs: Forgets the open record and asks for the Home screen
///////////////////////////////////////////////////////////////////////////
function goHome() {
  setState({ currentDocId: null, currentTemplateId: null });
  emit(EVENTS.HOME_REQUESTED);
}

///////////////////////////////////////////////////////////////////////////
//  Function: initPlaceholders
//  Inputs: None
//  Outputs: Wires up both placeholder screens. Call once at startup.
///////////////////////////////////////////////////////////////////////////
function initPlaceholders() {
  $("editor-placeholder-home").addEventListener("click", goHome);
  $("template-placeholder-home").addEventListener("click", goHome);

  on(EVENTS.OPEN_DOCUMENT, (record) => {
    setState({ currentDocId: record.id });

    $("editor-placeholder-title").textContent = record.title || "Untitled document";
    $("editor-placeholder-info").textContent = [
      `Document id: ${record.id}`,
      `Stage: ${record.stage || "drafting"}`,
      (record.template && record.template.title) ? `Template: ${record.template.title}` : "No template"
    ].join(" · ");

    showScreen("editor");
  });

  on(EVENTS.OPEN_TEMPLATE, (record) => {
    setState({ currentTemplateId: record.id });

    const sectionCount = Array.isArray(record.sections) ? record.sections.length : 0;
    $("template-placeholder-title").textContent = record.title || "Untitled template";
    $("template-placeholder-info").textContent = [
      `Template id: ${record.id}`,
      `Theme: ${getThemeName(record.themeId)}`,
      `Type: ${record.category || "unknown"}`,
      `${sectionCount} section${sectionCount === 1 ? "" : "s"}`
    ].join(" · ");

    showScreen("template-editor");
  });
}

export { initPlaceholders };