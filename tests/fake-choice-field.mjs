// A stand-in for the element a ChoiceField renders into. Like a browser, setting innerHTML
// creates fresh <select> and <input> elements whose value, hidden state and options come
// from the markup, found by querySelector('#id').
const decode = (text) => text.replaceAll('&quot;', '"').replaceAll('&#039;', "'")
  .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');

function element(properties) {
  return { events: {}, focused: false, ...properties,
    addEventListener(event, callback) { this.events[event] = callback; },
    focus() { this.focused = true; } };
}

export function choiceContainer() {
  const parts = new Map();
  let html = '';
  return {
    get innerHTML() { return html; },
    set innerHTML(value) {
      html = value;
      parts.clear();
      for (const [, id, body] of value.matchAll(/<select id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
        const options = [...body.matchAll(/<option value="([^"]*)"([^>]*)>([^<]*)<\/option>/g)]
          .map(([, optionValue, attributes, text]) => ({ value: decode(optionValue), text: decode(text),
            selected: / selected/.test(attributes), disabled: / disabled/.test(attributes) }));
        const selected = options.find((option) => option.selected) ?? options.find((option) => !option.disabled);
        parts.set(`#${id}`, element({ options, value: selected?.value ?? '' }));
      }
      for (const [, attributes] of value.matchAll(/<input([^>]*)>/g)) {
        const id = attributes.match(/ id="([^"]+)"/)?.[1];
        if (!id) continue;
        parts.set(`#${id}`, element({ value: decode(attributes.match(/ value="([^"]*)"/)?.[1] ?? ''),
          hidden: / hidden(?=[ />])/.test(attributes), name: attributes.match(/ name="([^"]+)"/)?.[1] }));
      }
    },
    querySelector: (selector) => parts.get(selector) ?? null,
  };
}

// The user picks an option of a rendered select, as a browser would report it.
export function choose(container, selectId, value) {
  const select = container.querySelector(`#${selectId}`);
  select.value = value;
  select.events.change({ target: select });
}

// The user types into a rendered input.
export function type(container, inputId, value) {
  const input = container.querySelector(`#${inputId}`);
  input.value = value;
  input.events.input?.({ target: input });
}
