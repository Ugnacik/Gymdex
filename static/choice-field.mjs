// A text input that also offers the values entered before. The input always carries the value,
// so a named field submits with its form like a plain input. With known values, a chevron opens
// them as a list below the input, and typing narrows the list; tapping one fills the input.
// iOS in-app browsers show <datalist> suggestions unreliably, so the list is our own.
const escapeHtml = (value) => String(value)
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#039;");

export class ChoiceField {
  // onEnter(picked): called instead of submitting the form when Enter is pressed in the input
  // (picked false), and after a listed value is picked (picked true), so picking can act like
  // typing the value and pressing Enter. value: the text to start with.
  constructor(container, { id, name = "", title, optional = false, placeholder = "", onEnter = null,
    describedBy = "", options = [], value = "" }) {
    Object.assign(this, { container, id, name, title, optional, placeholder, onEnter, describedBy });
    this.render(value ?? "");
    this.setOptions(options);
  }

  get value() {
    return this.input.value.split(/\s+/).filter(Boolean).join(" ");
  }

  // Replaces the offered values; the typed text stays.
  setOptions(options) {
    this.options = [...options];
    this.toggle.hidden = !this.options.length;
    this.input.classList.toggle("has-choices", this.options.length > 0);
    this.close();
  }

  // Empties the input for the next value.
  clear() {
    this.input.value = "";
    this.close();
  }

  focus() {
    this.input.focus();
  }

  render(value) {
    const listId = `${this.id}-list`;
    const attributes = [
      `id="${this.id}"`, this.name && `name="${escapeHtml(this.name)}"`, `maxlength="80" autocomplete="off"`,
      this.placeholder && `placeholder="${escapeHtml(this.placeholder)}"`, `enterkeyhint="${this.onEnter ? "done" : "next"}"`,
      `role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${listId}"`,
      this.describedBy && `aria-describedby="${this.describedBy}"`, `value="${escapeHtml(value)}"`,
    ].filter(Boolean).join(" ");
    this.container.innerHTML = `<label for="${this.id}">${escapeHtml(this.title)}${this.optional ? " <small>(optional)</small>" : ""}</label>
      <div class="choice-entry"><input ${attributes} /><button type="button" class="choice-toggle" id="${this.id}-toggle" aria-label="Show previous values for ${escapeHtml(this.title.toLowerCase())}" aria-expanded="false" aria-controls="${listId}" hidden></button></div>
      <ul class="choice-list" id="${listId}" role="listbox" aria-label="${escapeHtml(this.title)}" hidden></ul>`;
    this.input = this.container.querySelector(`#${this.id}`);
    this.toggle = this.container.querySelector(`#${this.id}-toggle`);
    this.list = this.container.querySelector(`#${listId}`);
    this.open = false;
    this.listed = [];
    // Taps elsewhere close the list; taps inside it must survive the input losing focus first.
    this.closeOutside = (event) => {
      if (!this.container.isConnected) return this.close();
      if (!this.container.contains(event.target)) this.close();
    };
    this.toggle.addEventListener("click", () => {
      // The input keeps its focus state: focusing it would raise the keyboard over the list.
      if (this.open) this.close();
      else this.showList(this.options);
    });
    this.input.addEventListener("input", () => {
      const typed = this.value.toLowerCase();
      const matches = typed ? this.options.filter((option) => option.toLowerCase().includes(typed)) : [];
      // A value typed in full needs no list.
      if (matches.length && !matches.some((option) => option.toLowerCase() === typed)) this.showList(matches);
      else this.close();
    });
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.open) { event.preventDefault(); this.close(); return; }
      if (event.key !== "Enter" || !this.onEnter) return;
      event.preventDefault();
      this.close();
      this.onEnter(false);
    });
    this.list.addEventListener("click", (event) => {
      const option = event.target.closest?.("[data-choice]");
      if (!option) return;
      this.input.value = this.listed[Number(option.dataset.choice)];
      this.close();
      this.onEnter?.(true);
    });
  }

  showList(values) {
    this.listed = values;
    this.list.innerHTML = values.map((value, index) =>
      `<li role="presentation"><button type="button" role="option" aria-selected="false" data-choice="${index}">${escapeHtml(value)}</button></li>`).join("");
    this.list.hidden = false;
    if (!this.open) globalThis.document?.addEventListener("pointerdown", this.closeOutside);
    this.open = true;
    this.setExpanded(true);
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.list.hidden = true;
    this.list.innerHTML = "";
    globalThis.document?.removeEventListener("pointerdown", this.closeOutside);
    this.setExpanded(false);
  }

  setExpanded(expanded) {
    this.input.setAttribute("aria-expanded", String(expanded));
    this.toggle.setAttribute("aria-expanded", String(expanded));
  }
}
