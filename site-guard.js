(function () {
  const API_BASE =
    typeof window.ZYRO_API_BASE === "string"
      ? window.ZYRO_API_BASE
      : (() => {
          const { hostname, port, protocol } = window.location;
          if (hostname && hostname !== "localhost" && hostname !== "127.0.0.1") {
            return "";
          }
          if (protocol === "file:" || !hostname) return "http://localhost:3001";
          if (port === "3001") return "";
          return `http://${hostname}:3001`;
        })();

  function isBlogPath(pathname) {
    const p = pathname.replace(/\/$/, "") || "/";
    if (p === "/blog" || p === "/blog.html") return true;
    return /^\/blog\/[^/]+$/i.test(p);
  }

  function shouldGuard(pathname) {
    const p = pathname.toLowerCase();
    if (p.startsWith("/admin")) return false;
    if (isBlogPath(pathname)) return false;
    if (p === "/" || p === "/index.html") return true;
    if (p === "/player.html" || p === "/player-lang.html") return true;
    if (p.startsWith("/player")) return true;
    return /\.html$/i.test(p);
  }

  async function run() {
    const path = window.location.pathname || "/";
    if (!shouldGuard(path)) return;

    try {
      const res = await fetch(`${API_BASE}/api/site/mode`);
      if (!res.ok) return;
      const data = await res.json();
      if (data?.accessMode !== "blogs_only") return;
      const base = API_BASE ? API_BASE.replace(/\/$/, "") : "";
      window.location.replace(`${base}/blog.html`);
    } catch (_) {}
  }

  run();
})();
