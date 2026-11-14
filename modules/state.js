///////////////////////////////////////////////////////////////////////////
// state.js
//  Shared application state and a tiny event bus.
//
//  Modules read `state` directly and change it with setState(). When one
//  module needs to tell another that something happened, it emit()s an
//  event and the other module on()s it. Neither imports the other, which is
//  what replaces the circular imports between app.js and the Reader's
//  feature modules.
//
//  Rule of thumb: state.js imports nothing from this project, so any file
//  may import it without creating a cycle.
//
//  Oliver Emerson - 2026
///////////////////////////////////////////////////////////////////////////

// Names of the events the app emits. Use these instead of typing the strings,
// so a typo is a loud "undefined" rather than a listener that never fires.
const EVENTS = {
  AUTH_CHANGED: "auth:changed",     // detail: the Firebase user, or null
  SCREEN_CHANGED: "screen:changed", // detail: { from, to }
  STATE_CHANGE: "state:change"      // detail: { [key]: newValue } for each changed key
};

// Shared application data. Later phases add keys here (the open document,
// its tabs, the applied template, and so on).
const state = {
  currentUser: null,         // the signed-in Firebase user, or null
  currentScreen: "loading",  // see SCREENS in router.js
  currentTemplateId: null,   // template open in the template editor
  currentDocId: null         // document open in the editor
};

const listeners = new Map(); // event name -> Set of handlers

///////////////////////////////////////////////////////////////////////////
//  Function: on
//  Inputs: event (string), handler(detail)
//  Outputs: A function that removes this handler when called
///////////////////////////////////////////////////////////////////////////
function on(event, handler) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(handler);
  return () => off(event, handler);
}

///////////////////////////////////////////////////////////////////////////
//  Function: off
//  Inputs: event (string), handler (the same function passed to on)
//  Outputs: Removes the handler if it was registered
///////////////////////////////////////////////////////////////////////////
function off(event, handler) {
  const set = listeners.get(event);
  if (!set) return;
  set.delete(handler);
  if (set.size === 0) listeners.delete(event);
}

///////////////////////////////////////////////////////////////////////////
//  Function: emit
//  Inputs: event (string), detail (anything, passed to each handler)
//  Outputs: Calls every handler registered for the event
//  Summary: Each handler runs inside its own try/catch, so one handler that
//    throws can't stop the others from running or break the code that
//    emitted the event.
///////////////////////////////////////////////////////////////////////////
function emit(event, detail) {
  const set = listeners.get(event);
  if (!set) return;
  // Copy first, so a handler that unsubscribes itself doesn't disturb the loop.
  [...set].forEach(handler => {
    try {
      handler(detail);
    } catch (err) {
      console.error(`STATE: a handler for "${event}" threw:`, err);
    }
  });
}

///////////////////////////////////////////////////////////////////////////
//  Function: setState
//  Inputs: patch (an object of keys to change)
//  Outputs: Updates state, then emits "state:change" with only the keys whose
//    value actually changed (nothing is emitted if none did)
//  Summary: Warns about a key that isn't part of `state`, which is almost
//    always a typo.
///////////////////////////////////////////////////////////////////////////
function setState(patch) {
  const changed = {};

  Object.keys(patch).forEach(key => {
    if (!(key in state)) {
      console.warn(`STATE: setState got an unknown key "${key}". Add it to state in state.js.`);
    }
    if (state[key] !== patch[key]) {
      state[key] = patch[key];
      changed[key] = patch[key];
    }
  });

  if (Object.keys(changed).length > 0) emit(EVENTS.STATE_CHANGE, changed);
}

export { state, setState, on, off, emit, EVENTS };