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
// when the user leaves with Cancel, Escape or a backdrop tap. Leaving while a submit is in
// flight resolves with that submit's result once it arrives (null if it fails).
// errorAction(error, text), when given, may answer a failed submit with another way to save
// that text, such as replacing the Routine that already has the name: { label, busyLabel,
// confirm(), run(text) }. Its destructive button appears beside the message; confirm() must
// answer true before run(text) saves, and only one save is in flight at a time. Editing the
// text withdraws the offer, since it was about the text that failed.
export function askTextInPage(document, question, { label, value = "", confirmLabel, cancelLabel = "Cancel", maxLength = 80, submit,
  errorAction = null }) {
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
  const alternative = element("button", "primary danger text-sheet-alternative", "");
  alternative.type = "button";
  alternative.hidden = true;
  const problem = element("div", "text-sheet-problem", "");
  problem.append(status);
  if (errorAction) problem.append(alternative);
  const cancel = element("button", "secondary", cancelLabel);
  const confirm = element("button", "primary", confirmLabel);
  cancel.type = "button";
  confirm.type = "submit";
  const actions = element("div", "confirm-actions", "");
  actions.append(cancel, confirm);
  form.append(text, field, problem, actions);
  dialog.append(form);
  let result = null;
  // The save in flight, if any: leaving the sheet does not stop the server from saving.
  let pending = null;
  // The offer from errorAction for the text that failed, and whether a save is in flight.
  let offer = null;
  let busy = false;
  const withdraw = () => { offer = null; alternative.hidden = true; alternative.textContent = ""; };
  // A failed alternative keeps its own offer, so it can be tried again.
  const fail = (error, clean, fallback = null) => {
    pending = null;
    status.textContent = error.message;
    const next = errorAction?.(error, clean) ?? fallback;
    if (next) {
      offer = { ...next, text: clean };
      alternative.textContent = next.label;
      alternative.hidden = false;
      alternative.disabled = false;
    } else withdraw();
    confirm.disabled = false;
  };
  input.addEventListener("input", () => {
    if (!offer || busy) return;
    if (input.value.split(/\s+/).filter(Boolean).join(" ").toLowerCase() === offer.text.toLowerCase()) return;
    withdraw();
    status.textContent = "";
  });
  alternative.addEventListener("click", async () => {
    if (!offer || busy) return;
    const chosen = offer;
    busy = true;
    confirm.disabled = alternative.disabled = true;
    let confirmed = false;
    try { confirmed = await chosen.confirm(); } catch { confirmed = false; }
    if (!confirmed) {
      busy = false;
      confirm.disabled = alternative.disabled = false;
      alternative.focus();
      return;
    }
    alternative.textContent = chosen.busyLabel ?? chosen.label;
    alternative.setAttribute("aria-busy", "true");
    status.textContent = "";
    try {
      pending = chosen.run(chosen.text);
      result = await pending;
      dialog.close("confirm");
    } catch (error) {
      fail(error, chosen.text, chosen);
      alternative.focus();
    } finally {
      busy = false;
      alternative.setAttribute("aria-busy", "false");
    }
  });
  cancel.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    const clean = input.value.split(/\s+/).filter(Boolean).join(" ");
    if (!clean) {
      status.textContent = `${label} is required.`;
      input.focus();
      return;
    }
    busy = true;
    confirm.disabled = true;
    status.textContent = "";
    withdraw();
    try {
      pending = submit(clean);
      result = await pending;
      dialog.close("confirm");
    } catch (error) {
      fail(error, clean);
      input.focus();
    } finally { busy = false; }
  });
  document.body.append(dialog);
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => {
      dialog.remove();
      if (returnFocus?.isConnected) returnFocus.focus();
      if (dialog.returnValue === "confirm") resolve(result);
      // Left with Escape, Cancel or a backdrop tap while saving: answer with the save's outcome.
      else if (pending) Promise.resolve(pending).then(resolve, () => resolve(null));
      else resolve(null);
    });
    dialog.showModal();
    input.focus();
    input.select?.();
  });
}

// Offers a few choices, such as a Set's Effort, in the same kind of sheet. Each choice is
// { value, label, name, wide }: name is its accessible name when the label alone is unclear,
// and wide gives it a row of its own. The selected value, or each of an array of them, shows
// as pressed. Resolves with the
// tapped value, or undefined when the user leaves with Cancel, Escape or a backdrop tap.
export function chooseInPage(document, question, { choices, selected = null, hint = "", cancelLabel = "Cancel" }) {
  const returnFocus = document.activeElement;
  const element = (tagName, className, text) =>
    Object.assign(document.createElement(tagName), { className, textContent: text });
  const dialog = element("dialog", "history-dialog confirm-sheet choice-sheet", "");
  const body = element("div", "confirm-body", "");
  const text = element("p", "confirm-question", question);
  text.id = "choice-question";
  dialog.setAttribute("aria-labelledby", text.id);
  body.append(text);
  if (hint) body.append(element("p", "choice-hint", hint));
  const options = element("div", "choice-options", "");
  const pressed = Array.isArray(selected) ? selected : [selected];
  let chosen;
  let focused = null;
  for (const choice of choices) {
    const button = element("button", choice.wide ? "choice-option wide" : "choice-option", choice.label);
    button.type = "button";
    button.setAttribute("aria-pressed", String(pressed.includes(choice.value)));
    if (pressed.includes(choice.value) || !focused) focused = button;
    if (choice.name) button.setAttribute("aria-label", choice.name);
    button.addEventListener("click", () => { chosen = choice.value; dialog.close("choose"); });
    options.append(button);
  }
  const cancel = element("button", "secondary choice-cancel", cancelLabel);
  cancel.type = "button";
  cancel.addEventListener("click", () => dialog.close());
  body.append(options, cancel);
  dialog.append(body);
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  document.body.append(dialog);
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => {
      dialog.remove();
      if (returnFocus?.isConnected) returnFocus.focus();
      resolve(dialog.returnValue === "choose" ? chosen : undefined);
    });
    dialog.showModal();
    (focused ?? cancel).focus();
  });
}
