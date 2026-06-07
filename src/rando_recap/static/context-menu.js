// Native-style context menu shown at the cursor on click, shared by the map's
// stop markers and the chart's rest bands. Only one can be open at a time (the
// `activeMenu` singleton); it closes on outside click, Escape, or scroll/resize
// (positions go stale).
import { el } from "./utils.js";

let activeMenu = null;

export function closeContextMenu() {
  if (activeMenu) {
    activeMenu.teardown();
    activeMenu = null;
  }
}

export function openContextMenu(originalEvent, items) {
  closeContextMenu();
  const menu = el("div", { class: "context-menu" });
  for (const { label, onSelect } of items) {
    menu.appendChild(
      el(
        "div",
        {
          class: "context-menu-item",
          onclick: () => {
            closeContextMenu();
            onSelect();
          },
        },
        label,
      ),
    );
  }
  document.body.appendChild(menu);

  // Clamp into the viewport so the menu stays on-screen.
  const rect = menu.getBoundingClientRect();
  const x = Math.max(0, Math.min(originalEvent.clientX, window.innerWidth - rect.width - 4));
  const y = Math.max(0, Math.min(originalEvent.clientY, window.innerHeight - rect.height - 4));
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  const onDocDown = (e) => {
    if (!menu.contains(e.target)) closeContextMenu();
  };
  const onKey = (e) => {
    if (e.key === "Escape") closeContextMenu();
  };
  const onMove = () => closeContextMenu();
  // Defer the outside-click binding so the click that opened the menu doesn't
  // immediately close it.
  setTimeout(() => document.addEventListener("mousedown", onDocDown, true), 0);
  document.addEventListener("keydown", onKey);
  window.addEventListener("resize", onMove);
  window.addEventListener("scroll", onMove, true);

  activeMenu = {
    teardown: () => {
      document.removeEventListener("mousedown", onDocDown, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
      menu.remove();
    },
  };
}
