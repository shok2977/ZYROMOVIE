/** Reading progress on article pages */
(function () {
  const bar = document.getElementById("blog-read-progress");
  if (!bar) return;

  function update() {
    const el = document.documentElement;
    const max = el.scrollHeight - el.clientHeight;
    const pct = max > 0 ? (el.scrollTop / max) * 100 : 0;
    bar.style.width = `${pct}%`;
  }

  window.addEventListener("scroll", update, { passive: true });
  window.addEventListener("resize", update);
  update();
})();
