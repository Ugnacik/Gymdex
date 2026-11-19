// A stand-in for the element an ExerciseSearch renders into. Setting innerHTML creates fresh
// elements found by querySelector('#id'); the list's options come from its own innerHTML.
const decode = (text) => text.replaceAll('&quot;', '"').replaceAll('&#039;', "'")
  .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
const strip = (html) => decode(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

function element(attributes, focusLog) {
  let html = '';
  const self = {
    events: {}, value: '', options: [], id: attributes.match(/ id="([^"]+)"/)?.[1],
    hidden: / hidden(?=[ />]|$)/.test(attributes),
    attributes: Object.fromEntries([...attributes.matchAll(/ ([a-z-]+)="([^"]*)"/g)].map(([, key, value]) => [key, decode(value)])),
    get innerHTML() { return html; },
    set innerHTML(value) {
      html = value;
      self.options = [...value.matchAll(/<button([^>]*data-option-id="(\d+)"[^>]*)>([\s\S]*?)<\/button>/g)].map(([, attrs, id, text]) => ({
        dataset: { optionId: id }, text: strip(text), selected: /aria-selected="true"/.test(attrs),
        focus() { focusLog.push(this); }, closest(selector) { return selector === '[data-option-id]' ? this : null; },
      }));
    },
    get textContent() { return strip(html); },
    set textContent(value) { html = String(value); },
    setAttribute(key, value) { self.attributes[key] = String(value); },
    addEventListener(event, callback) { self.events[event] = callback; },
    querySelectorAll: () => self.options,
    focus() { focusLog.push(self); },
  };
  return self;
}

export function searchContainer() {
  const parts = new Map();
  const focusLog = [];
  let html = '';
  return {
    focusLog,
    get focused() { return focusLog.at(-1); },
    get innerHTML() { return html; },
    set innerHTML(value) {
      html = value;
      parts.clear();
      for (const [, tag, attributes, inner] of value.matchAll(/<(button|input|p|ul|div|span)([^>]*)>(?:([^<]*)<\/\1>)?/g)) {
        const id = attributes.match(/ id="([^"]+)"/)?.[1];
        if (!id) continue;
        const item = element(attributes, focusLog);
        if (tag !== 'input' && inner) item.innerHTML = inner;
        parts.set(`#${id}`, item);
      }
      const current = value.match(/<button[^>]*id="([^"]+-current)"[^>]*>([\s\S]*?)<\/button>/);
      if (current) parts.get(`#${current[1]}`).innerHTML = current[2];
    },
    querySelector: (selector) => parts.get(selector) ?? null,
  };
}

// The user types into the open search box.
export function typeSearch(container, id, text) {
  const search = container.querySelector(`#${id}-search`);
  search.value = text;
  search.events.input();
}

export const shown = (container, id) => container.querySelector(`#${id}-list`).options.map((option) => option.text);

export function tapOption(container, id, text) {
  const option = container.querySelector(`#${id}-list`).options.find((item) => item.text === text);
  if (!option) throw new Error(`${text} is not listed`);
  container.querySelector(`#${id}-list`).events.click({ target: option });
}
