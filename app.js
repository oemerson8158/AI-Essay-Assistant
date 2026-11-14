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
//  Oliver Emerson - 2026
///////////////////////////////////////////////////////////////////////////

import { onAuthChange } from "./modules/firebase.js";
import { state, setState, emit, EVENTS } from "./modules/state.js";
import { showScreen } from "./modules/router.js";
import "./modules/help.js"; // registers the "?" popup's listeners
import { initLogin, resetLoginForm } from "./modules/login.js";
import { initHome, renderHome } from "./modules/home.js";

initLogin();
initHome();

///////////////////////////////////////////////////////////////////////////
//  Auth state
//  Drives which screen shows on load and after sign-in or sign-out. Firebase
//  calls this once as soon as it knows whether someone is signed in (until
//  then the loading screen shows, so a signed-in student never sees a
//  flash of the login form), and again on every sign-in and sign-out.
///////////////////////////////////////////////////////////////////////////

onAuthChange((user) => {
  const previousUid = state.currentUser ? state.currentUser.uid : null;
  const nextUid = user ? user.uid : null;

  setState({ currentUser: user });

  // A different person (or nobody) is now signed in: forget what was open.
  if (previousUid !== nextUid) {
    setState({ currentTemplateId: null, currentDocId: null });
  }

  resetLoginForm();

  // Other modules (added in later phases) listen for this to stop running
  // work and clear their screens, for example an AI run for the last user.
  emit(EVENTS.AUTH_CHANGED, user);

  if (user) {
    renderHome();
    showScreen("home");
  } else {
    showScreen("login");
  }
});