// The Exercise picker of Exercise progress: the chosen exercise as a button that opens a
// search box over an alphabetical list. Typing narrows the list by any part of the exercise
// and variation names, ignoring case and accents; tapping a match chooses it.
const escapeHtml = (value) => String(value)
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#039;");

// Lower case without accents, so "presse" finds "Pressé" and "CURL" finds "Curl".
export function foldText(value) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

export function sortByName(items, nameOf) {
  return [...items].sort((a, b) => nameOf(a).localeCompare(nameOf(b), undefined, { sensitivity: "base" }) || a.id - b.id);
}

// Every typed word must appear somewhere in the item's texts, in any order.
export function filterByText(items, query, textsOf) {
  const words = foldText(query).split(/\s+/).filter(Boolean);
  if (!words.length) return items;
  return items.filter((item) => {
    const text = foldText(textsOf(item).join(" "));
    return words.every((word) => text.includes(word));
  });
}

export class ExerciseSearch {
  // items: [{ id, name, texts, note }] where texts are searched and note is shown after the name.
  constructor(container, { id, label, items, selectedId = null, onChange = () => {} }) {
    Object.assign(this, { container, id, label, onChange });
    this.items = sortByName(items, (item) => item.name);
    this.selected = this.items.find((item) => item.id === selectedId) ?? this.items[0] ?? null;
    this.open = false;
    this.render();
  }

  get value() { return this.selected ? String(this.selected.id) : ""; }

  render() {
    const { id } = this;
    this.container.innerHTML = `<span class="field-label" id="${id}-label">${escapeHtml(this.label)}</span>
      <button type="button" class="exercise-search-current" id="${id}-current" aria-haspopup="listbox" aria-expanded="false"
        aria-controls="${id}-panel" aria-labelledby="${id}-label ${id}-current">${this.selectedText()}</button>
      <div class="exercise-search-panel" id="${id}-panel" hidden>
        <input type="search" class="search" id="${id}-search" inputmode="search" autocomplete="off" enterkeyhint="done"
          placeholder="Search exercises" aria-label="Search exercises" role="combobox" aria-autocomplete="list"
          aria-expanded="true" aria-controls="${id}-list" />
        <p class="exercise-search-status" id="${id}-status" role="status"></p>
        <ul class="exercise-search-list" id="${id}-list" role="listbox" aria-label="${escapeHtml(this.label)}"></ul>
      </div>`;
    const find = (suffix) => this.container.querySelector(`#${id}-${suffix}`);
    this.current = find("current");
    this.panel = find("panel");
    this.search = find("search");
    this.status = find("status");
    this.list = find("list");
    this.current.addEventListener("click", () => (this.open ? this.close() : this.show()));
    this.search.addEventListener("input", () => this.renderList());
    this.search.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); this.close(true); }
      else if (event.key === "ArrowDown") { event.preventDefault(); this.options()[0]?.focus(); }
      else if (event.key === "Enter") {
        // Enter picks the first match instead of submitting the surrounding form.
        event.preventDefault();
        const first = this.options()[0];
        if (first) this.choose(Number(first.dataset.optionId));
      }
    });
    this.list.addEventListener("click", (event) => {
      const option = event.target.closest?.("[data-option-id]");
      if (option) this.choose(Number(option.dataset.optionId));
    });
    this.list.addEventListener("keydown", (event) => {
      const options = this.options();
      const index = options.indexOf(event.target);
      if (event.key === "Escape") { event.preventDefault(); this.close(true); }
      else if (event.key === "ArrowDown") { event.preventDefault(); options[Math.min(index + 1, options.length - 1)]?.focus(); }
      else if (event.key === "ArrowUp") { event.preventDefault(); (index <= 0 ? this.search : options[index - 1]).focus(); }
    });
  }

  selectedText() {
    if (!this.selected) return "No exercises yet";
    return `${escapeHtml(this.selected.name)}${this.selected.note ? ` <small>${escapeHtml(this.selected.note)}</small>` : ""}`;
  }

  options() { return [...this.list.querySelectorAll("[data-option-id]")]; }

  renderList() {
    const query = this.search.value;
    const matches = filterByText(this.items, query, (item) => item.texts);
    this.list.innerHTML = matches.map((item) => `<li role="presentation"><button type="button" role="option"
      aria-selected="${item === this.selected}" data-option-id="${item.id}">${escapeHtml(item.name)}${item.note ? ` <small>${escapeHtml(item.note)}</small>` : ""}</button></li>`).join("");
    this.status.textContent = matches.length
      ? (query.trim() ? `${matches.length} match${matches.length === 1 ? "" : "es"}` : "")
      : `No exercises match “${query.trim()}”.`;
  }

  show() {
    if (!this.items.length) return;
    this.open = true;
    this.search.value = "";
    this.renderList();
    this.panel.hidden = false;
    this.current.setAttribute("aria-expanded", "true");
    this.search.focus();
  }

  close(returnFocus = false) {
    this.open = false;
    this.panel.hidden = true;
    this.list.innerHTML = "";
    this.current.setAttribute("aria-expanded", "false");
    if (returnFocus) this.current.focus();
  }

  choose(itemId) {
    const item = this.items.find((entry) => entry.id === itemId);
    if (!item) return;
    const changed = item !== this.selected;
    this.selected = item;
    this.current.innerHTML = this.selectedText();
    this.close(true);
    if (changed) this.onChange(item);
  }
}
