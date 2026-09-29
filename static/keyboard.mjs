// iOS Safari opens the keyboard over the page without shrinking the layout viewport,
// so a fixed sheet or modal dialog stays partly behind it and cannot scroll its focused
// field into view. The visible area is exposed as --viewport-top and --viewport-bottom
// insets and --viewport-height for sheets and dialogs, and the focused field is re-centred once it changes.
const TYPING = new Set(["INPUT", "TEXTAREA", "SELECT"]);

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
  };
  viewport.addEventListener("resize", () => { update(); centreFocusedField(); });
  viewport.addEventListener("scroll", update);
  document.addEventListener("focusin", centreFocusedField);
  update();
}
