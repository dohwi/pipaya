/**
 * Should a pane that just became the focused one move the keyboard into its input box?
 * Yes, except while the user is walking the tab strip with the arrow keys (that walk opens each tab in turn, and taking the
 * focus on the first step would end it after one press), and while focus is in a dialog or menu: the conversation restored
 * just after the page loads used to pull the keyboard out of a search box opened meanwhile.
 */
export function shouldTakeFocus(active: Pick<Element, "closest"> | null | undefined): boolean {
  return !active?.closest('[role="tablist"], [role="dialog"], [role="alertdialog"], [role="menu"], dialog[open]');
}
