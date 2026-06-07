// The view lifecycle, as a leaf service: show(component) disposes whatever was
// mounted before and swaps in the new one. Being a leaf, any view can request a
// re-render via show() without importing the router.
//
// Every component follows the { el, destroy } contract: `el` is a DOM node
// mounted into #root, `destroy` releases its resources (maps, listeners,
// in-flight streams). A view that owns children disposes them in its own
// destroy, so the host only ever disposes one thing.
import { root } from "./utils.js";

let current = null;

export function show(component) {
  if (current) current.destroy();
  current = component;
  root.replaceChildren(component.el);
}
