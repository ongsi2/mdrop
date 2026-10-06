/** Move keyboard focus to an element that is not normally focusable.
    The temporary tabindex is dropped again on blur so the document's
    tab order is never widened by in-page navigation. */
export function moveFocus(element: HTMLElement): void {
  if (!element.hasAttribute('tabindex')) {
    element.tabIndex = -1;
    element.addEventListener('blur', () => element.removeAttribute('tabindex'), { once: true });
  }
  element.focus({ preventScroll: true });
}
