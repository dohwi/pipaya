/**
 * Should a pane that just became the focused one move the keyboard into its input box?
 * Yes, except while the user is walking the tab strip with the arrow keys: that walk opens each tab in turn, and taking the
 * focus on the first step would end it after one press.
 */
export function shouldTakeFocus(active: Pick<Element, "closest"> | null | undefined): boolean {
  return !active?.closest('[role="tablist"]');
}
