///////////////////////////////////////////////////////////////////////////
// modal.js
//  A small dialog system used across the app: Create Template, delete
//  confirmations now, and the conflict and unsaved-changes dialogs in later
//  phases. Ported from the Reader's app.js (openModal / closeModal) and
//  extended with a confirmDialog() that returns a promise.
//
//  Only one dialog is open at a time; opening another replaces it. Escape or
//  a click outside the dialog closes it.
//
//  Oliver Emerson - 2026
///////////////////////////////////////////////////////////////////////////

let modalEl = null;      // the open dialog's overlay, if any
let modalOnClose = null; // called once when the open dialog goes away

///////////////////////////////////////////////////////////////////////////
//  Function: closeModal
//  Inputs: None
//  Outputs: Removes the open dialog, if any, and calls its onClose callback
//    (once)
///////////////////////////////////////////////////////////////////////////
function closeModal() {
  const onClose = modalOnClose;
  modalOnClose = null;

  if (modalEl) {
    modalEl.remove();
    modalEl = null;
  }
  if (onClose) onClose();
}

///////////////////////////////////////////////////////////////////////////
//  Function: openModal
//  Inputs: title (string), contentEl (the dialog's body), actions
//    ([{ label, className, onClick(button), autofocus? }], shown as a row of
//    buttons), onClose (optional; called when the dialog closes for any
//    reason, including Escape, a click outside, or being replaced)
//  Outputs: Shows a dialog over the page, replacing any open one
//  Summary: Focus starts on the action marked autofocus, or on the dialog
//    itself if none is.
///////////////////////////////////////////////////////////////////////////
function openModal(title, contentEl, actions, onClose = null) {
  closeModal();

  const overlay = document.createElement("div");
  overlay.id = "modal-overlay";
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeModal();
  });

  const modal = document.createElement("div");
  modal.className = "modal";
  modal.tabIndex = -1;
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-label", title);

  const heading = document.createElement("h3");
  heading.className = "modal-title";
  heading.textContent = title;

  const actionRow = document.createElement("div");
  actionRow.className = "modal-actions";

  let focusTarget = modal;
  actions.forEach(({ label, className, onClick, autofocus }) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = className;
    btn.textContent = label;
    btn.addEventListener("click", () => onClick(btn));
    actionRow.appendChild(btn);
    if (autofocus) focusTarget = btn;
  });

  modal.append(heading, contentEl, actionRow);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  modalEl = overlay;
  modalOnClose = onClose;
  focusTarget.focus();
}

///////////////////////////////////////////////////////////////////////////
//  Function: confirmDialog
//  Inputs: { title, message, confirmLabel, cancelLabel, danger }
//  Outputs: Promise<boolean> — true if the student confirmed; false if they
//    cancelled, pressed Escape, or clicked outside
//  Summary: Focus starts on Cancel, so pressing Enter by accident never
//    confirms. With danger set, the confirm button is red.
///////////////////////////////////////////////////////////////////////////
function confirmDialog({
  title,
  message,
  confirmLabel = "OK",
  cancelLabel = "Cancel",
  danger = false
}) {
  return new Promise(resolve => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const content = document.createElement("div");
    const text = document.createElement("p");
    text.className = "modal-text";
    text.textContent = message;
    content.appendChild(text);

    openModal(
      title,
      content,
      [
        {
          label: cancelLabel,
          className: "btn-secondary",
          autofocus: true,
          onClick: () => { settle(false); closeModal(); }
        },
        {
          label: confirmLabel,
          className: danger ? "btn-danger" : "btn-primary",
          onClick: () => { settle(true); closeModal(); }
        }
      ],
      () => settle(false)
    );
  });
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && modalEl) closeModal();
});

export { openModal, closeModal, confirmDialog };