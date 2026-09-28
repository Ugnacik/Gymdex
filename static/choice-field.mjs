// A form field whose value is picked from known values or typed as a new one. Known values
// are a <select> whose last option, Other…, reveals a text input: iOS in-app browsers show
// <datalist> suggestions unreliably. Without known values the field is just the text input.
// The text input always carries the value, hidden while a known value is chosen, so a
// named field submits with its form like a plain input.
// Known values are whitespace-collapsed, so none starts with a space: the Other… option's value
// cannot collide with one. (A NUL character would not survive HTML parsing.)
export const OTHER = " other";

const escapeHtml = (value) => String(value)
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#039;");

export class ChoiceField {
  // empty: label of a first option meaning "no value" (e.g. "None"), or null for none.
  // onEnter: called instead of submitting the form when Enter is pressed in the text input.
  // value: the value to start with, chosen when listed and typed under Other… otherwise;
  // "" starts on the empty option. Without one the field starts on its default choice.
  constructor(container, { id, name = "", title, optional = false, empty = null, placeholder = "",
    newLabel = `New ${title.toLowerCase()}`, onEnter = null, describedBy = "", options = [], value = null }) {
    Object.assign(this, { container, id, name, title, optional, empty, placeholder, newLabel, onEnter, describedBy });
    this.choice = null;
    this.picked = false; // whether the user chose this.choice, rather than it being the default
    this.typed = "";
    if (value !== null && (value !== "" || empty !== null)) {
      const listed = value === "" || options.includes(value);
      [this.choice, this.typed, this.picked] = listed ? [value, "", true] : [OTHER, value, true];
    }
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
    this.options = [...options];
    const kept = this.picked && (this.choice === OTHER || this.options.includes(this.choice));
    if (!kept) [this.choice, this.picked] = [this.defaultChoice(), false];
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

  defaultChoice() {
    if (!this.options.length) return OTHER;
    return this.empty !== null ? "" : this.options[0];
  }

  render() {
    const selectId = `${this.id}-choice`;
    const listed = this.options.length > 0;
    const option = (value, text) =>
      `<option value="${escapeHtml(value)}"${value === this.choice ? " selected" : ""}>${escapeHtml(text)}</option>`;
    const select = listed ? `<select id="${selectId}">${[
      this.empty === null ? "" : option("", this.empty),
      ...this.options.map((value) => option(value, value)),
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
