// Gymdex asks its own questions instead of window.confirm(), which some in-app browsers
// (an iOS WKWebView) answer with false without showing anything. The sheet opens as a
// modal dialog, so it stacks above an open dialog and an inert page. Only its action
// button answers yes; the safe button, Escape and a backdrop tap answer no.
export function confirmInPage(document, question, { confirmLabel, cancelLabel = "Keep", danger = false }) {
  const returnFocus = document.activeElement;
  const element = (tagName, className, text) =>
    Object.assign(document.createElement(tagName), { className, textContent: text });
  const dialog = element("dialog", "history-dialog confirm-sheet", "");
  const body = element("div", "confirm-body", "");
  const text = element("p", "confirm-question", question);
  text.id = "confirm-question";
  dialog.setAttribute("aria-labelledby", text.id);
  const keep = element("button", "secondary", cancelLabel);
  const confirm = element("button", danger ? "primary danger" : "primary", confirmLabel);
  keep.type = confirm.type = "button";
  const actions = element("div", "confirm-actions", "");
  actions.append(keep, confirm);
  body.append(text, actions);
  dialog.append(body);
  keep.addEventListener("click", () => dialog.close());
  confirm.addEventListener("click", () => dialog.close("confirm"));
  // The body fills the dialog, so a click targeting the dialog itself landed on the backdrop.
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  document.body.append(dialog);
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => {
      dialog.remove();
      if (returnFocus?.isConnected) returnFocus.focus();
      resolve(dialog.returnValue === "confirm");
    });
    dialog.showModal();
    keep.focus();
  });
}
