const TEXTAREA_MAX_ROWS = 6;

export function resizeComposerTextarea(el: HTMLTextAreaElement | null): void {
  if (!el) return;
  const style = getComputedStyle(el);
  const fontSize = parseFloat(style.fontSize) || 14;
  const lineHeight = Number.isFinite(parseFloat(style.lineHeight))
    ? parseFloat(style.lineHeight)
    : fontSize * 1.5;
  const paddingTop = parseFloat(style.paddingTop) || 0;
  const paddingBottom = parseFloat(style.paddingBottom) || 0;
  const maxHeight = lineHeight * TEXTAREA_MAX_ROWS + paddingTop + paddingBottom;
  el.style.height = "auto";
  const nextHeight = Math.min(el.scrollHeight, maxHeight);
  el.style.height = `${nextHeight}px`;
  el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
}
