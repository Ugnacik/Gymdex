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

// Asks for one line of text, such as a Routine name, in the same kind of sheet instead of
// window.prompt(). submit(text) receives the trimmed text; when it throws, its message shows
// in the sheet, which stays open for a correction. Resolves with submit's result, or null
// when the user leaves with Cancel, Escape or a backdrop tap.
export function askTextInPage(document, question, { label, value = "", confirmLabel, cancelLabel = "Cancel", maxLength = 80, submit }) {
  const returnFocus = document.activeElement;
  const element = (tagName, className, text) =>
    Object.assign(document.createElement(tagName), { className, textContent: text });
  const dialog = element("dialog", "history-dialog confirm-sheet", "");
  const form = element("form", "confirm-body", "");
  const text = element("p", "confirm-question", question);
  text.id = "text-sheet-question";
  dialog.setAttribute("aria-labelledby", text.id);
  const field = element("div", "field", "");
  const caption = element("label", "", label);
  const input = Object.assign(element("input", "", ""), {
    id: "text-sheet-input", name: "text", value, maxLength, autocomplete: "off",
  });
  caption.htmlFor = input.id;
  field.append(caption, input);
  const status = element("p", "set-status error", "");
  status.setAttribute("role", "status");
  const cancel = element("button", "secondary", cancelLabel);
  const confirm = element("button", "primary", confirmLabel);
  cancel.type = "button";
  confirm.type = "submit";
  const actions = element("div", "confirm-actions", "");
  actions.append(cancel, confirm);
  form.append(text, field, status, actions);
  dialog.append(form);
  let result = null;
  cancel.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const clean = input.value.split(/\s+/).filter(Boolean).join(" ");
    if (!clean) {
      status.textContent = `${label} is required.`;
      input.focus();
      return;
    }
    confirm.disabled = true;
    status.textContent = "";
    try {
      result = await submit(clean);
      dialog.close("confirm");
    } catch (error) {
      status.textContent = error.message;
      confirm.disabled = false;
      input.focus();
    }
  });
  document.body.append(dialog);
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => {
      dialog.remove();
      if (returnFocus?.isConnected) returnFocus.focus();
      resolve(dialog.returnValue === "confirm" ? result : null);
    });
    dialog.showModal();
    input.focus();
    input.select?.();
  });
}
