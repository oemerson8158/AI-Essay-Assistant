///////////////////////////////////////////////////////////////////////////
// wizard.js
//  The template wizard, shown in #wizard inside #wizard-screen:
//    Screen A  (questions)  three optional questions about the writing
//    Screen B  (theme)      choose a built-in theme; the DBQ theme also takes
//                           an optional document packet
//    Screen B  (custom)     "Custom Theme": build a template from the
//                           structure of a source the student supplies
//    working                a progress view with a Stop button
//    problem                a failure, with the choices that make sense
//  When the template is ready the wizard hands it to Screen C
//  (templateEditor.js) by emitting TEMPLATE_PREVIEW and showing that screen.
//
//  The wizard's DOM is built once and kept alive. Showing a view only
//  toggles visibility, so typed text and chosen files are still there when
//  the student presses Back, or comes back from Screen C.
//
//  A "run" (personalizing, or reading a source) captures a number. Starting
//  another run, resetting, or signing out changes the number, which makes
//  the old run "stale": its result is ignored and it never touches the page.
//
//  Results of a personalization or a custom build are remembered while
//  nothing has changed, so Back then Next costs no new AI request.
//
//  Untrusted text (file names, messages) only enters the page through
//  textContent.
//
//  Oliver Emerson - 2026
///////////////////////////////////////////////////////////////////////////

import { on, emit, EVENTS } from "./state.js";
import { showScreen } from "./router.js";
import { confirmDialog, closeModal } from "./modal.js";
import { THEME_OPTIONS, DBQ_THEME_ID, buildTemplateFromTheme } from "./defaultTemplates.js";
import {
  extractFile,
  extractPastedText,
  isSupportedFile,
  approxWords,
  ExtractError,
  SOURCE_MAX_CHARS,
  CUSTOM_TEMPLATE_MAX_CHARS
} from "./extract.js";
import { personalizeTemplate, cleanAnswers, hasAnyAnswer, ANSWER_MAX_CHARS } from "./personalize.js";
import { buildCustomTemplate } from "./customTemplate.js";

// The three questions, worded exactly as in the Architecture (6.3).
const QUESTIONS = [
  { key: "about", id: "wz-about", label: "What are you writing about?" },
  {
    key: "prompt",
    id: "wz-prompt",
    label: "Is there a topic or prompt you are responding to? (If so, please write it below)"
  },
  {
    key: "requirements",
    id: "wz-requirements",
    label: "Are there any specific requirements or stipulations your writing must meet? (If so, please write them below)"
  }
];

const CUSTOM_LABEL = "Source material for your custom template to be based on";
const PACKET_HINT =
  "A PDF works best. .docx and .txt files also work. Only the text of the packet is read, so images, maps, and cartoons won't appear in the app.";
const UNSUPPORTED_MESSAGE = "Unsupported file type. Please use a .txt, .pdf, or .docx file.";

///////////////////////////////////////////////////////////////////////////
// State
///////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////
//  Function: freshState
//  Inputs: None
//  Outputs: The wizard's starting state. The selection counters and runId
//    are carried over by resetAll(), so they only ever go up and an old
//    request can never be mistaken for a new one.
///////////////////////////////////////////////////////////////////////////
function freshState() {
  return {
    runId: 0,                 // changes whenever a run starts or is abandoned
    view: "questions",        // which view is showing
    bMode: "default",         // which form of Screen B the student is in: "default" | "custom"
    answers: { about: "", prompt: "", requirements: "" }, // raw, untrimmed
    themeId: "",
    packet: null,             // { extracted, name } for the DBQ theme
    packetSelection: 0,       // counts file choices, so a slow read can't overwrite a newer one
    packetReading: false,
    cancelRequested: false,   // the Stop button
    lastRun: null,            // { key, result } of the last personalization
    custom: { extracted: null, selection: 0, reading: false },
    customBuilt: null,        // { key, template } of the last custom build
    customKey: null,          // the source the build and resume state belong to
    customResume: null,       // { nextSection, groups } after a failed build
    cooldownTimer: null
  };
}

let wizard = freshState();
let ui = {}; // the elements buildDom() makes, by name

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
//  Function: formatCount
//  Inputs: n
//  Outputs: n with thousands separators, such as "1,500"
///////////////////////////////////////////////////////////////////////////
function formatCount(n) {
  return Number(n).toLocaleString("en-US");
}

///////////////////////////////////////////////////////////////////////////
//  Function: copyOf
//  Inputs: value (plain data)
//  Outputs: A deep copy
///////////////////////////////////////////////////////////////////////////
function copyOf(value) {
  return JSON.parse(JSON.stringify(value));
}

///////////////////////////////////////////////////////////////////////////
//  Function: goHome
//  Inputs: None
//  Outputs: Asks for Home's Templates list
///////////////////////////////////////////////////////////////////////////
function goHome() {
  emit(EVENTS.HOME_REQUESTED, { view: "templates" });
}

///////////////////////////////////////////////////////////////////////////
//  Function: bView
//  Inputs: None
//  Outputs: The name of the view for Screen B in the mode the student is in
///////////////////////////////////////////////////////////////////////////
function bView() {
  return wizard.bMode === "custom" ? "custom" : "theme";
}

///////////////////////////////////////////////////////////////////////////
//  Function: newRun
//  Inputs: None
//  Outputs: { isStale, shouldStop, setStatus } for a new run. Starting it
//    makes every earlier run stale.
///////////////////////////////////////////////////////////////////////////
function newRun() {
  const myRun = ++wizard.runId;
  wizard.cancelRequested = false;
  const isStale = () => wizard.runId !== myRun;
  return {
    isStale,
    shouldStop: () => wizard.cancelRequested || isStale(),
    setStatus: text => { if (!isStale() && ui.workStatus) ui.workStatus.textContent = text; }
  };
}

///////////////////////////////////////////////////////////////////////////
// Showing views
///////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////
//  Function: clearCooldown
//  Inputs: None
//  Outputs: Stops the "Try again (wait 23s)" timer, if one is running
///////////////////////////////////////////////////////////////////////////
function clearCooldown() {
  if (wizard.cooldownTimer) {
    clearInterval(wizard.cooldownTimer);
    wizard.cooldownTimer = null;
  }
}

///////////////////////////////////////////////////////////////////////////
//  Function: showView
//  Inputs: name — "questions" | "theme" | "custom" | "working" | "problem"
//  Outputs: Shows that view and hides the others, then moves keyboard focus
//    to its heading
///////////////////////////////////////////////////////////////////////////
function showView(name) {
  clearCooldown();
  wizard.view = name;
  if (name === "theme" || name === "custom") wizard.bMode = name === "custom" ? "custom" : "default";

  Object.entries(ui.views).forEach(([viewName, el]) => { el.hidden = viewName !== name; });

  if (name === "theme") {
    ui.themeSelect.value = wizard.themeId;
    syncPacketBlock();
    syncThemeNext();
  }
  if (name === "custom") syncCustomNext();

  const heading = ui.headings[name];
  if (heading) heading.focus();
}

///////////////////////////////////////////////////////////////////////////
//  Function: showWorking
//  Inputs: headingText
//  Outputs: Shows the progress view with an empty status line and a Stop
//    button that is ready to press
///////////////////////////////////////////////////////////////////////////
function showWorking(headingText) {
  ui.headings.working.textContent = headingText;
  ui.workStatus.textContent = "";
  ui.stopBtn.disabled = false;
  ui.stopBtn.textContent = "Stop";
  showView("working");
}

///////////////////////////////////////////////////////////////////////////
//  Function: showProblem
//  Inputs: { heading, message, buttons }
//      buttons — [{ label, primary, onClick, cooldownSeconds }]; a button
//        with cooldownSeconds is disabled for that long, counting down in
//        its label ("Try again (wait 23s)")
//  Outputs: Shows the problem view
///////////////////////////////////////////////////////////////////////////
function showProblem({ heading, message, buttons }) {
  ui.headings.problem.textContent = heading;
  ui.problemMessage.textContent = message;
  ui.problemButtons.textContent = "";

  const cooling = [];

  buttons.forEach(spec => {
    const btn = h("button", { type: "button", class: spec.primary ? "btn-primary" : "btn-secondary", text: spec.label });
    btn.addEventListener("click", spec.onClick);
    ui.problemButtons.appendChild(btn);

    if (Number.isFinite(spec.cooldownSeconds) && spec.cooldownSeconds > 0) {
      cooling.push({ btn, label: spec.label, remaining: Math.ceil(spec.cooldownSeconds) });
    }
  });

  showView("problem");

  if (cooling.length > 0) {
    const tick = () => {
      let anyLeft = false;
      cooling.forEach(item => {
        if (item.remaining > 0) {
          item.btn.disabled = true;
          item.btn.textContent = `${item.label} (wait ${item.remaining}s)`;
          item.remaining--;
          anyLeft = true;
        } else {
          item.btn.disabled = false;
          item.btn.textContent = item.label;
        }
      });
      if (!anyLeft) clearCooldown();
    };
    tick();
    wizard.cooldownTimer = setInterval(tick, 1000);
  }
}

///////////////////////////////////////////////////////////////////////////
// Building the page
///////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////
//  Function: makeHeader
//  Inputs: text (the heading)
//  Outputs: { row, heading } — a header row with the heading (focusable by
//    code) and the "?" button
///////////////////////////////////////////////////////////////////////////
function makeHeader(text) {
  const heading = h("h2", { class: "wizard-heading", tabindex: "-1", text });
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
  return { row: h("div", { class: "wizard-header" }, heading, helpBtn), heading };
}

///////////////////////////////////////////////////////////////////////////
//  Function: buildQuestionsView
//  Inputs: None
//  Outputs: Screen A: the three questions with live counters, Cancel, Next
///////////////////////////////////////////////////////////////////////////
function buildQuestionsView() {
  const { row, heading } = makeHeader("New template");
  ui.headings.questions = heading;

  const view = h("div", { class: "wizard-card" }, row,
    h("p", { class: "tool-hint", text: "Tell the tool about your writing. Every question is optional." })
  );

  ui.answerInputs = {};
  ui.answerCounters = {};

  QUESTIONS.forEach(q => {
    const textarea = h("textarea", { id: q.id, rows: "4", maxlength: ANSWER_MAX_CHARS });
    const counter = h("p", { class: "char-count", "aria-live": "off" });
    const update = () => {
      counter.textContent = `${formatCount(textarea.value.length)} / ${formatCount(ANSWER_MAX_CHARS)}`;
      counter.classList.toggle("char-count-over", textarea.value.length > ANSWER_MAX_CHARS);
    };
    textarea.addEventListener("input", () => {
      wizard.answers[q.key] = textarea.value;
      update();
    });
    update();

    ui.answerInputs[q.key] = textarea;
    ui.answerCounters[q.key] = { counter, update };
    view.appendChild(h("div", { class: "wizard-field" }, h("label", { for: q.id, text: q.label }), textarea, counter));
  });

  const cancel = h("button", { type: "button", class: "btn-secondary", id: "wz-cancel", text: "Cancel" });
  cancel.addEventListener("click", handleCancel);
  const next = h("button", { type: "button", class: "btn-primary", id: "wz-next-a", text: "Next" });
  next.addEventListener("click", () => showView(bView()));
  view.appendChild(h("div", { class: "wizard-buttons" }, cancel, next));

  return view;
}

///////////////////////////////////////////////////////////////////////////
//  Function: buildThemeView
//  Inputs: None
//  Outputs: Screen B (default mode): the theme select, the DBQ packet block,
//    the Custom Theme button, Back, and Next
///////////////////////////////////////////////////////////////////////////
function buildThemeView() {
  const { row, heading } = makeHeader("Choose a theme");
  ui.headings.theme = heading;

  const select = h("select", { id: "wz-theme" });
  const placeholder = h("option", { value: "", text: "Choose a theme..." });
  placeholder.disabled = true;
  placeholder.selected = true;
  select.appendChild(placeholder);
  THEME_OPTIONS.forEach(({ themeId, name }) => select.appendChild(h("option", { value: themeId, text: name })));
  select.addEventListener("change", () => {
    wizard.themeId = select.value;
    if (wizard.themeId !== DBQ_THEME_ID) clearPacket();
    syncPacketBlock();
    syncThemeNext();
  });
  ui.themeSelect = select;

  // ---- The DBQ packet block ----
  const packetInput = h("input", { type: "file", id: "wz-packet", accept: ".pdf,.docx,.txt" });
  packetInput.addEventListener("change", onPacketChosen);
  ui.packetInput = packetInput;
  ui.packetStatus = h("p", { class: "wizard-status", role: "status" });
  ui.packetSummary = h("div", { class: "wizard-summary" });

  ui.packetBlock = h("div", { class: "wizard-field", id: "wz-packet-block" },
    h("label", { for: "wz-packet", text: "Document packet (optional)" }),
    h("p", { class: "tool-hint", text: PACKET_HINT }),
    packetInput,
    ui.packetStatus,
    ui.packetSummary
  );
  ui.packetBlock.hidden = true;

  const customBtn = h("button", { type: "button", class: "btn-secondary", id: "wz-custom-theme", text: "Custom Theme" });
  customBtn.addEventListener("click", () => showView("custom"));

  const back = h("button", { type: "button", class: "btn-secondary", id: "wz-back-b", text: "Back" });
  back.addEventListener("click", () => showView("questions"));
  ui.themeNext = h("button", { type: "button", class: "btn-primary", id: "wz-next-b", text: "Next" });
  ui.themeNext.addEventListener("click", runDefault);

  return h("div", { class: "wizard-card" }, row,
    h("div", { class: "wizard-field" }, h("label", { for: "wz-theme", text: "Theme" }), select),
    ui.packetBlock,
    h("div", { class: "wizard-buttons wizard-buttons-start" }, customBtn),
    h("div", { class: "wizard-buttons" }, back, ui.themeNext)
  );
}

///////////////////////////////////////////////////////////////////////////
//  Function: buildCustomView
//  Inputs: None
//  Outputs: Screen B (custom mode): a paste box with a counter, a file
//    input, the way back to the default themes, Back, and Next
///////////////////////////////////////////////////////////////////////////
function buildCustomView() {
  const { row, heading } = makeHeader("Custom theme");
  ui.headings.custom = heading;

  const useDefault = h("button", { type: "button", class: "wizard-link", id: "wz-use-default", text: "Use a default theme instead" });
  useDefault.addEventListener("click", () => showView("theme"));

  ui.customText = h("textarea", { id: "wz-custom-text", rows: "10" });
  ui.customCounter = h("p", { class: "char-count" });
  ui.customText.addEventListener("input", syncCustomNext);

  ui.customFile = h("input", { type: "file", id: "wz-custom-file", accept: ".txt,.pdf,.docx" });
  ui.customFile.addEventListener("change", onCustomFileChosen);
  ui.customStatus = h("p", { class: "wizard-status", role: "status" });
  ui.customSummary = h("div", { class: "wizard-summary" });

  const back = h("button", { type: "button", class: "btn-secondary", id: "wz-back-c", text: "Back" });
  back.addEventListener("click", () => showView("questions"));
  ui.customNext = h("button", { type: "button", class: "btn-primary", id: "wz-next-c", text: "Next" });
  ui.customNext.addEventListener("click", runCustom);

  return h("div", { class: "wizard-card" }, row, useDefault,
    h("div", { class: "wizard-field" },
      h("label", { for: "wz-custom-text", text: CUSTOM_LABEL }),
      ui.customText,
      ui.customCounter
    ),
    h("div", { class: "wizard-field" },
      h("label", { for: "wz-custom-file", text: "Or upload a .txt, .pdf, or .docx file:" }),
      ui.customFile,
      ui.customStatus,
      ui.customSummary
    ),
    h("div", { class: "wizard-buttons" }, back, ui.customNext)
  );
}

///////////////////////////////////////////////////////////////////////////
//  Function: buildWorkingView
//  Inputs: None
//  Outputs: The progress view: a heading, a status line, and Stop
///////////////////////////////////////////////////////////////////////////
function buildWorkingView() {
  const { row, heading } = makeHeader("Working...");
  ui.headings.working = heading;

  ui.workStatus = h("p", { class: "wizard-status", role: "status", "aria-live": "polite" });
  ui.stopBtn = h("button", { type: "button", class: "btn-secondary", id: "wz-stop", text: "Stop" });
  ui.stopBtn.addEventListener("click", () => {
    wizard.cancelRequested = true;
    ui.stopBtn.disabled = true;
    ui.stopBtn.textContent = "Stopping...";
  });

  return h("div", { class: "wizard-card" }, row, ui.workStatus, h("div", { class: "wizard-buttons wizard-buttons-start" }, ui.stopBtn));
}

///////////////////////////////////////////////////////////////////////////
//  Function: buildProblemView
//  Inputs: None
//  Outputs: The problem view: a heading, a red message, and a row of buttons
///////////////////////////////////////////////////////////////////////////
function buildProblemView() {
  const { row, heading } = makeHeader("Something went wrong");
  ui.headings.problem = heading;

  ui.problemMessage = h("p", { class: "wizard-problem", role: "alert" });
  ui.problemButtons = h("div", { class: "wizard-buttons wizard-buttons-start" });

  return h("div", { class: "wizard-card" }, row, ui.problemMessage, ui.problemButtons);
}

///////////////////////////////////////////////////////////////////////////
//  Function: buildDom
//  Inputs: root (the #wizard element)
//  Outputs: Builds every view into root, all hidden except Screen A
///////////////////////////////////////////////////////////////////////////
function buildDom(root) {
  ui = { headings: {}, views: {} };
  root.textContent = "";

  ui.views.questions = buildQuestionsView();
  ui.views.theme = buildThemeView();
  ui.views.custom = buildCustomView();
  ui.views.working = buildWorkingView();
  ui.views.problem = buildProblemView();

  Object.values(ui.views).forEach(view => { view.hidden = true; root.appendChild(view); });
  ui.views.questions.hidden = false;
  syncCustomNext();
}

///////////////////////////////////////////////////////////////////////////
//  Function: resetAll
//  Inputs: None
//  Outputs: Forgets everything the student did, empties every box, and
//    makes any run still going stale
///////////////////////////////////////////////////////////////////////////
function resetAll() {
  clearCooldown();
  const carried = {
    runId: wizard.runId + 1,
    packetSelection: wizard.packetSelection + 1,
    customSelection: wizard.custom.selection + 1
  };
  wizard = freshState();
  wizard.runId = carried.runId;
  wizard.packetSelection = carried.packetSelection;
  wizard.custom.selection = carried.customSelection;

  if (!ui.views) return;

  QUESTIONS.forEach(q => {
    ui.answerInputs[q.key].value = "";
    ui.answerCounters[q.key].update();
  });
  ui.themeSelect.value = "";
  ui.packetInput.value = "";
  ui.packetStatus.textContent = "";
  ui.packetStatus.classList.remove("wizard-error");
  ui.packetSummary.textContent = "";
  ui.packetBlock.hidden = true;
  ui.customText.value = "";
  ui.customText.disabled = false;
  ui.customFile.value = "";
  ui.customStatus.textContent = "";
  ui.customStatus.classList.remove("wizard-error");
  ui.customSummary.textContent = "";
  ui.workStatus.textContent = "";
  ui.problemMessage.textContent = "";
  ui.problemButtons.textContent = "";
  syncCustomNext();
  syncThemeNext();
}

///////////////////////////////////////////////////////////////////////////
// Screen A
///////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////
//  Function: handleCancel
//  Inputs: None
//  Outputs: Goes Home. If any question has text in it, asks first whether to
//    discard the template.
///////////////////////////////////////////////////////////////////////////
async function handleCancel() {
  const hasText = Object.values(wizard.answers).some(v => v.trim().length > 0);

  if (hasText) {
    const discard = await confirmDialog({
      title: "Discard this template?",
      message: "Nothing has been saved yet.",
      confirmLabel: "Discard",
      danger: true
    });
    if (!discard) return;
  }
  goHome();
}

///////////////////////////////////////////////////////////////////////////
// Screen B: default themes and the DBQ packet
///////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////
//  Function: syncThemeNext
//  Inputs: None
//  Outputs: Next is off until a theme is chosen, and while a packet is being
//    read
///////////////////////////////////////////////////////////////////////////
function syncThemeNext() {
  if (!ui.themeNext) return;
  ui.themeNext.disabled = !wizard.themeId || wizard.packetReading;
}

///////////////////////////////////////////////////////////////////////////
//  Function: syncPacketBlock
//  Inputs: None
//  Outputs: Shows the packet block only for the DBQ theme
///////////////////////////////////////////////////////////////////////////
function syncPacketBlock() {
  ui.packetBlock.hidden = wizard.themeId !== DBQ_THEME_ID;
}

///////////////////////////////////////////////////////////////////////////
//  Function: describeExtracted
//  Inputs: extracted (from extract.js)
//  Outputs: "12 pages · about 4,200 words", or just the words for a file with
//    no pages
///////////////////////////////////////////////////////////////////////////
function describeExtracted(extracted) {
  const words = `about ${formatCount(approxWords(extracted.charCount))} words`;
  if (extracted.paged === false) return words;
  const pages = `${extracted.pageCount} page${extracted.pageCount === 1 ? "" : "s"}`;
  return `${pages} \u00b7 ${words}`;
}

///////////////////////////////////////////////////////////////////////////
//  Function: warningNodes
//  Inputs: extracted
//  Outputs: One warning paragraph per entry of extracted.warnings
///////////////////////////////////////////////////////////////////////////
function warningNodes(extracted) {
  return (Array.isArray(extracted.warnings) ? extracted.warnings : [])
    .map(text => h("p", { class: "wizard-warning", text: String(text) }));
}

///////////////////////////////////////////////////////////////////////////
//  Function: renderPacketSummary
//  Inputs: None
//  Outputs: Shows the chosen packet (name, pages, words, warnings, and a
//    Remove button), or nothing if there isn't one
///////////////////////////////////////////////////////////////////////////
function renderPacketSummary() {
  ui.packetSummary.textContent = "";
  if (!wizard.packet) return;

  const { extracted, name } = wizard.packet;
  const remove = h("button", { type: "button", class: "btn-secondary", id: "wz-packet-remove", text: "Remove" });
  remove.addEventListener("click", () => { clearPacket(); syncThemeNext(); });

  ui.packetSummary.append(
    h("div", { class: "wizard-file-line" }, h("span", { text: `Packet: ${name} \u00b7 ${describeExtracted(extracted)}` }), remove),
    ...warningNodes(extracted)
  );
}

///////////////////////////////////////////////////////////////////////////
//  Function: clearPacket
//  Inputs: None
//  Outputs: Forgets the packet and empties the file box. A read still in
//    progress is made stale, so it can't bring the packet back.
///////////////////////////////////////////////////////////////////////////
function clearPacket() {
  wizard.packetSelection++;
  wizard.packet = null;
  wizard.packetReading = false;
  ui.packetInput.value = "";
  ui.packetStatus.textContent = "";
  ui.packetStatus.classList.remove("wizard-error");
  ui.packetSummary.textContent = "";
}

///////////////////////////////////////////////////////////////////////////
//  Function: onPacketChosen
//  Inputs: None (reads the file input)
//  Outputs: Reads the chosen file and keeps its text as the packet. A second
//    choice replaces the first; a slow earlier read can never overwrite a
//    later one.
///////////////////////////////////////////////////////////////////////////
async function onPacketChosen() {
  const file = ui.packetInput.files && ui.packetInput.files[0];
  if (!file) return;

  const selection = ++wizard.packetSelection;
  const current = () => selection === wizard.packetSelection && wizard.themeId === DBQ_THEME_ID;

  wizard.packet = null;
  ui.packetSummary.textContent = "";
  ui.packetStatus.classList.remove("wizard-error");

  if (!isSupportedFile(file)) {
    ui.packetStatus.textContent = UNSUPPORTED_MESSAGE;
    ui.packetStatus.classList.add("wizard-error");
    ui.packetInput.value = "";
    wizard.packetReading = false;
    syncThemeNext();
    return;
  }

  wizard.packetReading = true;
  ui.packetStatus.textContent = "Reading file...";
  syncThemeNext();

  let extracted;
  try {
    extracted = await extractFile(file, {
      maxChars: SOURCE_MAX_CHARS,
      onProgress: ({ done, total }) => {
        if (current()) ui.packetStatus.textContent = `Reading page ${done} of ${total}...`;
      },
      shouldStop: () => !current()
    });
  } catch (err) {
    if (!current()) return;
    wizard.packetReading = false;
    ui.packetInput.value = "";
    ui.packetStatus.classList.add("wizard-error");
    if (err instanceof ExtractError) {
      ui.packetStatus.textContent = err.message;
    } else {
      console.error("WIZARD: couldn't read the packet:", err);
      ui.packetStatus.textContent = "Couldn't read that file.";
    }
    syncThemeNext();
    return;
  }
  if (!current()) return;

  wizard.packet = { extracted, name: file.name };
  wizard.packetReading = false;
  ui.packetStatus.textContent = "";
  renderPacketSummary();
  syncThemeNext();
}

///////////////////////////////////////////////////////////////////////////
// Handing a result to Screen C
///////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////
//  Function: previewDraft
//  Inputs: draft
//  Outputs: Sends the draft to Screen C and shows that screen
///////////////////////////////////////////////////////////////////////////
function previewDraft(draft) {
  emit(EVENTS.TEMPLATE_PREVIEW, draft);
  showScreen("template-editor");
}

///////////////////////////////////////////////////////////////////////////
//  Function: unchangedResult
//  Inputs: sections
//  Outputs: A personalization result holding an untouched copy of the
//    sections, as if nothing had been personalized
///////////////////////////////////////////////////////////////////////////
function unchangedResult(sections) {
  return { ok: true, sections: copyOf(sections), changes: [], personalized: false, promptsRewritten: 0, skipped: true };
}

///////////////////////////////////////////////////////////////////////////
//  Function: noticeFor
//  Inputs: result (a personalization result)
//  Outputs: The message to show on Screen C: only a fallback has one
///////////////////////////////////////////////////////////////////////////
function noticeFor(result) {
  return result.fallback === true && typeof result.message === "string" ? result.message : "";
}

///////////////////////////////////////////////////////////////////////////
//  Function: finishDefault
//  Inputs: base (the theme's template), result (ok personalization result)
//  Outputs: Builds the draft for a default theme and shows Screen C
///////////////////////////////////////////////////////////////////////////
function finishDefault(base, result) {
  const packet = wizard.themeId === DBQ_THEME_ID ? wizard.packet : null;

  previewDraft({
    mode: "new",
    templateId: null,
    title: base.title,
    themeId: base.themeId,
    category: base.category,
    answers: cleanAnswers(wizard.answers),
    sections: copyOf(result.sections),
    changes: copyOf(result.changes || []),
    notice: noticeFor(result),
    packet,
    hasPacket: false,
    packetInfo: packet
      ? { name: packet.name, pageCount: packet.extracted.pageCount, paged: packet.extracted.paged, charCount: packet.extracted.charCount }
      : null,
    isCustom: false
  });
}

///////////////////////////////////////////////////////////////////////////
//  Function: finishCustom
//  Inputs: template ({ category, sections }), result (ok personalization
//    result)
//  Outputs: Builds the draft for a custom template and shows Screen C, which
//    shows the Template type dropdown for it
///////////////////////////////////////////////////////////////////////////
function finishCustom(template, result) {
  previewDraft({
    mode: "new",
    templateId: null,
    title: "Custom template",
    themeId: "custom",
    category: template.category,
    answers: cleanAnswers(wizard.answers),
    sections: copyOf(result.sections),
    changes: copyOf(result.changes || []),
    notice: noticeFor(result),
    packet: null,
    hasPacket: false,
    packetInfo: null,
    isCustom: true
  });
}

///////////////////////////////////////////////////////////////////////////
// Running the default-theme path
///////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////
//  Function: runDefault
//  Inputs: None
//  Outputs: Personalizes the chosen theme with the student's answers and
//    shows Screen C. Reuses the last result if nothing has changed, shows
//    the progress view only when the AI is actually needed, and handles
//    Stop and failures.
///////////////////////////////////////////////////////////////////////////
async function runDefault() {
  if (!wizard.themeId || wizard.packetReading) return;

  const base = buildTemplateFromTheme(wizard.themeId);
  if (!base) return;

  const cleaned = cleanAnswers(wizard.answers);
  const key = JSON.stringify([wizard.themeId, cleaned, wizard.packet ? wizard.packet.name : null]);

  if (wizard.lastRun && wizard.lastRun.key === key) {
    finishDefault(base, wizard.lastRun.result);
    return;
  }

  // Nothing to personalize with: no AI request, and no progress view.
  if (!hasAnyAnswer(cleaned)) {
    const result = unchangedResult(base.sections);
    wizard.lastRun = { key, result };
    finishDefault(base, result);
    return;
  }

  const run = newRun();
  showWorking("Personalizing your template...");

  const result = await personalizeTemplate({
    sections: base.sections,
    answers: wizard.answers,
    isStale: run.isStale,
    shouldStop: run.shouldStop,
    setStatus: run.setStatus
  });
  if (run.isStale()) return;

  if (result.cancelled) {
    showView(bView());
    return;
  }

  if (!result.ok) {
    showProblem({
      heading: "Couldn't personalize the template",
      message: result.message || "Couldn't personalize the template right now. Try again in a moment.",
      buttons: [
        { label: "Try again", primary: true, onClick: runDefault },
        { label: "Use the standard template", onClick: () => finishDefault(base, unchangedResult(base.sections)) },
        { label: "Back", onClick: () => showView(bView()) }
      ]
    });
    return;
  }

  wizard.lastRun = { key, result };
  finishDefault(base, result);
}

///////////////////////////////////////////////////////////////////////////
// Screen B: custom mode
///////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////
//  Function: syncCustomNext
//  Inputs: None
//  Outputs: Updates the counter, and turns Next off when there is no file and
//    the pasted text is empty or over 60,000 characters, or while a file is
//    being read
///////////////////////////////////////////////////////////////////////////
function syncCustomNext() {
  if (!ui.customText) return;

  const length = ui.customText.value.trim().length;
  ui.customCounter.textContent = `${formatCount(length)} / ${formatCount(CUSTOM_TEMPLATE_MAX_CHARS)} characters`;
  ui.customCounter.classList.toggle("char-count-over", length > CUSTOM_TEMPLATE_MAX_CHARS);

  const hasFile = !!wizard.custom.extracted;
  ui.customNext.disabled =
    wizard.custom.reading || (!hasFile && (length === 0 || length > CUSTOM_TEMPLATE_MAX_CHARS));
}

///////////////////////////////////////////////////////////////////////////
//  Function: removeCustomFile
//  Inputs: None
//  Outputs: Forgets the file and lets the student paste text again
///////////////////////////////////////////////////////////////////////////
function removeCustomFile() {
  wizard.custom.selection++;
  wizard.custom.extracted = null;
  wizard.custom.reading = false;
  ui.customFile.value = "";
  ui.customText.disabled = false;
  ui.customStatus.textContent = "";
  ui.customStatus.classList.remove("wizard-error");
  ui.customSummary.textContent = "";
  syncCustomNext();
}

///////////////////////////////////////////////////////////////////////////
//  Function: onCustomFileChosen
//  Inputs: None (reads the file input)
//  Outputs: Reads the chosen file. A file takes precedence over pasted text:
//    the paste box is turned off until the file is removed.
///////////////////////////////////////////////////////////////////////////
async function onCustomFileChosen() {
  const file = ui.customFile.files && ui.customFile.files[0];
  if (!file) return;

  const selection = ++wizard.custom.selection;
  const current = () => selection === wizard.custom.selection;

  wizard.custom.extracted = null;
  ui.customText.disabled = false;
  ui.customSummary.textContent = "";
  ui.customStatus.classList.remove("wizard-error");

  if (!isSupportedFile(file)) {
    ui.customStatus.textContent = UNSUPPORTED_MESSAGE;
    ui.customStatus.classList.add("wizard-error");
    ui.customFile.value = "";
    wizard.custom.reading = false;
    syncCustomNext();
    return;
  }

  wizard.custom.reading = true;
  ui.customStatus.textContent = "Reading file...";
  syncCustomNext();

  let extracted;
  try {
    extracted = await extractFile(file, {
      maxChars: CUSTOM_TEMPLATE_MAX_CHARS,
      onProgress: ({ done, total }) => {
        if (current()) ui.customStatus.textContent = `Reading page ${done} of ${total}...`;
      },
      shouldStop: () => !current()
    });
  } catch (err) {
    if (!current()) return;
    wizard.custom.reading = false;
    ui.customFile.value = "";
    ui.customStatus.classList.add("wizard-error");
    if (err instanceof ExtractError) {
      ui.customStatus.textContent = err.message;
    } else {
      console.error("WIZARD: couldn't read the source file:", err);
      ui.customStatus.textContent = "Couldn't read that file.";
    }
    syncCustomNext();
    return;
  }
  if (!current()) return;

  wizard.custom.extracted = extracted;
  wizard.custom.reading = false;
  ui.customText.disabled = true;
  ui.customStatus.textContent = "";

  const words = `about ${formatCount(approxWords(extracted.charCount))} words`;
  const detail = extracted.paged === false
    ? words
    : `${extracted.pageCount} page${extracted.pageCount === 1 ? "" : "s"}, ${words}`;
  const remove = h("button", { type: "button", class: "btn-secondary", id: "wz-custom-remove", text: "Remove file" });
  remove.addEventListener("click", removeCustomFile);

  ui.customSummary.append(
    h("div", { class: "wizard-file-line" }, h("span", { text: `Using ${file.name} (${detail})` }), remove),
    ...warningNodes(extracted)
  );
  syncCustomNext();
}

///////////////////////////////////////////////////////////////////////////
//  Function: customSourceKey
//  Inputs: extracted
//  Outputs: A string that changes when the source changes: its name, its
//    length, and the start of its text
///////////////////////////////////////////////////////////////////////////
function customSourceKey(extracted) {
  const firstPage = extracted.pages && extracted.pages[0] ? String(extracted.pages[0].text || "") : "";
  return `${extracted.name}:${extracted.charCount}:${firstPage.slice(0, 200)}`;
}

///////////////////////////////////////////////////////////////////////////
//  Function: runCustom
//  Inputs: None
//  Outputs: Reads the source (a file, or the pasted text), builds the
//    template from its structure, then personalizes it. Completed reading
//    work is kept if something fails, so Try again carries on from where it
//    stopped; Stop means start over.
///////////////////////////////////////////////////////////////////////////
async function runCustom() {
  if (wizard.custom.reading) return;

  let extracted = wizard.custom.extracted;
  if (!extracted) {
    try {
      extracted = extractPastedText(ui.customText.value, { maxChars: CUSTOM_TEMPLATE_MAX_CHARS, name: "Pasted text" });
    } catch (err) {
      ui.customStatus.classList.add("wizard-error");
      ui.customStatus.textContent = err instanceof ExtractError ? err.message : "Couldn't read that text.";
      if (!(err instanceof ExtractError)) console.error("WIZARD: couldn't read the pasted text:", err);
      return;
    }
  }
  ui.customStatus.textContent = "";
  ui.customStatus.classList.remove("wizard-error");

  const key = customSourceKey(extracted);
  if (wizard.customKey !== key) {
    wizard.customKey = key;
    wizard.customResume = null;
    wizard.customBuilt = null;
  }

  // The same source as last time: no need to build it again.
  if (wizard.customBuilt && wizard.customBuilt.key === key) {
    await personalizeCustom(wizard.customBuilt.template, key);
    return;
  }

  const run = newRun();
  showWorking("Reading your source...");

  const built = await buildCustomTemplate({
    extracted,
    resume: wizard.customResume,
    isStale: run.isStale,
    shouldStop: run.shouldStop,
    setStatus: run.setStatus,
    onProgress: () => {}
  });
  if (run.isStale()) return;

  if (built.cancelled) {
    wizard.customResume = null; // Stop means start over
    showView("custom");
    return;
  }

  if (!built.ok) {
    wizard.customResume = built.resume || null;
    showProblem({
      heading: "Couldn't build your template",
      message: built.message,
      buttons: [
        { label: "Try again", primary: true, onClick: runCustom, cooldownSeconds: built.retryAfterSeconds },
        { label: "Back", onClick: () => showView("custom") }
      ]
    });
    return;
  }

  wizard.customBuilt = { key, template: built.template };
  wizard.customResume = null;
  await personalizeCustom(built.template, key);
}

///////////////////////////////////////////////////////////////////////////
//  Function: personalizeCustom
//  Inputs: template ({ category, sections }), key (the source's key)
//  Outputs: Personalizes the built template with the student's answers and
//    shows Screen C. Like the default path, it reuses the last result when
//    nothing has changed.
///////////////////////////////////////////////////////////////////////////
async function personalizeCustom(template, key) {
  const cleaned = cleanAnswers(wizard.answers);
  const runKey = JSON.stringify(["custom", key, cleaned]);

  if (wizard.lastRun && wizard.lastRun.key === runKey) {
    finishCustom(template, wizard.lastRun.result);
    return;
  }

  if (!hasAnyAnswer(cleaned)) {
    const result = unchangedResult(template.sections);
    wizard.lastRun = { key: runKey, result };
    finishCustom(template, result);
    return;
  }

  const run = newRun();
  showWorking("Personalizing your template...");

  const result = await personalizeTemplate({
    sections: template.sections,
    answers: wizard.answers,
    isStale: run.isStale,
    shouldStop: run.shouldStop,
    setStatus: run.setStatus
  });
  if (run.isStale()) return;

  if (result.cancelled) {
    showView("custom");
    return;
  }

  if (!result.ok) {
    showProblem({
      heading: "Couldn't personalize the template",
      message: result.message || "Couldn't personalize the template right now. Try again in a moment.",
      buttons: [
        { label: "Try again", primary: true, onClick: () => personalizeCustom(template, key) },
        { label: "Use the template as built", onClick: () => finishCustom(template, unchangedResult(template.sections)) },
        { label: "Back", onClick: () => showView("custom") }
      ]
    });
    return;
  }

  wizard.lastRun = { key: runKey, result };
  finishCustom(template, result);
}

///////////////////////////////////////////////////////////////////////////
//  Function: initWizard
//  Inputs: None
//  Outputs: Builds the wizard into #wizard and starts listening for events.
//    Call once at startup.
///////////////////////////////////////////////////////////////////////////
function initWizard() {
  const root = document.getElementById("wizard");
  if (!root) throw new Error("#wizard is missing from index.html");

  buildDom(root);

  // Home asks for a fresh wizard.
  // (The screen is shown before the view, because a browser won't move
  // keyboard focus into something that is still hidden.)
  on(EVENTS.WIZARD_REQUESTED, () => {
    resetAll();
    showScreen("wizard");
    showView("questions");
  });

  // Screen C's Back: show Screen B again, in the mode the student was in.
  on(EVENTS.WIZARD_RESUME, () => {
    showScreen("wizard");
    showView(bView());
  });

  // Someone signed out: forget everything and make any run in progress stale.
  on(EVENTS.AUTH_CHANGED, user => {
    if (!user) {
      resetAll();
      closeModal();
      showView("questions");
    }
  });
}

export { initWizard };