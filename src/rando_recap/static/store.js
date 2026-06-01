// A minimal observable: a value, a set of subscribers, and a notify on change.
// The irreducible core of a reactive store (Pinia/Zustand/Redux) without the
// framework — enough for one view's worth of shared state.
//
// subscribe() fires immediately so a fresh subscriber paints the current value,
// then again on every set(); it returns an unsubscribe the owner calls on
// teardown. State is view-scoped: create one per view, drop it with the view,
// and the subscriber closures (which hold DOM references) go with it.
export function observable(initial) {
  let value = initial;
  const subs = new Set();
  return {
    get: () => value,
    set: (next) => {
      value = next;
      for (const fn of subs) fn(value);
    },
    subscribe: (fn) => {
      subs.add(fn);
      fn(value);
      return () => subs.delete(fn);
    },
  };
}
