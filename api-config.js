/** Shared API base for all front-end pages (local dev + production). */
(function () {
  function getApiBase() {
    const { hostname, port, protocol } = window.location;
    if (
      hostname &&
      hostname !== "localhost" &&
      hostname !== "127.0.0.1"
    ) {
      return "";
    }
    if (protocol === "file:" || !hostname) {
      return "http://localhost:3001";
    }
    if (port === "3001") {
      return "";
    }
    return `http://${hostname}:3001`;
  }

  window.ZYRO_API_BASE = getApiBase();
})();
