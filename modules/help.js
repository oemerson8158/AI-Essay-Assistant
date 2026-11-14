///////////////////////////////////////////////////////////////////////////
// help.js
//  The "?" tutorial popup, generalized from the Reader's. Each context (Home,
//  the template wizard, Outline, and so on) registers a title and a list of
//  steps, and any button that carries that context's key in a data-help
//  attribute opens the popup, anchored just below itself:
//
//    <button class="help-btn" data-help="home">?</button>
//
//  The popup shows one step at a time (numbered buttons, Back / Next) or all
//  at once ("View all steps"). The X, Done, Escape, or a click outside closes
//  it. It also closes when the screen changes.
//
//  Buttons are found by one delegated click listener, so a button added to
//  the page later works with no setup, and a button whose context changes
//  (like the right sidebar's, which follows the active tab) only needs its
//  data-help attribute updated.
//
//  The wording lives in helpContent.js. This module registers it when
//  it loads, so app.js only has to import it once.
//
//  Oliver Emerson - 2026
///////////////////////////////////////////////////////////////////////////

import { HELP_CONTENT } from "./helpContent.js";
import { on, EVENTS } from "./state.js";

const guides = new Map(); // key -> { title, steps }

let popupEl = null;   // the open popup, if any
let anchorEl = null;  // the button that opened it
let current = { key: null, step: 0, showAll: false };

///////////////////////////////////////////////////////////////////////////
//  Function: registerHelp
//  Inputs: key (string), guide ({ title, steps: [string, ...] })
//  Outputs: Makes the guide available to buttons with data-help="<key>"
//  Summary: Ignores (and logs) a guide that is missing a title or steps.
///////////////////////////////////////////////////////////////////////////
function registerHelp(key, guide) {
  const valid =
    guide &&
    typeof guide.title === "string" &&
    Array.isArray(guide.steps) &&
    guide.steps.length > 0 &&
    guide.steps.every(step => typeof step === "string");

  if (!valid) {
    console.error(`HELP: guide "${key}" needs a title and a non-empty list of text steps.`);
    return;
  }
  guides.set(key, guide);
}

///////////////////////////////////////////////////////////////////////////
//  Function: hasHelp
//  Inputs: key
//  Outputs: true if a guide is registered under that key
///////////////////////////////////////////////////////////////////////////
function hasHelp(key) {
  return guides.has(key);
}

///////////////////////////////////////////////////////////////////////////
//  Function: el
//  Inputs: tag, className (optional), text (optional)
//  Outputs: The new DOM element
//  Summary: Small helper for building elements.
///////////////////////////////////////////////////////////////////////////
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

///////////////////////////////////////////////////////////////////////////
//  Function: positionPopup
//  Inputs: None
//  Outputs: Moves and sizes the popup
//  Summary: Places it just under the button, with its right edge lined up
//    with the button's (the "?" buttons sit toward the right), then keeps it
//    inside the window. Closes the popup if the button has gone or is hidden.
///////////////////////////////////////////////////////////////////////////
function positionPopup() {
  if (!popupEl || !anchorEl) return;

  const rect = anchorEl.getBoundingClientRect();
  if (!anchorEl.isConnected || (rect.width === 0 && rect.height === 0)) {
    closeHelp();
    return;
  }

  const margin = 8;
  const width = Math.min(360, window.innerWidth - margin * 2);
  const left = Math.max(margin, Math.min(rect.right - width, window.innerWidth - width - margin));
  const top = rect.bottom + 8;

  popupEl.style.width = `${width}px`;
  popupEl.style.left = `${left}px`;
  popupEl.style.top = `${top}px`;
  popupEl.style.maxHeight = `${Math.max(160, window.innerHeight - top - margin)}px`;
}

///////////////////////////////////////////////////////////////////////////
//  Function: render
//  Inputs: focusNext (boolean — put keyboard focus on the Next/Done button
//    afterwards)
//  Outputs: Rebuilds the popup's contents from `current`
//  Summary: Draws either the current step or the full list, plus the step
//    buttons, view toggle, and Back / Next / Done. The buttons are rebuilt
//    on every change, so focus is put back explicitly for keyboard users.
///////////////////////////////////////////////////////////////////////////
function render(focusNext = false) {
  const guide = guides.get(current.key);
  const steps = guide.steps;
  const lastStep = steps.length - 1;

  popupEl.innerHTML = "";

  const closeBtn = el("button", "help-popup-close", "✕");
  closeBtn.type = "button";
  closeBtn.title = "Close";
  closeBtn.setAttribute("aria-label", "Close tutorial");
  closeBtn.addEventListener("click", () => closeHelp({ restoreFocus: true }));

  popupEl.append(closeBtn, el("h3", "help-popup-title", guide.title));

  if (current.showAll) {
    const list = el("ol", "help-popup-list");
    steps.forEach(text => list.appendChild(el("li", "", text)));
    popupEl.appendChild(list);
  } else {
    popupEl.appendChild(el("p", "help-popup-text", steps[current.step]));
  }

  const footer = el("div", "help-popup-footer");
  const left = el("div", "help-popup-left");
  const right = el("div", "help-popup-right");

  if (!current.showAll) {
    steps.forEach((_, i) => {
      const isActive = i === current.step;
      const pill = el("button", "help-popup-pill" + (isActive ? " help-popup-pill-active" : ""), String(i + 1));
      pill.type = "button";
      pill.setAttribute("aria-label", `Go to step ${i + 1}`);
      if (isActive) pill.setAttribute("aria-current", "step");
      pill.addEventListener("click", () => {
        current.step = i;
        render();
      });
      left.appendChild(pill);
    });
  }

  const toggle = el("button", "help-popup-link", current.showAll ? "Step by step" : "View all steps");
  toggle.type = "button";
  toggle.addEventListener("click", () => {
    current.showAll = !current.showAll;
    render();
  });
  left.appendChild(toggle);

  if (!current.showAll && current.step > 0) {
    const back = el("button", "help-popup-back", "Back");
    back.type = "button";
    back.addEventListener("click", () => {
      current.step--;
      render(true);
    });
    right.appendChild(back);
  }

  const isLast = current.showAll || current.step === lastStep;
  const next = el("button", "help-popup-next", isLast ? "Done" : "Next");
  next.type = "button";
  next.addEventListener("click", () => {
    if (isLast) {
      closeHelp({ restoreFocus: true });
    } else {
      current.step++;
      render(true);
    }
  });
  right.appendChild(next);

  footer.append(left, right);
  popupEl.appendChild(footer);

  positionPopup();
  if (focusNext) next.focus();
}

///////////////////////////////////////////////////////////////////////////
//  Function: openHelp
//  Inputs: key (a registered guide), anchor (the button to sit under)
//  Outputs: Opens the popup at step 1
//  Summary: Does nothing (and logs) for a key with no guide, so a typo in a
//    data-help attribute is easy to spot.
///////////////////////////////////////////////////////////////////////////
function openHelp(key, anchor) {
  if (!guides.has(key)) {
    console.warn(`HELP: no guide is registered for "${key}".`);
    return;
  }
  closeHelp();

  current = { key, step: 0, showAll: false };
  anchorEl = anchor;

  popupEl = el("div", "");
  popupEl.id = "help-popup";
  popupEl.tabIndex = -1;
  popupEl.setAttribute("role", "dialog");
  popupEl.setAttribute("aria-label", `${guides.get(key).title} tutorial`);
  // Buttons inside re-draw the popup, which detaches the clicked element
  // before the outside-click check could see it was inside.
  popupEl.addEventListener("click", (e) => e.stopPropagation());

  document.body.appendChild(popupEl);
  anchor.setAttribute("aria-haspopup", "dialog");
  anchor.setAttribute("aria-expanded", "true");
  render();
  popupEl.focus();
}

///////////////////////////////////////////////////////////////////////////
//  Function: closeHelp
//  Inputs: options ({ restoreFocus } — return focus to the button)
//  Outputs: Removes the popup if open
///////////////////////////////////////////////////////////////////////////
function closeHelp({ restoreFocus = false } = {}) {
  const wasAnchor = anchorEl;

  if (popupEl) {
    popupEl.remove();
    popupEl = null;
  }
  if (wasAnchor) {
    wasAnchor.setAttribute("aria-expanded", "false");
    if (restoreFocus && wasAnchor.isConnected) wasAnchor.focus();
  }
  anchorEl = null;
}

///////////////////////////////////////////////////////////////////////////
// Setup (runs once, when this module loads)
///////////////////////////////////////////////////////////////////////////

Object.entries(HELP_CONTENT).forEach(([key, guide]) => registerHelp(key, guide));

// One click listener serves every "?" button, present or future.
document.addEventListener("click", (e) => {
  const target = e.target instanceof Element ? e.target : null;
  const trigger = target ? target.closest("[data-help]") : null;

  if (trigger) {
    if (popupEl && anchorEl === trigger) {
      closeHelp();
    } else {
      openHelp(trigger.dataset.help, trigger);
    }
    return;
  }

  // Clicks inside the popup never reach here (see openHelp), so any other
  // click is outside it.
  if (popupEl) closeHelp();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && popupEl) closeHelp({ restoreFocus: true });
});

window.addEventListener("resize", positionPopup);
window.addEventListener("scroll", positionPopup, true);

// A popup from one screen mustn't linger on the next.
on(EVENTS.SCREEN_CHANGED, () => closeHelp());

export { registerHelp, hasHelp, openHelp, closeHelp };