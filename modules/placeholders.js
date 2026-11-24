///////////////////////////////////////////////////////////////////////////
// placeholders.js
//  A stand-in screen so the Home screen's document list can be tested end to
//  end before the real editor exists (built in Phase 5). It shows a few
//  facts from the record, which makes it easy to check that the right
//  document opened, and has a Home button.
//
//  It listens for the same event the real screen will: OPEN_DOCUMENT. To
//  replace it in Phase 5, delete this file, remove its import and the
//  initPlaceholders() call from app.js, remove the editor-placeholder-*
//  block from index.html, and remove the .placeholder-card styles.
//
//  (The template half of this file was replaced in Phase 4 by
//  templateEditor.js.)
//
//  Oliver Emerson - 2026
///////////////////////////////////////////////////////////////////////////

import { setState, on, emit, EVENTS } from "./state.js";
import { showScreen } from "./router.js";

const $ = id => document.getElementById(id);

///////////////////////////////////////////////////////////////////////////
//  Function: goHome
//  Inputs: None
//  Outputs: Forgets the open document and asks for the Home screen
///////////////////////////////////////////////////////////////////////////
function goHome() {
  setState({ currentDocId: null });
  emit(EVENTS.HOME_REQUESTED, { view: "documents" });
}

///////////////////////////////////////////////////////////////////////////
//  Function: initPlaceholders
//  Inputs: None
//  Outputs: Wires up the document placeholder screen. Call once at startup.
///////////////////////////////////////////////////////////////////////////
function initPlaceholders() {
  $("editor-placeholder-home").addEventListener("click", goHome);

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
}

export { initPlaceholders };