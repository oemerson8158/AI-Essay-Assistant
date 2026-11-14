///////////////////////////////////////////////////////////////////////////
// router.js
//  Decides which top-level screen is showing. Exactly one screen is visible
//  at a time; the rest are hidden.
//
//  Screens: loading, login, home, wizard (template wizard), template-editor,
//  and editor. Each has a container in index.html. Phases 3 to 6 fill the
//  containers in; for now the wizard, template editor, and editor are
//  placeholders.
//
//  Oliver Emerson - 2026
///////////////////////////////////////////////////////////////////////////

import { state, setState, emit, EVENTS } from "./state.js";

// Screen name -> its container's id and the CSS display value to use when
// it is showing (flex for the screens that lay themselves out as a row or
// column, block for the rest).
const SCREENS = {
  loading: { id: "loading-screen", display: "flex" },
  login: { id: "login-screen", display: "flex" },
  home: { id: "home-screen", display: "block" },
  wizard: { id: "wizard-screen", display: "block" },
  "template-editor": { id: "template-editor-screen", display: "block" },
  editor: { id: "editor-screen", display: "flex" }
};

///////////////////////////////////////////////////////////////////////////
//  Function: showScreen
//  Inputs: screenName — a key of SCREENS
//  Outputs: Shows that screen, hides the others, records it in
//    state.currentScreen, and emits "screen:changed" ({ from, to }) if the
//    screen actually changed
//  Summary: Other modules react to the event (for example, help.js closes
//    its popup) instead of being called from here.
///////////////////////////////////////////////////////////////////////////
function showScreen(screenName) {
  if (!SCREENS[screenName]) {
    console.error(`ROUTER: unknown screen "${screenName}"`);
    return;
  }

  const from = state.currentScreen;

  Object.entries(SCREENS).forEach(([name, config]) => {
    const el = document.getElementById(config.id);
    if (!el) return;
    el.style.display = name === screenName ? config.display : "none";
  });

  setState({ currentScreen: screenName });
  window.scrollTo(0, 0);

  if (from !== screenName) emit(EVENTS.SCREEN_CHANGED, { from, to: screenName });
}

export { showScreen, SCREENS };