///////////////////////////////////////////////////////////////////////////
// home.js
//  The home screen. In Phase 1 this is a placeholder with the signed-in
//  account, a Sign Out button, and a "?" button to test the tutorial popup.
//  Phase 3 replaces it with the Templates / Documents toggle, the two
//  lists, and the three-dot menus.
//
//  Oliver Emerson - 2026
///////////////////////////////////////////////////////////////////////////

import { state } from "./state.js";
import { signOutUser } from "./firebase.js";

///////////////////////////////////////////////////////////////////////////
//  Function: renderHome
//  Inputs: None (reads state.currentUser)
//  Outputs: Shows who is signed in
///////////////////////////////////////////////////////////////////////////
function renderHome() {
  const user = state.currentUser;
  const label = user ? (user.email || user.displayName || "your account") : "";
  document.getElementById("home-user").textContent = label ? `Signed in as ${label}.` : "";
}

///////////////////////////////////////////////////////////////////////////
//  Function: initHome
//  Inputs: None
//  Outputs: Wires up the home screen's buttons. Call once at startup.
///////////////////////////////////////////////////////////////////////////
function initHome() {
  document.getElementById("home-sign-out").addEventListener("click", async () => {
    try {
      await signOutUser();
      // app.js's auth listener returns to the login screen.
    } catch (err) {
      console.error("AUTH: sign-out failed:", err);
      alert("Couldn't sign out. Try again in a moment.");
    }
  });
}

export { initHome, renderHome };