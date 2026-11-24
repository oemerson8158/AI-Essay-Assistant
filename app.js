///////////////////////////////////////////////////////////////////////////
// app.js
//  Entry point of the AI Essay Assistant. It wires the screens together and
//  decides which one shows, based on whether someone is signed in.
//
//  Unlike the Reader's app.js, this file owns no shared state and is not
//  imported by the feature modules. State lives in modules/state.js, and
//  modules talk to each other through its event bus, so there are no
//  circular imports.
//
//  Startup is deliberately noisy and hard to hang: each step logs a line
//  starting "APP:" to the console, any failure is shown on the loading
//  screen, and if Firebase's sign-in listener hasn't reported after a few
//  seconds, Firebase is asked directly.
//
//  Oliver Emerson - 2026
///////////////////////////////////////////////////////////////////////////

import { onAuthChange, auth } from "./modules/firebase.js";
import { state, setState, on, emit, EVENTS } from "./modules/state.js";
import { showScreen } from "./modules/router.js";
import "./modules/help.js"; // registers the "?" popup's listeners
import { initLogin, resetLoginForm } from "./modules/login.js";
import { initHome, loadHome } from "./modules/home.js";
import { initWizard } from "./modules/wizard.js";
import { initTemplateEditor } from "./modules/templateEditor.js";
import { initPlaceholders } from "./modules/placeholders.js";

// If Firebase's listener hasn't reported by now, ask Firebase directly.
const AUTH_FALLBACK_MS = 8000;

const log = (...args) => console.log("APP:", ...args);

log("app.js started");

///////////////////////////////////////////////////////////////////////////
//  Function: reportStartupError
//  Inputs: err (anything thrown)
//  Outputs: Logs it, and while the loading screen is still up, shows it
//    there so a failure is never silent
///////////////////////////////////////////////////////////////////////////
function reportStartupError(err) {
  console.error("APP: startup problem:", err);

  const loading = document.getElementById("loading-screen");
  const text = document.getElementById("loading-text");
  if (loading && text && loading.style.display !== "none") {
    text.textContent = `The app couldn't start: ${(err && err.message) || err}`;
  }
}

///////////////////////////////////////////////////////////////////////////
//  Wiring the screens
//  Each is wrapped separately, so a problem in one (say, the placeholder
//  screens) doesn't stop the login screen from working.
///////////////////////////////////////////////////////////////////////////

[
  ["login", initLogin],
  ["home", initHome],
  ["template wizard", initWizard],
  ["template editor", initTemplateEditor],
  ["placeholders", initPlaceholders]
].forEach(([name, init]) => {
  try {
    init();
    log(`${name} wired`);
  } catch (err) {
    reportStartupError(new Error(`Couldn't set up the ${name} screen: ${err && err.message}`));
  }
});

///////////////////////////////////////////////////////////////////////////
//  Going home
//  Any screen can ask for Home by emitting HOME_REQUESTED.
///////////////////////////////////////////////////////////////////////////

// detail is optional: { view: "templates" | "documents" } picks the list.
on(EVENTS.HOME_REQUESTED, (detail) => {
  if (!state.currentUser) return;
  showScreen("home");
  loadHome(detail && detail.view);
});

///////////////////////////////////////////////////////////////////////////
//  Auth state
//  Drives which screen shows on load and after sign-in or sign-out. Firebase
//  calls this once as soon as it knows whether someone is signed in (until
//  then the loading screen shows, so a signed-in student never sees a
//  flash of the login form), and again on every sign-in and sign-out.
///////////////////////////////////////////////////////////////////////////

let authReported = false; // true once handleAuth has run at least once

///////////////////////////////////////////////////////////////////////////
//  Function: handleAuth
//  Inputs: user (the Firebase user, or null)
//  Outputs: Records who is signed in, tells the other modules, and shows
//    Home or the login screen
//  Summary: If anything in here fails, the error is shown and the login
//    screen is displayed anyway, so the app never stays on "Loading…".
///////////////////////////////////////////////////////////////////////////
function handleAuth(user) {
  authReported = true;
  log("sign-in state received:", user ? (user.email || user.uid) : "signed out");

  try {
    const previousUid = state.currentUser ? state.currentUser.uid : null;
    const nextUid = user ? user.uid : null;

    setState({ currentUser: user });

    // A different person (or nobody) is now signed in: forget what was open.
    if (previousUid !== nextUid) {
      setState({ currentTemplateId: null, currentDocId: null });
    }

    resetLoginForm();

    // Other modules listen for this to stop running work and clear their
    // screens, for example Home empties its lists on sign-out, and later an
    // AI run for the last user is cancelled.
    emit(EVENTS.AUTH_CHANGED, user);

    if (user) {
      showScreen("home");
      loadHome();
      log("showing home");
    } else {
      showScreen("login");
      log("showing login");
    }
  } catch (err) {
    reportStartupError(err);
    try {
      showScreen("login");
    } catch {
      // Nothing more can be done.
    }
  }
}

onAuthChange(handleAuth);
log("waiting for Firebase's sign-in state");

// Fallback: the listener normally answers within a second or two. If it
// hasn't by now, ask Firebase directly rather than leave the student on
// "Loading…".
setTimeout(async () => {
  if (authReported) return;

  console.warn(`APP: Firebase's listener hasn't reported after ${AUTH_FALLBACK_MS / 1000}s. Asking Firebase directly.`);
  try {
    await auth.authStateReady();
  } catch (err) {
    reportStartupError(err);
    return;
  }
  if (!authReported) handleAuth(auth.currentUser);
}, AUTH_FALLBACK_MS);