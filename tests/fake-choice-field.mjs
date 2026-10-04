// A stand-in for the element a ChoiceField renders into. Like a browser, setting innerHTML
// creates fresh elements whose value, hidden state and attributes come from the markup, found by
// querySelector('#id'). Setting a list's innerHTML lists its option buttons as `options`.
const decode = (text) => text.replaceAll('&quot;', '"').replaceAll('&#039;', "'")
  .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');

function element(attributes) {
  const classes = new Set((attributes.match(/ class="([^"]*)"/)?.[1] ?? '').split(' ').filter(Boolean));
  let html = '';
  return {
    events: {}, focused: false, options: [],
    value: decode(attributes.match(/ value="([^"]*)"/)?.[1] ?? ''),
    hidden: / hidden(?=[ />]|$)/.test(attributes),
    name: attributes.match(/ name="([^"]+)"/)?.[1],
    attributes: Object.fromEntries([...attributes.matchAll(/ ([a-z-]+)="([^"]*)"/g)].map(([, key, value]) => [key, decode(value)])),
    classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)), contains: (name) => classes.has(name) },
    get innerHTML() { return html; },
    set innerHTML(value) {
      html = value;
      this.options = [...value.matchAll(/data-choice="(\d+)">([^<]*)<\/button>/g)]
        .map(([, index, text]) => ({ index, text: decode(text) }));
    },
    setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener(event, callback) { this.events[event] = callback; },
    focus() { this.focused = true; },
  };
}

export function choiceContainer() {
  const parts = new Map();
  let html = '';
  return {
    isConnected: true,
    contains: () => true,
    get innerHTML() { return html; },
    set innerHTML(value) {
      html = value;
      parts.clear();
      for (const [, attributes] of value.matchAll(/<(?:input|button|ul)([^>]*)>/g)) {
        const id = attributes.match(/ id="([^"]+)"/)?.[1];
        if (id) parts.set(`#${id}`, element(attributes));
      }
    },
    querySelector: (selector) => parts.get(selector) ?? null,
  };
}

// The values the open list of the field with this input id offers; [] while it is closed.
export function listed(container, inputId) {
  const list = container.querySelector(`#${inputId}-list`);
  return list.hidden ? [] : list.options.map((option) => option.text);
}

// The user taps the field's chevron.
export function toggleList(container, inputId) {
  container.querySelector(`#${inputId}-toggle`).events.click();
}

// The user taps a value in the field's open list.
export function pick(container, inputId, text) {
  const list = container.querySelector(`#${inputId}-list`);
  const option = list.options.find((item) => item.text === text);
  if (list.hidden || !option) throw new Error(`${text} is not listed for ${inputId}`);
  list.events.click({ target: { closest: () => ({ dataset: { choice: option.index } }) } });
}

// The user opens the field's list and taps a value in it.
export function choose(container, inputId, text) {
  toggleList(container, inputId);
  pick(container, inputId, text);
}

// The user types into a rendered input.
export function type(container, inputId, value) {
  const input = container.querySelector(`#${inputId}`);
  input.value = value;
  input.events.input?.({ target: input });
}
