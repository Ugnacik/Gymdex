// iOS Safari opens the keyboard over the page without shrinking the layout viewport,
// so a fixed sheet or modal dialog stays partly behind it and cannot scroll its focused
// field into view. The visible area is exposed as --viewport-top and --viewport-bottom
// insets and --viewport-height for sheets and dialogs, and the focused field is re-centred once it changes.
// data-keyboard on the root marks a view shrunk by an on-screen keyboard.
const TYPING = new Set(["INPUT", "TEXTAREA", "SELECT"]);
const KEYBOARD_MIN_HEIGHT = 150;

export function followVisualViewport({ window, document }) {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const root = document.documentElement;
  const centreFocusedField = () => {
    const field = document.activeElement;
    if (!field || !TYPING.has(field.tagName) || !field.closest(".sheet, dialog")) return;
    window.requestAnimationFrame(() => field.scrollIntoView({ block: "center" }));
  };
  const update = () => {
    const bottom = Math.max(0, root.clientHeight - viewport.offsetTop - viewport.height);
    root.style.setProperty("--viewport-top", `${Math.max(0, viewport.offsetTop)}px`);
    root.style.setProperty("--viewport-bottom", `${bottom}px`);
    root.style.setProperty("--viewport-height", `${viewport.height}px`);
    root.toggleAttribute("data-keyboard", root.clientHeight - viewport.height > KEYBOARD_MIN_HEIGHT);
  };
  viewport.addEventListener("resize", () => { update(); centreFocusedField(); });
  viewport.addEventListener("scroll", update);
  document.addEventListener("focusin", centreFocusedField);
  update();
}
