///////////////////////////////////////////////////////////////////////////
// home.js
//  The home screen: a Templates / Documents toggle, the student's list for
//  the chosen view, and a three-dot menu on each row (Rename, Make a copy,
//  Delete, plus Edit for templates). The row, menu, and inline-rename code is
//  adapted from the AI Document Reader's home screen.
//
//  The two views share one set of functions. VIEWS (below) describes how
//  each one differs: which Firestore helpers to call, what a row's second
//  line says, and what a copy contains.
//
//  This module doesn't open the editors. Clicking a row (or Edit, or a new
//  document) emits OPEN_DOCUMENT or OPEN_TEMPLATE on the event bus, and
//  whichever module handles that screen listens (templateEditor.js for
//  templates; placeholders.js for documents until Phase 5). Create Template
//  emits WIZARD_REQUESTED, which wizard.js answers.
//
//  Oliver Emerson - 2026
///////////////////////////////////////////////////////////////////////////

import { state, setState, on, emit, EVENTS } from "./state.js";
import { closeModal, confirmDialog } from "./modal.js";
import {
  signOutUser,
  listUserTemplates,
  getTemplateRecord,
  createTemplateRecord,
  saveTemplateRecord,
  renameTemplateRecord,
  deleteTemplateRecord,
  listUserDocuments,
  getDocumentRecord,
  createDocumentRecord,
  renameDocumentRecord,
  deleteDocumentRecord
} from "./firebase.js";
import { copyAllSources } from "./sourceStore.js";
import { getThemeName } from "./defaultTemplates.js";

const VIEW_STORAGE_KEY = "essayAssistant.homeView";
const MAX_TITLE_LENGTH = 120;

const STAGE_LABELS = { drafting: "Drafting", tabs: "Tabs", revision: "Revision" };

///////////////////////////////////////////////////////////////////////////
//  Function: formatRelativeTime
//  Inputs: timestamp (a Firestore Timestamp)
//  Outputs: Text like "5 minutes ago"; a date after 30 days; "" if missing
///////////////////////////////////////////////////////////////////////////
function formatRelativeTime(timestamp) {
  if (!timestamp || typeof timestamp.toDate !== "function") return "";
  const date = timestamp.toDate();
  const diffMs = Date.now() - date.getTime();
  const diffMins = Math.round(diffMs / 60000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins} minute${diffMins === 1 ? "" : "s"} ago`;
  const diffHours = Math.round(diffMins / 60);
  if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? "" : "s"} ago`;
  const diffDays = Math.round(diffHours / 24);
  if (diffDays < 30) return `${diffDays} day${diffDays === 1 ? "" : "s"} ago`;
  return date.toLocaleDateString();
}

///////////////////////////////////////////////////////////////////////////
//  Function: editedText
//  Inputs: record
//  Outputs: "Edited 5 minutes ago", or "" if the time isn't known yet
///////////////////////////////////////////////////////////////////////////
function editedText(record) {
  const when = formatRelativeTime(record.updatedAt);
  return when ? `Edited ${when}` : "";
}

///////////////////////////////////////////////////////////////////////////
// The two views
//  noun/untitled — wording; list/get/create/rename/remove — the firebase.js
//  helpers; meta(record) — the row's second line; copyData(record) — the
//  fields a copy starts with (never ownerId, timestamps, or revision, which
//  the create helpers set); openEvent — what clicking a row emits;
//  afterCreate(fresh, newId) — optional: runs after a copy's record exists, to
//  copy what is stored beside it (sources). If it throws, the half-made copy
//  is deleted.
//
//  A template's DBQ packet is copied by afterCreate. A document's sources
//  (and their vectors) will be copied the same way in Phase 7.
///////////////////////////////////////////////////////////////////////////

const VIEWS = {
  templates: {
    noun: "template",
    untitled: "Untitled template",
    createLabel: "Create Template",
    emptyText: 'You don\'t have any templates yet. Click "Create Template" to make one.',
    list: listUserTemplates,
    get: getTemplateRecord,
    create: createTemplateRecord,
    rename: renameTemplateRecord,
    remove: deleteTemplateRecord,
    openEvent: EVENTS.OPEN_TEMPLATE,
    hasEdit: true,
    meta: record => [getThemeName(record.themeId), editedText(record)].filter(Boolean).join(" · "),
    copyData: record => ({
      themeId: record.themeId || "custom",
      category: record.category || "argumentative",
      answers: record.answers || { about: "", prompt: "", requirements: "" },
      sections: record.sections || [],
      changes: record.changes || [],
      hasPacket: false // set to true by afterCreate once the packet has been copied
    }),
    afterCreate: async (fresh, newId) => {
      if (fresh.hasPacket !== true) return;
      await copyAllSources("template", fresh.id, "template", newId);
      await saveTemplateRecord(newId, { hasPacket: true });
    },
    deleteNote: "Documents you already made from it keep their own copy."
  },
  documents: {
    noun: "document",
    untitled: "Untitled document",
    createLabel: "Create Document",
    emptyText: 'You don\'t have any documents yet. Click "Create Document" to start writing.',
    list: listUserDocuments,
    get: getDocumentRecord,
    create: createDocumentRecord,
    rename: renameDocumentRecord,
    remove: deleteDocumentRecord,
    openEvent: EVENTS.OPEN_DOCUMENT,
    hasEdit: false,
    meta: record => [
      (record.template && record.template.title) || "No template",
      STAGE_LABELS[record.stage] || STAGE_LABELS.drafting,
      editedText(record)
    ].filter(Boolean).join(" · "),
    copyData: record => ({
      stage: record.stage || "drafting",
      mainHtml: record.mainHtml || "",
      template: record.template || null,
      outlineAnswers: record.outlineAnswers || {},
      tabs: record.tabs || [],
      format: record.format || undefined
    }),
    afterCreate: async () => {}, // Phase 7 copies a document's sources here
    deleteNote: ""
  }
};

// Which view is showing, the lists already fetched (null = fetch again), and
// a counter per view so a slow answer for an old request is ignored.
let currentView = readSavedView();
const cache = { templates: null, documents: null };
const loadTokens = { templates: 0, documents: 0 };

// The floating row menu, if open.
let menuEl = null;

const $ = id => document.getElementById(id);

///////////////////////////////////////////////////////////////////////////
//  Function: readSavedView / saveView
//  Summary: The chosen view is remembered per device. Storage can be
//    blocked (private browsing), so both are wrapped in try/catch.
///////////////////////////////////////////////////////////////////////////
function readSavedView() {
  try {
    const saved = localStorage.getItem(VIEW_STORAGE_KEY);
    return saved === "templates" || saved === "documents" ? saved : "documents";
  } catch {
    return "documents";
  }
}

function saveView(name) {
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, name);
  } catch {
    // Not remembering the view is harmless.
  }
}

///////////////////////////////////////////////////////////////////////////
//  Function: hintParagraph
//  Inputs: text, isError (boolean)
//  Outputs: A <p class="tool-hint"> element (red when isError)
///////////////////////////////////////////////////////////////////////////
function hintParagraph(text, isError = false) {
  const p = document.createElement("p");
  p.className = "tool-hint" + (isError ? " home-error" : "");
  p.textContent = text;
  return p;
}

///////////////////////////////////////////////////////////////////////////
// Showing a view
///////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////
//  Function: syncChrome
//  Inputs: None
//  Outputs: Updates the toggle buttons and the Create button to match
//    currentView
///////////////////////////////////////////////////////////////////////////
function syncChrome() {
  [["templates", "home-view-templates"], ["documents", "home-view-documents"]].forEach(([name, id]) => {
    const btn = $(id);
    btn.classList.toggle("view-toggle-active", name === currentView);
    btn.setAttribute("aria-pressed", String(name === currentView));
  });
  $("home-create").textContent = VIEWS[currentView].createLabel;
}

///////////////////////////////////////////////////////////////////////////
//  Function: showView
//  Inputs: name ("templates" | "documents")
//  Outputs: Switches to that view, showing its cached list or fetching it
///////////////////////////////////////////////////////////////////////////
function showView(name) {
  currentView = name;
  saveView(name);
  closeMenu();
  syncChrome();

  if (cache[name]) {
    renderList(name);
  } else {
    loadList(name);
  }
}

///////////////////////////////////////////////////////////////////////////
//  Function: loadList
//  Inputs: name
//  Outputs: Fetches that view's list from Firestore and shows it if it is
//    still the view on screen
//  Summary: Ignores the answer if a newer request has started, or the
//    student signed out or changed, while it was loading. A missing
//    Firestore index (the first time each list runs) gets a plain
//    explanation instead of a generic failure.
///////////////////////////////////////////////////////////////////////////
async function loadList(name) {
  const user = state.currentUser;
  if (!user) return;

  const token = ++loadTokens[name];
  const listEl = $("home-list");
  listEl.innerHTML = "";
  listEl.appendChild(hintParagraph(`Loading your ${name}...`));

  let records;
  try {
    records = await VIEWS[name].list(user.uid);
  } catch (err) {
    console.error(`HOME: failed to load ${name}:`, err);
    if (token !== loadTokens[name] || currentView !== name) return;

    listEl.innerHTML = "";
    listEl.appendChild(hintParagraph(
      err && err.code === "failed-precondition"
        ? `Your ${name} list needs a one-time database setup. Open the browser console (F12), click the link in the red error message, wait a minute for the index to build, then refresh.`
        : `Couldn't load your ${name} right now. Try refreshing.`,
      true
    ));
    return;
  }

  const stillSameUser = state.currentUser && state.currentUser.uid === user.uid;
  if (token !== loadTokens[name] || !stillSameUser) return;

  cache[name] = records;
  if (currentView === name) renderList(name);
}

///////////////////////////////////////////////////////////////////////////
//  Function: renderList
//  Inputs: name
//  Outputs: Draws that view's cached list into #home-list (or its empty
//    state)
///////////////////////////////////////////////////////////////////////////
function renderList(name) {
  const listEl = $("home-list");
  listEl.innerHTML = "";

  const records = cache[name] || [];
  if (records.length === 0) {
    listEl.appendChild(hintParagraph(VIEWS[name].emptyText));
    return;
  }

  records.forEach(record => listEl.appendChild(buildRow(name, record)));
}

///////////////////////////////////////////////////////////////////////////
//  Function: showEmptyStateIfNeeded
//  Inputs: name
//  Outputs: Replaces the list with the empty-state text if no rows remain
///////////////////////////////////////////////////////////////////////////
function showEmptyStateIfNeeded(name) {
  if ((cache[name] || []).length === 0 && currentView === name) renderList(name);
}

///////////////////////////////////////////////////////////////////////////
//  Function: buildRow
//  Inputs: name (view), record
//  Outputs: One list row: title, second line, and the three-dot button.
//    Clicking the row opens the record.
///////////////////////////////////////////////////////////////////////////
function buildRow(name, record) {
  const view = VIEWS[name];

  const item = document.createElement("div");
  item.className = "home-doc-item";

  const left = document.createElement("div");
  left.className = "home-doc-text";

  const title = document.createElement("p");
  title.className = "home-doc-title";
  title.textContent = record.title || view.untitled;

  const meta = document.createElement("p");
  meta.className = "home-doc-meta";
  meta.textContent = view.meta(record);

  left.append(title, meta);
  item.appendChild(left);

  const menuBtn = document.createElement("button");
  menuBtn.type = "button";
  menuBtn.className = "home-doc-menu-btn";
  menuBtn.textContent = "\u22EE"; // vertical three dots
  menuBtn.title = "More actions";
  menuBtn.setAttribute("aria-label", `Actions for ${record.title || view.untitled}`);
  menuBtn.setAttribute("aria-haspopup", "menu");
  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation(); // don't open the record
    openMenu(menuBtn, name, record, item, title);
  });
  item.appendChild(menuBtn);

  item.addEventListener("click", () => emit(view.openEvent, record));

  return item;
}

///////////////////////////////////////////////////////////////////////////
// The row menu
///////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////
//  Function: closeMenu
//  Inputs: None
//  Outputs: Removes the row menu if open
///////////////////////////////////////////////////////////////////////////
function closeMenu() {
  if (menuEl) {
    menuEl.remove();
    menuEl = null;
  }
}

///////////////////////////////////////////////////////////////////////////
//  Function: openMenu
//  Inputs: anchor (the three-dots button), name (view), record, itemEl (the
//    row), titleEl (the row's title element)
//  Outputs: Shows the menu under the button, or above it if there's no room
//    below
///////////////////////////////////////////////////////////////////////////
function openMenu(anchor, name, record, itemEl, titleEl) {
  closeMenu();
  const view = VIEWS[name];

  const menu = document.createElement("div");
  menu.id = "home-doc-menu";
  menu.setAttribute("role", "menu");

  const addEntry = (label, className, onClick) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("role", "menuitem");
    btn.className = "home-doc-menu-item" + (className ? ` ${className}` : "");
    btn.textContent = label;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeMenu();
      onClick();
    });
    menu.appendChild(btn);
    return btn;
  };

  let firstEntry = null;
  if (view.hasEdit) {
    firstEntry = addEntry("Edit", "", () => emit(view.openEvent, record));
  }
  const renameEntry = addEntry("Rename", "", () => startRename(name, record, titleEl));
  addEntry("Make a copy", "", () => makeCopy(name, record));
  addEntry("Delete", "home-doc-menu-danger", () => deleteRecord(name, record, itemEl));

  document.body.appendChild(menu);
  menuEl = menu;

  const rect = anchor.getBoundingClientRect();
  menu.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
  let top = rect.bottom + 4;
  if (top + menu.offsetHeight > window.innerHeight - 8) top = rect.top - menu.offsetHeight - 4;
  menu.style.top = `${Math.max(8, top)}px`;

  (firstEntry || renameEntry).focus();
}

///////////////////////////////////////////////////////////////////////////
// Row actions
///////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////
//  Function: startRename
//  Inputs: name (view), record, titleEl (the row's title element)
//  Outputs: Replaces the title with a text box; Enter or clicking away
//    saves the new name, Escape cancels
//  Summary: Reverts the title if saving to Firestore fails. Renaming does
//    not change the "Edited" time or reorder the list.
///////////////////////////////////////////////////////////////////////////
function startRename(name, record, titleEl) {
  const view = VIEWS[name];
  const originalTitle = record.title || view.untitled;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "home-doc-rename-input";
  input.value = originalTitle;
  input.maxLength = MAX_TITLE_LENGTH;
  input.setAttribute("aria-label", `${view.noun[0].toUpperCase()}${view.noun.slice(1)} name`);
  // Clicking inside the box mustn't open the record.
  input.addEventListener("click", (e) => e.stopPropagation());

  titleEl.replaceWith(input);
  input.focus();
  input.select();

  let finished = false;
  const finish = async (save) => {
    if (finished) return;
    finished = true;

    const newTitle = input.value.trim();
    if (!save || !newTitle || newTitle === originalTitle) {
      input.replaceWith(titleEl);
      return;
    }

    titleEl.textContent = newTitle;
    input.replaceWith(titleEl);

    try {
      await view.rename(record.id, newTitle);
      record.title = newTitle;
    } catch (err) {
      console.error(`HOME: failed to rename ${view.noun}:`, err);
      titleEl.textContent = originalTitle;
      alert(`Couldn't rename that ${view.noun}. Try again in a moment.`);
    }
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
  input.addEventListener("blur", () => finish(true));
}

///////////////////////////////////////////////////////////////////////////
//  Function: makeCopy
//  Inputs: name (view), record
//  Outputs: Creates a new record in the student's account titled
//    "Copy of <title>" and reloads the list
//  Summary: Copies the last saved version, read fresh from Firestore rather
//    than from the list on screen. Then the view's afterCreate hook copies
//    what is stored beside the record (a template's packet). If that fails,
//    the half-made copy is deleted, so no broken copy is left in the list.
///////////////////////////////////////////////////////////////////////////
async function makeCopy(name, record) {
  const view = VIEWS[name];
  const user = state.currentUser;
  if (!user) return;

  let newId = null;
  try {
    const fresh = await view.get(record.id);
    if (!fresh) {
      alert(`That ${view.noun} couldn't be found. It may have been deleted.`);
      cache[name] = null;
      showView(name);
      return;
    }

    const data = view.copyData(fresh);
    Object.keys(data).forEach(key => { if (data[key] === undefined) delete data[key]; });

    newId = await view.create(user.uid, {
      ...data,
      title: `Copy of ${fresh.title || view.untitled}`.slice(0, MAX_TITLE_LENGTH)
    });

    if (view.afterCreate) await view.afterCreate(fresh, newId);
  } catch (err) {
    console.error(`HOME: failed to copy ${view.noun}:`, err);

    // Don't leave a half-made copy behind. Cleaning up must never throw.
    if (newId) {
      try {
        await view.remove(newId);
      } catch (cleanupErr) {
        console.error(`HOME: couldn't remove the half-made ${view.noun} copy:`, cleanupErr);
      }
    }

    alert(`Couldn't make a copy of that ${view.noun}. Try again in a moment.`);
    return;
  }

  cache[name] = null;
  if (currentView === name) showView(name);
}

///////////////////////////////////////////////////////////////////////////
//  Function: deleteRecord
//  Inputs: name (view), record, itemEl (the row)
//  Outputs: After confirmation, permanently deletes the record (and
//    everything stored under it) and removes its row
///////////////////////////////////////////////////////////////////////////
async function deleteRecord(name, record, itemEl) {
  const view = VIEWS[name];
  const title = record.title || view.untitled;

  const confirmed = await confirmDialog({
    title: `Delete this ${view.noun}?`,
    message: `"${title}" will be permanently deleted, along with everything stored with it. This can't be undone.${view.deleteNote ? " " + view.deleteNote : ""}`,
    confirmLabel: "Delete",
    danger: true
  });
  if (!confirmed) return;

  // Deleting can take a moment (sources and other data are removed too), so
  // the row is dimmed and can't be clicked meanwhile.
  itemEl.classList.add("home-doc-item-busy");

  try {
    await view.remove(record.id);
  } catch (err) {
    console.error(`HOME: failed to delete ${view.noun}:`, err);
    itemEl.classList.remove("home-doc-item-busy");
    alert(`Couldn't delete that ${view.noun}. Try again in a moment.`);
    return;
  }

  itemEl.remove();
  cache[name] = (cache[name] || []).filter(r => r.id !== record.id);
  if (state.currentDocId === record.id) setState({ currentDocId: null });
  if (state.currentTemplateId === record.id) setState({ currentTemplateId: null });

  showEmptyStateIfNeeded(name);
}

///////////////////////////////////////////////////////////////////////////
// Creating
///////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////
//  Function: handleCreate
//  Inputs: None
//  Outputs: Runs the Create button for the current view
///////////////////////////////////////////////////////////////////////////
function handleCreate() {
  if (currentView === "templates") {
    emit(EVENTS.WIZARD_REQUESTED);
  } else {
    createDocument();
  }
}

///////////////////////////////////////////////////////////////////////////
//  Function: createDocument
//  Inputs: None
//  Outputs: Makes an empty document record and opens it
//  Summary: The list is marked stale so the new document appears when the
//    student comes back to Home.
///////////////////////////////////////////////////////////////////////////
async function createDocument() {
  const user = state.currentUser;
  if (!user) return;

  const btn = $("home-create");
  btn.disabled = true;

  try {
    const id = await createDocumentRecord(user.uid, { title: VIEWS.documents.untitled });
    cache.documents = null;
    emit(EVENTS.OPEN_DOCUMENT, {
      id,
      title: VIEWS.documents.untitled,
      stage: "drafting",
      revision: 0,
      template: null
    });
  } catch (err) {
    console.error("HOME: failed to create document:", err);
    alert("Couldn't create a new document. Try again in a moment.");
  } finally {
    btn.disabled = false;
  }
}

///////////////////////////////////////////////////////////////////////////
// Screen lifecycle
///////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////
//  Function: loadHome
//  Inputs: view (optional: "templates" or "documents"); also reads
//    state.currentUser
//  Outputs: Shows who is signed in and fetches the chosen view's list. A
//    view that is given becomes the current view (and is remembered);
//    otherwise the current view stays.
//  Summary: Called each time Home is shown, so the lists are fresh.
///////////////////////////////////////////////////////////////////////////
function loadHome(view) {
  const user = state.currentUser;
  if (!user) return;

  if (view === "templates" || view === "documents") {
    currentView = view;
    saveView(view);
  }

  const who = user.email || user.displayName || "your account";
  $("home-user").textContent = `Signed in as ${who}.`;

  cache.templates = null;
  cache.documents = null;
  showView(currentView);
}

///////////////////////////////////////////////////////////////////////////
//  Function: clearHome
//  Inputs: None
//  Outputs: Forgets everything shown, closes any menu or dialog, and makes
//    any list still loading ignore its answer
//  Summary: Runs on sign-out, so the next person on a shared iPad never sees
//    the previous student's titles.
///////////////////////////////////////////////////////////////////////////
function clearHome() {
  cache.templates = null;
  cache.documents = null;
  loadTokens.templates++;
  loadTokens.documents++;
  $("home-list").innerHTML = "";
  $("home-user").textContent = "";
  closeMenu();
  closeModal();
}

///////////////////////////////////////////////////////////////////////////
//  Function: initHome
//  Inputs: None
//  Outputs: Wires up the Home screen. Call once at startup.
///////////////////////////////////////////////////////////////////////////
function initHome() {
  $("home-view-templates").addEventListener("click", () => showView("templates"));
  $("home-view-documents").addEventListener("click", () => showView("documents"));
  $("home-create").addEventListener("click", handleCreate);

  $("home-sign-out").addEventListener("click", async () => {
    try {
      await signOutUser();
      // app.js's auth listener returns to the login screen.
    } catch (err) {
      console.error("AUTH: sign-out failed:", err);
      alert("Couldn't sign out. Try again in a moment.");
    }
  });

  // The row menu closes on any outside click, Escape, resize, or scroll.
  document.addEventListener("click", closeMenu);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });
  window.addEventListener("resize", closeMenu);
  window.addEventListener("scroll", closeMenu, true);

  on(EVENTS.AUTH_CHANGED, (user) => { if (!user) clearHome(); });
  on(EVENTS.SCREEN_CHANGED, () => closeMenu());

  syncChrome();
}

export { initHome, loadHome };