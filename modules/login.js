///////////////////////////////////////////////////////////////////////////
// login.js
//  The login screen: email and password sign-in, account creation, and
//  Continue with Google. One form serves both sign-in and account creation,
//  switched by authMode.
//
//  This module only signs people in. Moving to the home screen when sign-in
//  succeeds is app.js's job: it listens for the auth state change.
//
//  Oliver Emerson - 2026
///////////////////////////////////////////////////////////////////////////

import { signUpEmail, signInEmail, signInGoogle } from "./firebase.js";

let authMode = "signin"; // "signin" | "signup"
let busy = false;        // true while a sign-in request is running

///////////////////////////////////////////////////////////////////////////
//  Function: friendlyAuthErrorMessage
//  Inputs: err (a Firebase auth error)
//  Outputs: Plain-English text for the error codes a user is likely to hit
//  Summary: Anything unrecognized gets a generic message; the real error is
//    always logged to the console by the caller.
///////////////////////////////////////////////////////////////////////////
function friendlyAuthErrorMessage(err) {
  const code = err && err.code ? err.code : "";
  switch (code) {
    case "auth/invalid-email":
      return "That doesn't look like a valid email address.";
    case "auth/user-not-found":
    case "auth/wrong-password":
    case "auth/invalid-credential":
      return "Incorrect email or password.";
    case "auth/email-already-in-use":
      return "An account with that email already exists — try signing in instead.";
    case "auth/weak-password":
      return "Password should be at least 6 characters.";
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request":
      return "Google sign-in was closed before finishing.";
    case "auth/popup-blocked":
      return "Your browser blocked the Google sign-in window. Allow pop-ups for this site and try again.";
    case "auth/too-many-requests":
      return "Too many attempts. Wait a moment and try again.";
    case "auth/network-request-failed":
      return "Couldn't reach the server. Check your connection and try again.";
    case "auth/user-disabled":
      return "This account has been disabled.";
    case "auth/unauthorized-domain":
      return "This site's address isn't approved for sign-in yet. In the Firebase console, add it under Authentication, Settings, Authorized domains.";
    default:
      return "Something went wrong signing in. Please try again.";
  }
}

///////////////////////////////////////////////////////////////////////////
//  Function: showAuthError
//  Inputs: message (string)
//  Outputs: Shows the message above the login form
///////////////////////////////////////////////////////////////////////////
function showAuthError(message) {
  const errEl = document.getElementById("auth-error");
  errEl.textContent = message;
  errEl.style.display = "block";
}

///////////////////////////////////////////////////////////////////////////
//  Function: clearAuthError
//  Inputs: None
//  Outputs: Hides the login error message
///////////////////////////////////////////////////////////////////////////
function clearAuthError() {
  const errEl = document.getElementById("auth-error");
  errEl.style.display = "none";
  errEl.textContent = "";
}

///////////////////////////////////////////////////////////////////////////
//  Function: setBusy
//  Inputs: isBusy (boolean)
//  Outputs: Disables or enables both sign-in buttons
//  Summary: Stops a second request starting while one is running (for
//    example, a double-tap on an iPad).
///////////////////////////////////////////////////////////////////////////
function setBusy(isBusy) {
  busy = isBusy;
  document.getElementById("auth-submit").disabled = isBusy;
  document.getElementById("auth-google").disabled = isBusy;
}

///////////////////////////////////////////////////////////////////////////
//  Function: setAuthMode
//  Inputs: mode — "signin" or "signup"
//  Outputs: Updates the form's button, toggle text, and the password
//    field's autocomplete hint to match
//  Summary: The autocomplete hint tells password managers (including the
//    iPad's) whether to fill a saved password or offer a new one.
///////////////////////////////////////////////////////////////////////////
function setAuthMode(mode) {
  authMode = mode;
  clearAuthError();

  const submitBtn = document.getElementById("auth-submit");
  const toggleText = document.getElementById("auth-toggle-text");
  const toggleLink = document.getElementById("auth-toggle-link");
  const passwordInput = document.getElementById("auth-password");

  if (mode === "signup") {
    submitBtn.textContent = "Create Account";
    toggleText.textContent = "Already have an account?";
    toggleLink.textContent = "Sign in";
    passwordInput.autocomplete = "new-password";
  } else {
    submitBtn.textContent = "Sign In";
    toggleText.textContent = "Don't have an account?";
    toggleLink.textContent = "Create one";
    passwordInput.autocomplete = "current-password";
  }
}

///////////////////////////////////////////////////////////////////////////
//  Function: handleSubmit
//  Inputs: None (reads the form fields)
//  Outputs: Signs in or creates the account and shows any error
///////////////////////////////////////////////////////////////////////////
async function handleSubmit() {
  if (busy) return;

  const email = document.getElementById("auth-email").value.trim();
  const password = document.getElementById("auth-password").value;
  clearAuthError();

  if (!email || !password) {
    showAuthError("Please enter both an email and a password.");
    return;
  }

  setBusy(true);
  try {
    if (authMode === "signup") {
      await signUpEmail(email, password);
    } else {
      await signInEmail(email, password);
    }
    // app.js's auth listener moves on to the home screen.
  } catch (err) {
    console.error("AUTH: sign-in/sign-up failed:", err);
    showAuthError(friendlyAuthErrorMessage(err));
  } finally {
    setBusy(false);
  }
}

///////////////////////////////////////////////////////////////////////////
//  Function: handleGoogle
//  Inputs: None
//  Outputs: Signs in through the Google popup and shows any error
///////////////////////////////////////////////////////////////////////////
async function handleGoogle() {
  if (busy) return;
  clearAuthError();

  setBusy(true);
  try {
    await signInGoogle();
  } catch (err) {
    console.error("AUTH: Google sign-in failed:", err);
    showAuthError(friendlyAuthErrorMessage(err));
  } finally {
    setBusy(false);
  }
}

///////////////////////////////////////////////////////////////////////////
//  Function: resetLoginForm
//  Inputs: None
//  Outputs: Clears the password and any error, and switches back to
//    sign-in mode
//  Summary: Called by app.js on every auth change, so a password never
//    stays in the page after sign-in and the next person to use the device
//    sees a clean form after sign-out. The email is left in place as a
//    convenience.
///////////////////////////////////////////////////////////////////////////
function resetLoginForm() {
  document.getElementById("auth-password").value = "";
  setAuthMode("signin");
}

///////////////////////////////////////////////////////////////////////////
//  Function: initLogin
//  Inputs: None
//  Outputs: Wires up the login form. Call once at startup.
///////////////////////////////////////////////////////////////////////////
function initLogin() {
  // A real <form>, so Enter submits and password managers recognize it.
  document.getElementById("auth-form").addEventListener("submit", (e) => {
    e.preventDefault();
    handleSubmit();
  });

  document.getElementById("auth-toggle-link").addEventListener("click", (e) => {
    e.preventDefault();
    setAuthMode(authMode === "signin" ? "signup" : "signin");
  });

  document.getElementById("auth-google").addEventListener("click", handleGoogle);

  setAuthMode("signin");
}

export { initLogin, resetLoginForm };