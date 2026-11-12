/**
 * When a settings form takes a newly saved value. `draft` is what the form shows, `base` the saved value it was taken
 * from, `next` the value saved now (each as `JSON.stringify` of the form's fields).
 *
 * The form follows unless the user has changed something: the draft is still the value it was taken from, or it already
 * equals the new one (the user's own save came back). Comparing the draft with `next` alone is not enough: a draft that
 * still shows the old value differs from the new one and looked "edited", so a value changed elsewhere (another device,
 * the extension writing its own settings) never reached an open form.
 */
export const followsSaved = (draft: string, base: string, next: string): boolean => draft === base || draft === next;
