// The route's split points as a reactive store: a sorted-ascending list of
// interior-stop indices ([] = single-map mode). The map markers, the per-pane
// ✕, and the Stops-table checkboxes all mutate the same store; the map, the
// timeline, and the tables each subscribe and update their own DOM. This is the
// single source of truth that used to live in a buildMapArea closure and be
// pushed into sibling DOM by hand.
import { observable } from "./store.js";

export function createSplits() {
  const store = observable([]);
  const has = (i) => store.get().includes(i);
  const withSorted = (i) => [...store.get(), i].sort((a, b) => a - b);
  return {
    get: store.get,
    subscribe: store.subscribe,
    // Idempotent — the map menu's "Split here" may fire on an existing split.
    add: (i) => {
      if (!has(i)) store.set(withSorted(i));
    },
    remove: (i) => store.set(store.get().filter((x) => x !== i)),
    toggle: (i) => store.set(has(i) ? store.get().filter((x) => x !== i) : withSorted(i)),
  };
}
