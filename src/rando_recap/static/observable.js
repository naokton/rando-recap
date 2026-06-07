// A minimal observable: a value, its subscribers, and a notify on change —
// enough shared reactive state for one view, without a framework.
//
// subscribe() fires immediately so a fresh subscriber paints the current value,
// then again on every set(); it returns an unsubscribe for teardown. State is
// view-scoped: create one per view and drop it with the view, so the subscriber
// closures (which hold DOM references) go too.
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
