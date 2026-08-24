// ─── Right-click context menu ──────────────────────────
export function showContextMenu(x, y) {
  const menu = document.getElementById("ctx-menu");
  menu.style.display = "block";
  menu.style.left = x + "px";
  menu.style.top = y + "px";
  requestAnimationFrame(() => {
    const r = menu.getBoundingClientRect();
    if (r.right > window.innerWidth) menu.style.left = x - r.width + "px";
    if (r.bottom > window.innerHeight) menu.style.top = y - r.height + "px";
  });
}

export function hideContextMenu() {
  document.getElementById("ctx-menu").style.display = "none";
}
