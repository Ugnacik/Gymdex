// A form field whose value is picked from known values or typed as a new one. Known values
// are a <select> whose last option, Other…, reveals a text input: iOS in-app browsers show
// <datalist> suggestions unreliably. Without known values the field is just the text input.
// The text input always carries the value, hidden while a known value is chosen, so a
// named field submits with its form like a plain input.
export const OTHER = "\u0000other";

const escapeHtml = (value) => String(value)
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#039;");

// Options are strings or { value, disabled, note }; a disabled option is listed but cannot be chosen.
const normalize = (options) => options.map((option) => typeof option === "string" ? { value: option } : option);

export class ChoiceField {
  // empty: label of a first option meaning "no value" (e.g. "None"), or null for none.
  // onEnter: called instead of submitting the form when Enter is pressed in the text input.
  constructor(container, { id, name = "", title, optional = false, empty = null, placeholder = "",
    newLabel = `New ${title.toLowerCase()}`, onEnter = null, describedBy = "", options = [] }) {
    Object.assign(this, { container, id, name, title, optional, empty, placeholder, newLabel, onEnter, describedBy });
    this.choice = null;
    this.picked = false; // whether the user chose this.choice, rather than it being the default
    this.typed = "";
    this.setOptions(options);
  }

  get value() {
    return (this.choice === OTHER ? this.typed : this.choice).split(/\s+/).filter(Boolean).join(" ");
  }

  // Whether the text input is showing, so focus can return to it for the next value.
  get typing() {
    return this.choice === OTHER;
  }

  setOptions(options) {
    this.options = normalize(options);
    const offered = this.options.filter((option) => !option.disabled).map((option) => option.value);
    const kept = this.picked && (this.choice === OTHER || offered.includes(this.choice));
    if (!kept) [this.choice, this.picked] = [this.defaultChoice(offered), false];
    this.render();
  }

  // Back to the default choice with a blank input; typing stays open for the next value.
  clear() {
    this.typed = "";
    if (!this.typing) [this.choice, this.picked] = [this.defaultChoice(), false];
    this.render();
  }

  focus() {
    (this.typing ? this.input : this.select)?.focus();
  }

  defaultChoice(offered = this.options.filter((option) => !option.disabled).map((option) => option.value)) {
    if (!this.options.length) return OTHER;
    if (this.empty !== null) return "";
    return offered[0] ?? OTHER;
  }

  render() {
    const selectId = `${this.id}-choice`;
    const listed = this.options.length > 0;
    const option = (value, text, disabled = false) =>
      `<option value="${escapeHtml(value)}"${value === this.choice ? " selected" : ""}${disabled ? " disabled" : ""}>${escapeHtml(text)}</option>`;
    const select = listed ? `<select id="${selectId}">${[
      this.empty === null ? "" : option("", this.empty),
      ...this.options.map((item) => option(item.value, item.note ? `${item.value} (${item.note})` : item.value, item.disabled)),
      option(OTHER, "Other…"),
    ].join("")}</select>` : "";
    const attributes = [
      `id="${this.id}"`, this.name && `name="${escapeHtml(this.name)}"`, `maxlength="80" autocomplete="off"`,
      this.placeholder && `placeholder="${escapeHtml(this.placeholder)}"`, `enterkeyhint="${this.onEnter ? "done" : "next"}"`,
      listed && `aria-label="${escapeHtml(this.newLabel)}"`, this.describedBy && `aria-describedby="${this.describedBy}"`,
      `value="${escapeHtml(this.choice === OTHER ? this.typed : this.choice)}"`, this.choice !== OTHER && "hidden",
    ].filter(Boolean).join(" ");
    this.container.innerHTML = `<label for="${listed ? selectId : this.id}">${escapeHtml(this.title)}${this.optional ? " <small>(optional)</small>" : ""}</label>${select}<input ${attributes} />`;
    this.select = this.container.querySelector(`#${selectId}`);
    this.input = this.container.querySelector(`#${this.id}`);
    this.select?.addEventListener("change", () => {
      [this.choice, this.picked] = [this.select.value, true];
      this.input.hidden = !this.typing;
      this.input.value = this.typing ? this.typed : this.choice;
      if (this.typing) this.input.focus();
    });
    this.input.addEventListener("input", () => { if (this.typing) [this.typed, this.picked] = [this.input.value, true]; });
    this.input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || !this.onEnter) return;
      event.preventDefault();
      this.onEnter();
    });
  }
}
