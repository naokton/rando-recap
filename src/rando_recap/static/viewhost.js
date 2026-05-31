// The view lifecycle, as a leaf service. Owns the single piece of mounted-view
// state and the single teardown call site: show(component) disposes whatever
// was mounted before and swaps in the new one. Because this is a leaf, any view
// can request a re-render via show() without importing the router.
//
// Every component follows the { el, destroy } contract: `el` is a DOM node
// mounted into #root, `destroy` releases the component's resources (maps,
// listeners, in-flight streams). A view that owns children disposes them in its
// own destroy, so the host only ever disposes one thing — disposal nests down
// the ownership chain.
import { root } from "./utils.js";

let current = null;

export function show(component) {
  if (current) current.destroy(); // the ONLY teardown call site
  current = component;
  root.replaceChildren(component.el);
}
