const ADMIN_ID = "Adityasharma123";
const ADMIN_PASSWORD = "Aditya@sharma2977";
const TMDB_API_KEY = "e84730516a1d5987f96fd63d46d2f119";

const API_BASE =
  typeof window.ZYRO_API_BASE === "string"
    ? window.ZYRO_API_BASE
    : window.location.hostname === "localhost" ||
        window.location.hostname === "127.0.0.1"
      ? "http://localhost:3001"
      : "";
let cachedData = { movies: {}, lists: {}, banners: [], listOrder: [] };
const LOCAL_STORAGE_KEY = "flakes_movies_data";

function apiUrl(path) {
  const p = String(path || "").startsWith("/") ? path : `/${path}`;
  return `${API_BASE}${p}`;
}

async function adminFetch(path, options = {}, timeoutMs = 90000) {
  const url = String(path).startsWith("http") ? path : apiUrl(path);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error("Request timed out — please try again.");
    }
    const msg = String(err?.message || err);
    if (msg === "Failed to fetch" || /networkerror|load failed/i.test(msg)) {
      const hint = API_BASE || window.location.origin;
      throw new Error(
        `Could not connect to the server (${hint}). Run "node server.js" in the terminal, then open ${hint}/admin/ in the browser — do not open via file://.`
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function refreshData() {
  const res = await adminFetch("/api/data");
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      payload.error ||
        `Could not load data from the API (HTTP ${res.status}). Open: ${API_BASE || window.location.origin}/admin/`
    );
  }
  cachedData = payload;
  // Normalize shape
  cachedData.movies = cachedData.movies || {};
  cachedData.lists = cachedData.lists || {};
  cachedData.banners = cachedData.banners || [];
  cachedData.listOrder = Array.isArray(cachedData.listOrder)
    ? cachedData.listOrder
    : [];
  return cachedData;
}

function loadMovieData() {
  return cachedData;
}

/** Same as home page: these names are auto-generated for Random rows, not real DB lists. */
function isReservedRandomListName(name) {
  const t = String(name || "").trim();
  if (/^Random$/i.test(t)) return true;
  if (/^Random\s+\d+$/i.test(t)) return true;
  return false;
}

function getOrderedCustomListNames(data) {
  const listsObj = data.lists || {};
  const custom = Object.keys(listsObj).filter(
    (n) => !isReservedRandomListName(n)
  );
  const apiOrder = Array.isArray(data.listOrder) ? data.listOrder : [];
  const ordered = [];
  apiOrder.forEach((n) => {
    if (custom.includes(n)) ordered.push(n);
  });
  custom
    .filter((n) => !ordered.includes(n))
    .sort((a, b) => a.localeCompare(b))
    .forEach((n) => ordered.push(n));
  return ordered;
}

async function upsertMovie(movie) {
  const res = await adminFetch("/api/movie", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(movie),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      data.error || `Movie save failed (HTTP ${res.status}). Check the server and MongoDB connection.`
    );
  }
  return data;
}

async function deleteMovie(key) {
  const res = await adminFetch(`/api/movie/${encodeURIComponent(key)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Failed to delete movie");
  return await res.json();
}

async function upsertList(name) {
  const res = await adminFetch("/api/list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `List save failed (HTTP ${res.status})`);
  }
  return data;
}

async function deleteList(name) {
  const trimmed = String(name || "").trim();
  const res = await adminFetch("/api/list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: trimmed, action: "delete" }),
  });
  const raw = await res.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch (_) {}
  if (!res.ok) {
    const routeMissing =
      res.status === 404 && !data.error && /cannot post/i.test(raw);
    throw new Error(
      data.error ||
        (routeMissing
          ? "Server is running old code. Press Ctrl+C in the terminal, then run: node server.js — /api/health should show listDelete: true."
          : `List delete failed (HTTP ${res.status})`)
    );
  }
  return data;
}

async function assignMovieToList(name, key) {
  const res = await adminFetch("/api/list/assign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, key }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Assign to list failed (HTTP ${res.status})`);
  }
  return data;
}

async function reorderListsApi(order) {
  const res = await fetch(`${API_BASE}/api/lists/reorder`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order }),
  });
  if (!res.ok) throw new Error("Failed to save list order");
  return await res.json();
}

async function addBanner(payload) {
  const res = await fetch(`${API_BASE}/api/banner`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("Failed to add banner");
  return await res.json();
}

async function deleteBanner(id) {
  const res = await fetch(`${API_BASE}/api/banner/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Failed to delete banner");
  return await res.json();
}

async function fetchLocalAds() {
  const res = await fetch(`${API_BASE}/api/local-ads`);
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

async function createLocalAd(payload) {
  const res = await adminFetch(
    "/api/local-ads",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    180000
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(
        "Local ads API not found (404). Stop the old server and run: node server.js — then open http://localhost:3001/admin/"
      );
    }
    throw new Error(data?.error || `Failed to upload local ad (HTTP ${res.status})`);
  }
  return data;
}

async function updateLocalAd(id, payload) {
  const res = await fetch(`${API_BASE}/api/local-ads/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("Failed to update local ad");
  return res.json();
}

async function deleteLocalAd(id) {
  const res = await fetch(`${API_BASE}/api/local-ads/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Failed to delete local ad");
}

function resolveAdminAssetUrl(url) {
  if (!url) return "";
  const value = String(url);
  if (value.startsWith("data:") || value.startsWith("http")) return value;
  return `${API_BASE}${value}`;
}

async function uploadBlogImage(dataUrl) {
  const res = await fetch(`${API_BASE}/api/blog/upload-image`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dataUrl }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Failed to upload image");
  return data.url;
}

async function addBlog(payload) {
  const res = await fetch(`${API_BASE}/api/blog`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Failed to add blog");
  return data;
}

async function fetchBlogs() {
  const res = await fetch(`${API_BASE}/api/blogs`);
  if (!res.ok) throw new Error("Failed to load blogs");
  return await res.json();
}

async function deleteBlog(id) {
  const res = await fetch(`${API_BASE}/api/blog/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Failed to delete blog");
  return await res.json();
}

async function maybeMigrateLocalToApi() {
  // Only migrate when API is empty, so we don't duplicate data.
  const apiMoviesCount = Object.keys(cachedData.movies || {}).length;
  if (apiMoviesCount > 0) return;

  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    const localMovies = parsed.movies || {};
    const localLists = parsed.lists || {};
    const localBanners = Array.isArray(parsed.banners) ? parsed.banners : [];

    const movieKeys = Object.keys(localMovies);
    for (const k of movieKeys) {
      const m = localMovies[k];
      if (m && m.key) {
        await upsertMovie(m);
      }
    }

    const listNames = Object.keys(localLists);
    for (const name of listNames) {
      await upsertList(name);
      const keys = Array.isArray(localLists[name]) ? localLists[name] : [];
      for (const key of keys) {
        await assignMovieToList(name, key);
      }
    }

    for (const b of localBanners) {
      await addBanner({
        title: b.title || "",
        description: b.description || "",
        tmdbId: String(b.tmdbId || ""),
        contentType: b.contentType || "movie",
        imageDataUrl: b.imageDataUrl || "",
        createdAt: b.createdAt || Date.now(),
      });
    }

    await refreshData();
  } catch (e) {
    console.error("Local-to-API migration failed", e);
  }
}

function getMovieIdKey(tmdbId, type) {
  return `${type}-${tmdbId}`;
}

async function ensureDefaultListsInApi() {
  const defaults = ["Anime", "New Releases", "Hidden Gems", "Best", "Top 10"];
  const data = loadMovieData();
  await Promise.all(
    defaults.map(async (name) => {
      if (!data.lists || !data.lists[name]) {
        await upsertList(name);
      }
    })
  );
  await refreshData();
}

function setAuth(state) {
  if (state) sessionStorage.setItem("flakes_admin_auth", "1");
  else sessionStorage.removeItem("flakes_admin_auth");
}

function isAuthed() {
  return sessionStorage.getItem("flakes_admin_auth") === "1";
}

function switchSection(targetId) {
  document.querySelectorAll(".admin-section").forEach((s) => {
    s.classList.toggle("admin-section-active", s.id === targetId);
  });
  document.querySelectorAll(".admin-nav-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-section") === targetId);
  });
}

function renderDashboard() {
  const data = loadMovieData();
  const totalTitlesEl = document.getElementById("stat-total-titles");
  const totalListsEl = document.getElementById("stat-total-lists");
  const recentListEl = document.getElementById("admin-recent-list");

  const movieKeys = Object.keys(data.movies);
  const listNames = Object.keys(data.lists).filter(
    (n) => !isReservedRandomListName(n)
  );

  if (totalTitlesEl) totalTitlesEl.textContent = movieKeys.length;
  if (totalListsEl) totalListsEl.textContent = listNames.length;

  if (!recentListEl) return;
  recentListEl.innerHTML = "";

  if (movieKeys.length === 0) {
    recentListEl.innerHTML =
      '<p class="admin-empty">No titles added yet. Add your first movie, anime or TV show.</p>';
    return;
  }

  const table = document.createElement("div");
  table.className = "admin-table-inner";
  const header = document.createElement("div");
  header.className = "admin-table-row admin-table-header";
  header.innerHTML = `
    <div>Title</div>
    <div>Type</div>
    <div>TMDB ID</div>
    <div>Seasons/Episodes</div>
    <div></div>
  `;
  table.appendChild(header);

  const recentKeys = movieKeys.slice(-10).reverse();
  recentKeys.forEach((key) => {
    const m = data.movies[key];
    let epInfo = "-";
    if ((m.type === "tv" || m.type === "anime") && m.seasons && m.seasons.length) {
      const total = m.seasons.reduce((s, x) => s + (x.episodes ? x.episodes.length : 0), 0);
      epInfo = `${m.seasons.length} S · ${total} E`;
    }
    const row = document.createElement("div");
    row.className = "admin-table-row";
    row.innerHTML = `
      <div>${m.title || "Untitled"}</div>
      <div>${m.type || "-"}</div>
      <div>${m.tmdbId || "-"}</div>
      <div>${epInfo}</div>
      <div>
        <button class="admin-secondary-btn admin-edit-btn" data-key="${key}">Edit</button>
        <button class="admin-delete-btn" data-key="${key}">Delete</button>
      </div>
    `;
    table.appendChild(row);
  });
  recentListEl.appendChild(table);
}

let currentEditMovieKey = null;
let currentDownloadEpisodesSeasons = null;
let currentDownloadEpisodesTmdb = null;

function episodeKey(seasonNumber, episodeNumber) {
  return `s${seasonNumber}_e${episodeNumber}`;
}

function buildLanguageRow(lang, options = {}) {
  const { showScript = true, langIndex, includeEpisodesPlaceholder = false } = options;
  const row = document.createElement("div");
  row.className = "admin-language-row";
  if (langIndex !== undefined && langIndex !== null) {
    row.dataset.langIndex = String(langIndex);
  }
  const safeName = lang?.name
    ? String(lang.name).replace(/"/g, "&quot;")
    : "";
  const scriptHtml = showScript
    ? `
      <textarea
        class="admin-input edit-lang-script"
        placeholder="Paste Fluid Player embed script for this language"
        rows="4"
      ></textarea>
    `
    : "";

  const episodesPlaceholderHtml = includeEpisodesPlaceholder
    ? `<div class="admin-language-episodes" data-lang-episodes="1"></div>`
    : "";

  row.innerHTML = `
    <div class="admin-language-fields">
      <input
        type="text"
        class="admin-input edit-lang-name"
        placeholder="Language name (e.g. Hindi)"
        value="${safeName}"
      />
      ${scriptHtml}
      ${episodesPlaceholderHtml}
    </div>
    <div class="admin-language-actions">
      <button type="button" class="admin-delete-btn edit-lang-remove">Remove</button>
    </div>
  `;

  if (showScript) {
    const textarea = row.querySelector(".edit-lang-script");
    if (textarea) textarea.value = lang?.script || "";
  }
  return row;
}

function openEditMovie(key) {
  const data = loadMovieData();
  const movie = data.movies[key];
  if (!movie) return;

  currentEditMovieKey = key;

  const titleEl = document.getElementById("edit-movie-title");
  const listEl = document.getElementById("edit-movie-languages");
  const editLangAddBtnEl = document.getElementById("edit-movie-add-language");
  const isDownloadSource = movie.sourceKind === "download";
  // Treat as series (show per-episode Fluid code fields) if seasons exist.
  const isDownloadSeries =
    Array.isArray(movie.seasons) && movie.seasons.length;

  if (titleEl) {
    titleEl.textContent = movie.title || "Untitled";
  }
  // Open edit section immediately so UI never looks "dead" even if deeper render fails.
  switchSection("dashboard-section"); // ensure valid sections exist
  switchSection("edit-movie-section");

  if (listEl) {
    listEl.style.display = isDownloadSource ? "" : "none";
    if (editLangAddBtnEl) editLangAddBtnEl.style.display = isDownloadSource ? "" : "none";
    listEl.innerHTML = "";
    if (!isDownloadSource) {
      // No language editor for non-download sources.
      const info = document.createElement("p");
      info.className = "admin-help-text";
      info.textContent = "Language/Fluid edit is available only for downloads source titles.";
      listEl.appendChild(info);
      listEl.style.display = "";
      if (editLangAddBtnEl) editLangAddBtnEl.style.display = "none";
    }
    if (isDownloadSource) {
      const langs = Array.isArray(movie.languages) ? movie.languages : [];
      if (!langs.length) {
        if (isDownloadSeries) {
          // Series downloads always need at least "Original" language.
          listEl.appendChild(
            buildLanguageRow(
              { name: "Original" },
              { showScript: false, langIndex: 0, includeEpisodesPlaceholder: true }
            )
          );
        } else {
          const info = document.createElement("p");
          info.className = "admin-help-text";
          info.textContent =
            'No extra languages yet. Click "Add language" to create one.';
          listEl.appendChild(info);
        }
      } else {
        langs.forEach((lang, langIndex) => {
          listEl.appendChild(
            buildLanguageRow(lang, {
              showScript: !isDownloadSeries,
              langIndex,
              includeEpisodesPlaceholder: isDownloadSeries,
            })
          );
        });
      }
    }
  }

  // Render per-episode Fluid codes for downloads TV/Anime
  const episodesTitle = document.getElementById("edit-episodes-title");
  const episodesHelp = document.getElementById("edit-episodes-help");
  const episodesContainer = document.getElementById("edit-download-episodes");
  if (episodesTitle && episodesHelp && episodesContainer) {
    if (isDownloadSource && isDownloadSeries) {
      // For series downloads: hide the shared episodes section and render episodes under each language row.
      episodesTitle.style.display = "none";
      episodesHelp.style.display = "none";
      episodesContainer.style.display = "none";
      episodesContainer.innerHTML = "";

      try {
        rebuildDownloadEpisodesInputs(movie);
      } catch (err) {
        console.error("Failed to render episode editors:", err);
      }
    } else {
      episodesTitle.style.display = "none";
      episodesHelp.style.display = "none";
      episodesContainer.innerHTML = "";
      episodesContainer.style.display = "none";
    }
  }
}

function renderLists() {
  const data = loadMovieData();
  const listsTable = document.getElementById("lists-table");
  const assignListSelect = document.getElementById("assign-list");
  if (!listsTable || !assignListSelect) return;

  listsTable.innerHTML = "";
  populateAssignListSelect(data);

  const note = document.createElement("p");
  note.className = "admin-help-text";
  note.style.marginBottom = "12px";
  note.textContent =
    '"Random" / "Random 2" … always appear at the bottom of the home page — all titles there (10 per row, shuffled). Set numbers below: 1 = top list (above Random rows).';
  listsTable.appendChild(note);

  const listNames = getOrderedCustomListNames(data);
  if (listNames.length === 0) {
    const empty = document.createElement("p");
    empty.className = "admin-empty";
    empty.textContent =
      'No custom lists yet. Create one above with "New list" (e.g. Anime, Best) — then add titles.';
    listsTable.appendChild(empty);
    return;
  }

  const table = document.createElement("div");
  table.className = "admin-table-inner admin-lists-order-table";
  const header = document.createElement("div");
  header.className = "admin-table-row admin-table-header";
  header.innerHTML = `<div>Position #</div><div>List name</div><div>Titles</div><div>Actions</div>`;
  table.appendChild(header);

  listNames.forEach((name, idx) => {
    const count = (data.lists[name] || []).length;
    const row = document.createElement("div");
    row.className = "admin-table-row";

    const posCell = document.createElement("div");
    const posInput = document.createElement("input");
    posInput.type = "number";
    posInput.min = "1";
    posInput.max = "999";
    posInput.className = "admin-input admin-list-order-input";
    posInput.dataset.listName = name;
    posInput.value = String(idx + 1);
    posInput.title = "Home page order (1 = top, under banner)";
    posCell.appendChild(posInput);

    const nameCell = document.createElement("div");
    nameCell.textContent = name;

    const countCell = document.createElement("div");
    countCell.textContent = String(count);

    const actionCell = document.createElement("div");
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "admin-delete-btn";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", async () => {
      const msg =
        count > 0
          ? `Delete list "${name}"? Its ${count} title(s) will stay on the site — only the list is removed.`
          : `Delete list "${name}"?`;
      if (!confirm(msg)) return;
      try {
        await deleteList(name);
        await refreshData();
        renderLists();
        renderDashboard();
      } catch (e) {
        console.error(e);
        alert(e?.message || "Could not delete list.");
      }
    });
    actionCell.appendChild(delBtn);

    row.appendChild(posCell);
    row.appendChild(nameCell);
    row.appendChild(countCell);
    row.appendChild(actionCell);
    table.appendChild(row);
  });
  listsTable.appendChild(table);
  populateAssignListSelect(data);

  const saveOrderBtn = document.createElement("button");
  saveOrderBtn.type = "button";
  saveOrderBtn.className = "admin-primary-btn";
  saveOrderBtn.style.marginTop = "14px";
  saveOrderBtn.textContent = "Save list positions (1, 2, 3…)";
  saveOrderBtn.addEventListener("click", async () => {
    const inputs = listsTable.querySelectorAll(".admin-list-order-input");
    const pairs = [];
    inputs.forEach((inp) => {
      const n = inp.dataset.listName;
      let pos = parseInt(inp.value, 10);
      if (!Number.isFinite(pos) || pos < 1) pos = 999;
      pairs.push({ name: n, pos });
    });
    pairs.sort(
      (a, b) => a.pos - b.pos || String(a.name).localeCompare(String(b.name))
    );
    const order = pairs.map((p) => p.name);
    try {
      await reorderListsApi(order);
      await refreshData();
      renderLists();
      alert("List order saved.");
    } catch (e) {
      console.error(e);
      alert("Could not save order. Is the server running?");
    }
  });
  listsTable.appendChild(saveOrderBtn);
}

function renderBanners() {
  const data = loadMovieData();
  const bannersListEl = document.getElementById("banners-list");
  if (!bannersListEl) return;

  const banners = Array.isArray(data.banners) ? data.banners : [];
  bannersListEl.innerHTML = "";

  if (!banners.length) {
    bannersListEl.innerHTML =
      '<p class="admin-empty">No banners added yet. Add your first banner above.</p>';
    return;
  }

  banners.forEach((b) => {
    const row = document.createElement("div");
    row.className = "admin-table-row";
    row.style.alignItems = "center";

    const imgCell = document.createElement("div");
    imgCell.style.display = "flex";
    imgCell.style.gap = "10px";
    imgCell.style.alignItems = "center";

    const img = document.createElement("img");
    img.src = b.imageDataUrl || "";
    img.alt = b.title || "Banner";
    img.style.width = "120px";
    img.style.height = "60px";
    img.style.objectFit = "cover";
    img.style.borderRadius = "8px";

    const meta = document.createElement("div");
    meta.innerHTML = `
      <div style="font-weight: 700;">${b.title || ""}</div>
      <div style="color: #b3b3b3; font-size: 12px; margin-top: 2px;">
        ${b.contentType || ""} · TMDB ${b.tmdbId || ""}
      </div>
    `;
    imgCell.appendChild(img);
    imgCell.appendChild(meta);

    const descCell = document.createElement("div");
    descCell.style.fontSize = "12px";
    descCell.style.color = "#dcdcdc";
    descCell.textContent = (b.description || "").slice(0, 80);

    const actionCell = document.createElement("div");
    actionCell.style.display = "flex";
    actionCell.style.justifyContent = "flex-end";

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "admin-delete-btn";
    delBtn.textContent = "Delete";
    delBtn.dataset.bannerId = b.id || b._id;
    actionCell.appendChild(delBtn);

    row.appendChild(imgCell);
    row.appendChild(descCell);
    row.appendChild(document.createElement("div"));
    row.appendChild(document.createElement("div"));
    row.appendChild(actionCell);

    bannersListEl.appendChild(row);
  });
}

async function renderLocalAds() {
  const listEl = document.getElementById("local-ads-list");
  if (!listEl) return;

  listEl.innerHTML = '<p class="admin-small">Loading local ads...</p>';
  const ads = await fetchLocalAds();
  listEl.innerHTML = "";

  if (!ads.length) {
    listEl.innerHTML =
      '<p class="admin-empty">No local ads yet. Upload your first video ad above.</p>';
    return;
  }

  ads.forEach((ad) => {
    const id = ad._id || ad.id;
    const maxPlays = Math.max(1, Number(ad.maxPlays) || 1);
    const playCount = Math.max(0, Number(ad.playCount) || 0);
    const remaining = Math.max(0, maxPlays - playCount);
    const exhausted = playCount >= maxPlays;
    const active = ad.active !== false;
    const hasSkip =
      ad.allowSkip === true ||
      (ad.skipOffsetSeconds != null &&
        ad.skipOffsetSeconds !== "" &&
        Number.isFinite(Number(ad.skipOffsetSeconds)));
    const skipSec = hasSkip ? Number(ad.skipOffsetSeconds ?? 5) : 5;
    const skipLabel = hasSkip
      ? `Skip: after ${skipSec}s`
      : "Skip: off (no button on player)";
    const skipModeVal = hasSkip ? "after" : "none";
    const videoSrc = resolveAdminAssetUrl(ad.videoUrl || "");

    const row = document.createElement("div");
    row.className = "admin-table-row";
    row.style.alignItems = "center";

    row.innerHTML = `
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
        <video src="${videoSrc.replace(/"/g, "&quot;")}" muted playsinline preload="metadata" style="width:160px;height:90px;object-fit:cover;border-radius:8px;background:#111;"></video>
        <div>
          <div style="font-weight:700;">${(ad.title || "Local ad").replace(/</g, "&lt;")}</div>
          <div style="color:#b3b3b3;font-size:12px;margin-top:4px;">
            Plays: ${playCount} / ${maxPlays} · Remaining: ${remaining}
            ${exhausted ? " · <span style='color:#ff9f43'>Limit reached (VAST will run)</span>" : ""}
          </div>
          <div style="color:#9a9a9a;font-size:12px;margin-top:2px;">
            ${active ? "Active" : "Paused"} · ${skipLabel}${
              ad.clickThroughUrl
                ? ` · Click: ${String(ad.clickThroughUrl).slice(0, 40)}`
                : ""
            }
          </div>
        </div>
      </div>
      <div></div>
      <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;">
        <button type="button" class="admin-secondary-btn local-ad-toggle-btn" data-ad-id="${id}" data-active="${active ? "1" : "0"}">
          ${active ? "Pause" : "Resume"}
        </button>
        <button type="button" class="admin-delete-btn local-ad-delete-btn" data-ad-id="${id}">Delete</button>
      </div>
    `;

    listEl.appendChild(row);

    const skipSlot = row.children[1];
    if (skipSlot) {
      skipSlot.style.display = "flex";
      skipSlot.style.flexDirection = "column";
      skipSlot.style.gap = "8px";
      skipSlot.style.minWidth = "200px";
      skipSlot.innerHTML = `
        <select class="admin-input local-ad-skip-mode-edit" data-ad-id="${id}" style="font-size:12px;padding:6px;">
          <option value="none"${skipModeVal === "none" ? " selected" : ""}>Skip band</option>
          <option value="after"${skipModeVal === "after" ? " selected" : ""}>Skip allowed</option>
        </select>
        <input type="number" class="admin-input local-ad-skip-sec-edit" data-ad-id="${id}" min="0" max="600" value="${skipSec}" style="width:100%;font-size:12px;padding:6px;" />
        <button type="button" class="admin-secondary-btn local-ad-save-skip-btn" data-ad-id="${id}" style="font-size:12px;">Save skip settings</button>
      `;
    }
  });
}

function getBlogPreviewText(blog) {
  if (blog?.description) return blog.description;
  const sections = Array.isArray(blog?.sections) ? blog.sections : [];
  for (const section of sections) {
    if (section?.textBefore) return section.textBefore;
    if (section?.textAfter) return section.textAfter;
  }
  return blog?.overview || "";
}

async function renderBlogs() {
  const blogsListEl = document.getElementById("blogs-list");
  if (!blogsListEl) return;
  blogsListEl.innerHTML = "";

  let blogs = [];
  try {
    blogs = await fetchBlogs();
  } catch (e) {
    blogsListEl.innerHTML =
      '<p class="admin-empty">Failed to load blogs. Is the server running?</p>';
    return;
  }

  if (!blogs.length) {
    blogsListEl.innerHTML = '<p class="admin-empty">No blogs created yet.</p>';
    return;
  }

  blogs.forEach((blog) => {
    const row = document.createElement("div");
    row.className = "admin-table-row";
    row.innerHTML = `
      <div>${blog.title || "Untitled"}</div>
      <div>TMDB ${blog.tmdbId || "-"}</div>
      <div>${getBlogPreviewText(blog).slice(0, 90)}</div>
      <div>${Array.isArray(blog.sections) ? blog.sections.length : 0} section(s)</div>
      <div><a href="../blog/${encodeURIComponent(blog.slug)}" target="_blank" rel="noopener noreferrer">Open</a></div>
      <div><button class="admin-delete-btn" data-blog-id="${blog._id}">Delete</button></div>
    `;
    blogsListEl.appendChild(row);
  });
}

function parseTmdbIdInput(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (/^\d+$/.test(s)) return s;
  const fromPath = s.match(/(?:movie|tv)\/(\d+)/i);
  if (fromPath) return fromPath[1];
  const fromQuery = s.match(/[?&]tmdb_id=(\d+)/i);
  if (fromQuery) return fromQuery[1];
  const digits = s.match(/(\d{1,9})/);
  return digits ? digits[1] : "";
}

function buildTmdbSearchTags(data, keywordNames = []) {
  const parts = [];
  if (Array.isArray(data?.genres)) {
    data.genres.forEach((g) => {
      if (g?.name) parts.push(String(g.name).trim());
    });
  }
  keywordNames.forEach((k) => {
    if (k) parts.push(String(k).trim());
  });
  if (data?.tagline) parts.push(String(data.tagline).trim());
  const alt = data?.original_title || data?.original_name;
  const main = data?.title || data?.name;
  if (alt && alt !== main) parts.push(String(alt).trim());
  if (main) parts.push(String(main).trim());

  const seen = new Set();
  const unique = [];
  parts.forEach((p) => {
    const key = p.toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    unique.push(p);
  });
  return unique.join(", ");
}

async function fetchTmdbKeywordNamesDirect(tmdbId, isMovie) {
  try {
    const path = isMovie
      ? `/movie/${tmdbId}/keywords`
      : `/tv/${tmdbId}/keywords`;
    const data = await tmdbDirectGet(path);
    const list = isMovie ? data?.keywords : data?.results;
    return (Array.isArray(list) ? list : [])
      .map((k) => k?.name)
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

async function fetchTmdbAlternativeTitleNamesDirect(tmdbId, isMovie) {
  try {
    const path = isMovie
      ? `/movie/${tmdbId}/alternative_titles`
      : `/tv/${tmdbId}/alternative_titles`;
    const data = await tmdbDirectGet(path);
    const list = data?.titles || data?.results || [];
    return (Array.isArray(list) ? list : [])
      .map((t) => t?.title || t?.name)
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

async function tmdbMetaFromPayload(data, tmdbId, mediaKind) {
  const id = String(tmdbId || data?.id || "").trim();
  const isMovie = mediaKind === "movie" || mediaKind === "animeMovie";
  const [keywordNames, altTitles] =
    id && mediaKind
      ? await Promise.all([
          fetchTmdbKeywordNamesDirect(id, isMovie),
          fetchTmdbAlternativeTitleNamesDirect(id, isMovie),
        ])
      : [[], []];
  return {
    title: data.title || data.name || "",
    overview: data.overview || "",
    tags: buildTmdbSearchTags(data, [...keywordNames, ...altTitles]),
    posterUrl: data.poster_path
      ? `https://image.tmdb.org/t/p/w500${data.poster_path}`
      : "",
    bannerUrl: data.backdrop_path
      ? `https://image.tmdb.org/t/p/w1280${data.backdrop_path}`
      : "",
  };
}

function buildTmdbTryTypes(preferredType) {
  const tryOrder = [];
  const push = (t) => {
    if (t && !tryOrder.includes(t)) tryOrder.push(t);
  };
  push(preferredType || "movie");
  if (preferredType === "movie" || preferredType === "animeMovie") {
    push("tv");
    push("anime");
  } else {
    push("movie");
    push("animeMovie");
  }
  return tryOrder;
}

/** Browser → TMDB (reliable); server proxy is optional fallback. */
async function tmdbDirectGet(pathAndQuery) {
  const sep = String(pathAndQuery).includes("?") ? "&" : "?";
  const url = `https://api.themoviedb.org/3${pathAndQuery}${sep}api_key=${encodeURIComponent(TMDB_API_KEY)}&language=en-US`;
  const res = await fetch(url);
  if (!res.ok) {
    if (res.status === 401) {
      throw new Error(
        "Invalid TMDB API key. Create a new key at themoviedb.org → Settings → API and set it in admin.js."
      );
    }
    const err = new Error(`TMDB error ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function resolveTmdbMetaDirect(tmdbIdRaw, preferredType = "movie") {
  const raw = String(tmdbIdRaw || "").trim();
  if (/^tt\d+$/i.test(raw)) {
    const found = await tmdbDirectGet(
      `/find/${encodeURIComponent(raw)}?external_source=imdb_id`
    );
    const movie = found.movie_results?.[0];
    if (movie?.id) {
      const id = String(movie.id);
      const data = await tmdbDirectGet(`/movie/${id}`);
      return {
        tmdbId: id,
        type: "movie",
        meta: await tmdbMetaFromPayload(data, id, "movie"),
      };
    }
    const tv = found.tv_results?.[0];
    if (tv?.id) {
      const id = String(tv.id);
      const data = await tmdbDirectGet(`/tv/${id}`);
      const type = tv.genre_ids?.includes(16) ? "anime" : "tv";
      return {
        tmdbId: id,
        type,
        meta: await tmdbMetaFromPayload(data, id, type),
      };
    }
  }

  const tmdbId = parseTmdbIdInput(raw);
  if (!tmdbId) {
    throw new Error(
      "Invalid TMDB ID. Paste a number (550) or a full themoviedb.org link."
    );
  }

  for (const type of buildTmdbTryTypes(preferredType)) {
    try {
      const path =
        type === "movie" || type === "animeMovie"
          ? `/movie/${tmdbId}`
          : `/tv/${tmdbId}`;
      const data = await tmdbDirectGet(path);
      const meta = await tmdbMetaFromPayload(data, tmdbId, type);
      if (meta.title?.trim()) {
        return { tmdbId, type, meta };
      }
    } catch (_) {}
  }

  throw new Error(
    `TMDB ID "${tmdbId}" not found. Open that title on themoviedb.org — copy the number after /movie/ or /tv/ in the URL.`
  );
}

async function fetchTmdbDetails(tmdbId, type) {
  const id = String(tmdbId || "").trim();
  const preferred = String(type || "movie").trim();
  try {
    const resolved = await resolveTmdbMetaDirect(id, preferred);
    return resolved.meta;
  } catch (_) {
    try {
      const q = new URLSearchParams({ tmdbId: id, type: preferred });
      const res = await adminFetch(`/api/tmdb/resolve?${q}`);
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.meta?.title) return data.meta;
    } catch (_) {}
  }

  const movies = loadMovieData()?.movies || {};
  const fromLibrary = Object.values(movies).find(
    (m) => String(m?.tmdbId || "") === id
  );
  if (fromLibrary?.title) {
    return {
      title: fromLibrary.title || "",
      overview: fromLibrary.overview || "",
      posterUrl: fromLibrary.posterUrl || "",
      bannerUrl: fromLibrary.bannerUrl || "",
      tags: fromLibrary.tags || "",
    };
  }
  throw new Error(
    "TMDB is unreachable right now and this title is not in your library. Add the movie first, or try blog publish again later."
  );
}

async function fetchTmdbMetaForAdd(tmdbIdRaw, preferredType) {
  try {
    return await resolveTmdbMetaDirect(tmdbIdRaw, preferredType);
  } catch (directErr) {
    try {
      const q = new URLSearchParams({
        tmdbId: String(tmdbIdRaw).trim(),
        type: String(preferredType || "movie"),
      });
      const res = await adminFetch(`/api/tmdb/resolve?${q}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw directErr;
      if (!data?.meta?.title?.trim()) throw directErr;
      return {
        meta: data.meta,
        type: data.type || preferredType,
        tmdbId: String(data.tmdbId || parseTmdbIdInput(tmdbIdRaw) || tmdbIdRaw),
      };
    } catch (_) {
      throw directErr;
    }
  }
}

function populateAssignListSelect(data) {
  const select = document.getElementById("assign-list");
  if (!select) return false;

  const prev = select.value;
  select.innerHTML = "";
  const listNames = getOrderedCustomListNames(data);

  if (!listNames.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Create a list in the Lists tab first (Anime, Best, …)";
    select.appendChild(opt);
    return false;
  }

  listNames.forEach((name) => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  });

  if (prev && listNames.includes(prev)) select.value = prev;
  return true;
}

async function fetchTmdbTvSeasonsDirect(tmdbId, maxSeasons = 3) {
  const id = parseTmdbIdInput(tmdbId) || String(tmdbId).trim();
  const tv = await tmdbDirectGet(`/tv/${id}`);
  const total = Math.min(tv.number_of_seasons || 0, maxSeasons);
  const seasons = [];
  for (let s = 1; s <= total; s++) {
    try {
      const seasonData = await tmdbDirectGet(`/tv/${id}/season/${s}`);
      seasons.push({
        season_number: s,
        episodes: (seasonData.episodes || []).map((ep) => ({
          episode_number: ep.episode_number,
          name: ep.name || `Episode ${ep.episode_number}`,
        })),
      });
    } catch (_) {}
  }
  return seasons;
}

async function fetchTmdbTvSeasons(tmdbId, maxSeasons = 3) {
  try {
    return await fetchTmdbTvSeasonsDirect(tmdbId, maxSeasons);
  } catch (_) {
    const q = new URLSearchParams({
      tmdbId: String(tmdbId),
      max: String(maxSeasons),
    });
    const res = await adminFetch(`/api/tmdb/seasons?${q}`, {}, 120000);
    const data = await res.json().catch(() => []);
    if (!res.ok) {
      throw new Error(
        (data && data.error) || `TMDB seasons failed (HTTP ${res.status})`
      );
    }
    return Array.isArray(data) ? data : [];
  }
}

async function detectTmdbType(tmdbId) {
  const base = "https://api.themoviedb.org/3";
  const movieRes = await fetch(
    `${base}/movie/${tmdbId}?api_key=${TMDB_API_KEY}&language=en-US`
  );
  if (movieRes.ok) return "movie";
  const tvRes = await fetch(
    `${base}/tv/${tmdbId}?api_key=${TMDB_API_KEY}&language=en-US`
  );
  if (tvRes.ok) return "tv";
  throw new Error("TMDB ID not found as movie or TV show.");
}

document.addEventListener("DOMContentLoaded", async () => {
  const loginCard = document.getElementById("admin-login-card");
  const panel = document.getElementById("admin-panel");
  const loginForm = document.getElementById("admin-login-form");
  const loginError = document.getElementById("admin-login-error");
  const logoutBtn = document.getElementById("admin-logout-btn");
  const createListForm = document.getElementById("create-list-form");
  const addTitleForm = document.getElementById("add-title-form");
  const addTitleError = document.getElementById("add-title-error");
  const addTitleSuccess = document.getElementById("add-title-success");
  const sourceKindSelect = document.getElementById("source-kind");
  const downloadFields = document.getElementById("download-fields");
  const downloadMovieOnlyFields = document.getElementById(
    "download-movie-only-fields"
  );
  const contentTypeSelect = document.getElementById("content-type");
  const tmdbInput = document.getElementById("tmdb-id");
  const editLangAddBtn = document.getElementById("edit-movie-add-language");
  const editLangSaveBtn = document.getElementById("edit-movie-save");
  const editLangCancelBtn = document.getElementById("edit-movie-cancel");

  if (isAuthed()) {
    if (loginCard) loginCard.style.display = "none";
    if (panel) panel.style.display = "flex";
    await refreshData();
    await maybeMigrateLocalToApi();
    await ensureDefaultListsInApi();
    renderDashboard();
    renderLists();
    renderBanners();
    await renderLocalAds();
    await renderBlogs();
  }

  if (loginForm) {
    loginForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const id = (document.getElementById("admin-username")?.value || "").trim();
      const pass = document.getElementById("admin-password")?.value || "";
      if (id === ADMIN_ID && pass === ADMIN_PASSWORD) {
        setAuth(true);
        if (loginError) loginError.textContent = "";
        if (loginCard) loginCard.style.display = "none";
        if (panel) panel.style.display = "flex";
        await refreshData();
      await maybeMigrateLocalToApi();
        await ensureDefaultListsInApi();
        renderDashboard();
        renderLists();
        renderBanners();
        await renderLocalAds();
        await renderBlogs();
      } else if (loginError) {
        loginError.textContent = "Invalid ID or password.";
      }
    });
  }

  if (logoutBtn) {
    logoutBtn.addEventListener("click", () => {
      setAuth(false);
      window.location.reload();
    });
  }

  document.querySelectorAll(".admin-nav-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const t = btn.getAttribute("data-section");
      if (t) switchSection(t);
      if (t === "add-movie-section") {
        try {
          await ensureDefaultListsInApi();
          renderLists();
        } catch (err) {
          console.error(err);
        }
      }
      if (t === "local-ads-section") {
        await renderLocalAds();
      }
    });
  });

  if (createListForm) {
    createListForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const input = document.getElementById("new-list-name");
      const name = input?.value?.trim();
      if (!name) return;
      if (isReservedRandomListName(name)) {
        alert(
          'This name is reserved. "Random" lists are created automatically on the home page — use a different name.'
        );
        return;
      }
      await upsertList(name);
      if (input) input.value = "";
      await refreshData();
      renderLists();
    });
  }

  // Add Banner (drag & drop upload)
  const bannerForm = document.getElementById("add-banner-form");
  const bannerDropzone = document.getElementById("banner-dropzone");
  const bannerFileInput = document.getElementById("banner-image-file");
  const bannerPreviewWrap = document.getElementById(
    "banner-image-preview-wrap"
  );
  const bannerPreviewImg = document.getElementById("banner-image-preview");
  const bannerTitleInput = document.getElementById("banner-title");
  const bannerDescInput = document.getElementById("banner-description");
  const bannerTmdbInput = document.getElementById("banner-tmdb-id");
  const bannerContentTypeSelect = document.getElementById(
    "banner-content-type"
  );
  const bannerErrorEl = document.getElementById("add-banner-error");
  const bannersListEl = document.getElementById("banners-list");
  const addBlogForm = document.getElementById("add-blog-form");
  const addBlogError = document.getElementById("add-blog-error");
  const addBlogSuccess = document.getElementById("add-blog-success");
  const blogTmdbInput = document.getElementById("blog-tmdb-id");
  const blogContentType = document.getElementById("blog-content-type");
  const blogDescription = document.getElementById("blog-description");
  const blogSeoKeywords = document.getElementById("blog-seo-keywords");
  const blogsList = document.getElementById("blogs-list");
  const blogSectionsList = document.getElementById("blog-sections-list");
  const addBlogSectionBtn = document.getElementById("add-blog-section-btn");

  const readFileAsDataUrl = (file) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = (err) => reject(err);
      reader.readAsDataURL(file);
    });

  function resolveAssetUrl(url) {
    if (!url) return "";
    const value = String(url);
    if (value.startsWith("data:") || value.startsWith("http")) return value;
    return `${API_BASE}${value}`;
  }

  let blogSectionCounter = 0;

  function getSectionImageKind(item) {
    return item?.querySelector(".blog-section-kind")?.value === "banner"
      ? "banner"
      : "photo";
  }

  function applySectionPreviewStyle(item) {
    const previewImg = item?.querySelector(".blog-section-preview");
    const previewWrap = item?.querySelector(".blog-section-preview-wrap");
    if (!previewImg || !previewWrap) return;

    const kind = getSectionImageKind(item);
    previewImg.classList.remove(
      "blog-section-preview--photo",
      "blog-section-preview--banner"
    );
    previewImg.classList.add(
      kind === "banner"
        ? "blog-section-preview--banner"
        : "blog-section-preview--photo"
    );

    if (previewImg.getAttribute("src")) {
      previewWrap.classList.add("is-visible");
    } else {
      previewWrap.classList.remove("is-visible");
    }
  }

  function createBlogSectionItem() {
    blogSectionCounter += 1;
    const sectionId = blogSectionCounter;
    const beforeId = `blog-section-before-${sectionId}`;
    const kindId = `blog-section-kind-${sectionId}`;
    const fileId = `blog-section-file-${sectionId}`;
    const afterId = `blog-section-after-${sectionId}`;
    const item = document.createElement("div");
    item.className = "blog-section-item";
    item.dataset.sectionId = String(sectionId);
    item.innerHTML = `
      <div class="blog-section-item-head">
        <strong>Section ${sectionId}</strong>
        <button type="button" class="admin-delete-btn blog-section-remove">Remove</button>
      </div>
      <div class="blog-field-group">
        <label class="admin-label" for="${beforeId}">1. Text before image</label>
        <textarea id="${beforeId}" class="admin-input blog-section-before" rows="4" placeholder="Write text before the image..."></textarea>
      </div>

      <div class="blog-field-row">
        <div class="blog-field-group">
          <label class="admin-label" for="${kindId}">2. Image type</label>
          <select id="${kindId}" class="admin-input blog-section-kind">
            <option value="photo">Photo (portrait / normal)</option>
            <option value="banner">Banner (full width)</option>
          </select>
        </div>
        <div class="blog-field-group blog-field-group--file">
          <label class="admin-label" for="${fileId}">3. Upload image</label>
          <input id="${fileId}" type="file" class="blog-section-file admin-input" accept="image/*" />
        </div>
      </div>

      <p class="blog-section-upload-status admin-small"></p>
      <div class="blog-section-preview-wrap">
        <img class="blog-section-preview blog-section-preview--photo" alt="Section preview" />
      </div>

      <div class="blog-field-group">
        <label class="admin-label" for="${afterId}">4. Text after image</label>
        <textarea id="${afterId}" class="admin-input blog-section-after" rows="4" placeholder="Write text after the image..."></textarea>
      </div>
    `;

    item._blogImageUrl = "";

    const fileInput = item.querySelector(".blog-section-file");
    const previewImg = item.querySelector(".blog-section-preview");
    const uploadStatus = item.querySelector(".blog-section-upload-status");
    const kindSelect = item.querySelector(".blog-section-kind");
    const removeBtn = item.querySelector(".blog-section-remove");

    if (kindSelect) {
      kindSelect.addEventListener("change", () => applySectionPreviewStyle(item));
    }

    if (fileInput) {
      fileInput.addEventListener("change", async () => {
        const file = fileInput.files?.[0];
        if (!file) return;
        if (addBlogError) addBlogError.textContent = "";
        if (uploadStatus) uploadStatus.textContent = "Uploading image...";
        try {
          const dataUrl = await readFileAsDataUrl(file);
          let imageRef = "";
          try {
            imageRef = await uploadBlogImage(dataUrl);
          } catch (uploadErr) {
            console.warn("File upload failed.", uploadErr);
            throw new Error(
              uploadErr?.message ||
                "Image upload failed. Please try a smaller image or retry."
            );
          }
          item._blogImageUrl = imageRef;
          if (previewImg) previewImg.src = resolveAssetUrl(imageRef);
          applySectionPreviewStyle(item);
          if (uploadStatus) uploadStatus.textContent = "Image uploaded.";
        } catch (err) {
          console.error(err);
          item._blogImageUrl = "";
          if (previewImg) previewImg.removeAttribute("src");
          if (uploadStatus) uploadStatus.textContent = "";
          if (addBlogError) {
            addBlogError.textContent =
              err?.message || "Failed to read section image.";
          }
        }
      });
    }

    if (removeBtn) {
      removeBtn.addEventListener("click", () => item.remove());
    }

    return item;
  }

  function resetBlogSections() {
    blogSectionCounter = 0;
    if (blogSectionsList) blogSectionsList.innerHTML = "";
  }

  function collectBlogSections() {
    if (!blogSectionsList) return [];
    const items = blogSectionsList.querySelectorAll(".blog-section-item");
    const sections = [];

    items.forEach((item) => {
      const textBefore = item.querySelector(".blog-section-before")?.value?.trim() || "";
      const textAfter = item.querySelector(".blog-section-after")?.value?.trim() || "";
      const imageDataUrl = String(item._blogImageUrl || item._blogImageData || "").trim();
      const imageKind = getSectionImageKind(item);

      if (!textBefore && !textAfter && !imageDataUrl) return;

      sections.push({
        textBefore,
        textAfter,
        imageDataUrl,
        imageKind,
      });
    });

    return sections;
  }

  if (addBlogSectionBtn && blogSectionsList) {
    addBlogSectionBtn.addEventListener("click", () => {
      blogSectionsList.appendChild(createBlogSectionItem());
    });
  }

  let currentBannerImageDataUrl = "";

  async function setBannerFile(file) {
    if (!file) return;
    const dataUrl = await readFileAsDataUrl(file);
    currentBannerImageDataUrl = String(dataUrl || "");
    if (bannerPreviewImg) bannerPreviewImg.src = currentBannerImageDataUrl;
    if (bannerPreviewWrap) bannerPreviewWrap.style.display = "block";
  }

  if (bannerDropzone && bannerFileInput) {
    bannerDropzone.addEventListener("click", () => bannerFileInput.click());
    bannerDropzone.addEventListener("dragover", (e) => {
      e.preventDefault();
      bannerDropzone.style.borderColor = "#4dbf00";
    });
    bannerDropzone.addEventListener("dragleave", () => {
      bannerDropzone.style.borderColor = "";
    });
    bannerDropzone.addEventListener("drop", async (e) => {
      e.preventDefault();
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      try {
        await setBannerFile(file);
      } catch (err) {
        console.error(err);
        if (bannerErrorEl)
          bannerErrorEl.textContent = "Failed to read image file.";
      }
    });
  }

  if (bannerFileInput) {
    bannerFileInput.addEventListener("change", async () => {
      const file = bannerFileInput.files?.[0];
      if (!file) return;
      try {
        await setBannerFile(file);
      } catch (err) {
        console.error(err);
      }
    });
  }

  if (bannerForm) {
    bannerForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (bannerErrorEl) bannerErrorEl.textContent = "";

      const title = bannerTitleInput?.value?.trim();
      const description = bannerDescInput?.value?.trim();
      const tmdbIdRaw = bannerTmdbInput?.value;
      const tmdbId = tmdbIdRaw !== undefined && tmdbIdRaw !== null ? String(tmdbIdRaw).trim() : "";
      const contentType = bannerContentTypeSelect?.value;

      if (!currentBannerImageDataUrl) {
        if (bannerErrorEl) bannerErrorEl.textContent = "Please upload a banner image.";
        return;
      }
      if (!title) {
        if (bannerErrorEl) bannerErrorEl.textContent = "Banner title is required.";
        return;
      }
      if (!tmdbId) {
        if (bannerErrorEl) bannerErrorEl.textContent = "TMDB ID is required.";
        return;
      }
      if (!contentType) {
        if (bannerErrorEl) bannerErrorEl.textContent = "Content type is required.";
        return;
      }

      await addBanner({
        title,
        description: description || "",
        tmdbId,
        contentType,
        imageDataUrl: currentBannerImageDataUrl,
        createdAt: Date.now(),
      });
      await refreshData();
      renderBanners();

      // Reset form (keep image in case admin wants to add many quickly)
      if (bannerTitleInput) bannerTitleInput.value = "";
      if (bannerDescInput) bannerDescInput.value = "";
      if (bannerTmdbInput) bannerTmdbInput.value = "";
      if (bannerContentTypeSelect) bannerContentTypeSelect.value = "movie";
    });
  }

  if (bannersListEl) {
    bannersListEl.addEventListener("click", async (e) => {
      const target = e.target;
      if (!target) return;
      if (target.classList?.contains("admin-delete-btn")) {
        const bannerId = target.dataset.bannerId;
        if (!bannerId) return;
        await deleteBanner(bannerId);
        await refreshData();
        renderBanners();
      }
    });
  }

  const localAdForm = document.getElementById("add-local-ad-form");
  const localAdTitleInput = document.getElementById("local-ad-title");
  const localAdMaxPlaysInput = document.getElementById("local-ad-max-plays");
  const localAdClickUrlInput = document.getElementById("local-ad-click-url");
  const localAdSkipMode = document.getElementById("local-ad-skip-mode");
  const localAdSkipSecondsWrap = document.getElementById("local-ad-skip-seconds-wrap");
  const localAdSkipAfter = document.getElementById("local-ad-skip-after");
  const localAdVideoInput = document.getElementById("local-ad-video-file");
  const localAdErrorEl = document.getElementById("add-local-ad-error");
  const localAdSuccessEl = document.getElementById("add-local-ad-success");
  const localAdUploadStatus = document.getElementById("local-ad-upload-status");
  const localAdSubmitBtn = document.getElementById("local-ad-submit-btn");
  const localAdsListEl = document.getElementById("local-ads-list");

  function syncLocalAdSkipUi() {
    if (!localAdSkipMode || !localAdSkipSecondsWrap) return;
    localAdSkipSecondsWrap.style.display =
      localAdSkipMode.value === "after" ? "block" : "none";
  }

  if (localAdSkipMode) {
    localAdSkipMode.addEventListener("change", syncLocalAdSkipUi);
    syncLocalAdSkipUi();
  }

  if (localAdForm) {
    localAdForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (localAdErrorEl) localAdErrorEl.textContent = "";
      if (localAdSuccessEl) localAdSuccessEl.textContent = "";

      const file = localAdVideoInput?.files?.[0];
      const maxPlays = Math.max(
        1,
        Math.floor(Number(localAdMaxPlaysInput?.value) || 100)
      );
      const title = localAdTitleInput?.value?.trim() || "";
      const clickThroughUrl = localAdClickUrlInput?.value?.trim() || "";
      const skipMode = localAdSkipMode?.value === "after" ? "after" : "none";
      let skipOffsetSeconds = null;
      if (skipMode === "after") {
        const sec = Math.floor(Number(localAdSkipAfter?.value) || 0);
        if (Number.isFinite(sec) && sec >= 0 && sec <= 600) {
          skipOffsetSeconds = sec;
        }
      }

      if (!file) {
        if (localAdErrorEl) localAdErrorEl.textContent = "Please choose a video file.";
        return;
      }
      if (file.size > 80 * 1024 * 1024) {
        if (localAdErrorEl)
          localAdErrorEl.textContent = "Video is too large (max 80 MB).";
        return;
      }

      if (localAdSubmitBtn) localAdSubmitBtn.disabled = true;
      if (localAdUploadStatus) localAdUploadStatus.textContent = "Uploading video...";

      try {
        const videoDataUrl = await readFileAsDataUrl(file);
        await createLocalAd({
          title,
          maxPlays,
          clickThroughUrl,
          skipMode,
          skipOffsetSeconds,
          videoDataUrl,
        });
        if (localAdSuccessEl)
          localAdSuccessEl.textContent = "Local ad uploaded successfully.";
        if (localAdForm) localAdForm.reset();
        syncLocalAdSkipUi();
        if (localAdUploadStatus) localAdUploadStatus.textContent = "";
        await renderLocalAds();
      } catch (err) {
        console.error(err);
        if (localAdErrorEl) {
          localAdErrorEl.textContent =
            err?.message || "Failed to upload local ad.";
        }
        if (localAdUploadStatus) localAdUploadStatus.textContent = "";
      } finally {
        if (localAdSubmitBtn) localAdSubmitBtn.disabled = false;
      }
    });
  }

  if (localAdsListEl) {
    localAdsListEl.addEventListener("click", async (e) => {
      const target = e.target;
      if (!target) return;

      if (target.classList?.contains("local-ad-delete-btn")) {
        const adId = target.dataset.adId;
        if (!adId) return;
        if (!confirm("Delete this local ad?")) return;
        try {
          await deleteLocalAd(adId);
          await renderLocalAds();
        } catch (err) {
          console.error(err);
          alert(err?.message || "Failed to delete local ad.");
        }
        return;
      }

      if (target.classList?.contains("local-ad-toggle-btn")) {
        const adId = target.dataset.adId;
        if (!adId) return;
        const isActive = target.textContent?.trim() === "Pause";
        try {
          await updateLocalAd(adId, { active: !isActive });
          await renderLocalAds();
        } catch (err) {
          console.error(err);
          alert(err?.message || "Failed to update local ad.");
        }
        return;
      }

      if (target.classList?.contains("local-ad-save-skip-btn")) {
        const adId = target.dataset.adId;
        if (!adId) return;
        const row = target.closest(".admin-table-row");
        const mode = row?.querySelector(".local-ad-skip-mode-edit")?.value || "none";
        const sec = Math.floor(
          Number(row?.querySelector(".local-ad-skip-sec-edit")?.value) || 0
        );
        try {
          if (mode === "after") {
            await updateLocalAd(adId, {
              skipMode: "after",
              skipOffsetSeconds: Math.min(600, Math.max(0, sec)),
            });
          } else {
            await updateLocalAd(adId, { skipMode: "none" });
          }
          await renderLocalAds();
          alert("Skip settings saved. Test the ad on the player now.");
        } catch (err) {
          console.error(err);
          alert(err?.message || "Could not save skip settings.");
        }
      }
    });
  }

  if (addBlogForm) {
    addBlogForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (addBlogError) addBlogError.textContent = "";
      if (addBlogSuccess) addBlogSuccess.textContent = "";

      const tmdbId = blogTmdbInput?.value?.trim() || "";
      const type = blogContentType?.value || "movie";
      const description = blogDescription?.value?.trim() || "";
      const seoKeywords = blogSeoKeywords?.value?.trim() || "";

      if (!tmdbId) {
        if (addBlogError) addBlogError.textContent = "TMDB ID is required.";
        return;
      }
      const sections = collectBlogSections();
      const hasIntro = Boolean(description);
      const hasSectionContent = sections.some(
        (section) =>
          section.textBefore ||
          section.textAfter ||
          section.imageDataUrl
      );

      if (!hasIntro && !hasSectionContent) {
        if (addBlogError) {
          addBlogError.textContent =
            "Add intro text or at least one photo/banner section.";
        }
        return;
      }

      try {
        const preparedSections = [];
        for (const section of sections) {
          let imageDataUrl = section.imageDataUrl;
          if (imageDataUrl.startsWith("data:")) {
            imageDataUrl = await uploadBlogImage(imageDataUrl);
          }
          preparedSections.push({ ...section, imageDataUrl });
        }

        const meta = await fetchTmdbDetails(tmdbId, type);
        await addBlog({
          tmdbId,
          contentType: type,
          title: meta.title,
          overview: meta.overview,
          posterUrl: meta.posterUrl,
          bannerUrl: meta.bannerUrl,
          description,
          seoKeywords,
          sections: preparedSections,
          createdAt: Date.now(),
        });
        if (blogTmdbInput) blogTmdbInput.value = "";
        if (blogDescription) blogDescription.value = "";
        if (blogSeoKeywords) blogSeoKeywords.value = "";
        resetBlogSections();
        if (addBlogSuccess) addBlogSuccess.textContent = "Blog published.";
        await renderBlogs();
      } catch (err) {
        console.error(err);
        if (addBlogError) {
          addBlogError.textContent = err?.message || "Failed to publish blog.";
        }
      }
    });
  }

  if (blogsList) {
    blogsList.addEventListener("click", async (e) => {
      const target = e.target;
      const btn = target?.closest ? target.closest("button") : null;
      if (!btn || !btn.classList.contains("admin-delete-btn")) return;
      const blogId = btn.getAttribute("data-blog-id");
      if (!blogId) return;
      await deleteBlog(blogId);
      await renderBlogs();
    });
  }

  const recentListEl = document.getElementById("admin-recent-list");
  if (recentListEl) {
    recentListEl.addEventListener("click", async (e) => {
      const target = e.target;
      if (!target) return;
      const btn = target.closest ? target.closest("button") : null;
      const key = btn ? btn.getAttribute("data-key") : null;

      if (btn && btn.classList?.contains("admin-delete-btn")) {
        const key = btn.getAttribute("data-key");
        if (!key) return;
        await deleteMovie(key);
        await refreshData();
        renderDashboard();
        renderLists();
      } else if (btn && btn.classList?.contains("admin-edit-btn")) {
        if (!key) return;
        try {
          openEditMovie(key);
        } catch (err) {
          console.error("Failed to open edit panel for key:", key, err);
          alert("Could not open edit panel. Check the browser console for errors.");
        }
      }
    });
  }

  if (addTitleForm) {
    addTitleForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      addTitleError.textContent = "";
      addTitleSuccess.textContent = "";

      const saveBtn = addTitleForm.querySelector('button[type="submit"]');

      const tmdbIdRaw = (document.getElementById("tmdb-id")?.value || "").trim();
      const tmdbId = parseTmdbIdInput(tmdbIdRaw) || tmdbIdRaw;
      const selectedType =
        document.getElementById("content-type")?.value || "movie";
      const listName = document.getElementById("assign-list")?.value || "";
      const sourceKind =
        document.getElementById("source-kind")?.value || "vidsrc";
      const downloadScript =
        document.getElementById("download-fluid-script")?.value || "";
      const epContainer = document.getElementById("download-episodes-container");

      if (!tmdbIdRaw) {
        addTitleError.textContent = "TMDB ID is required.";
        return;
      }
      if (!parseTmdbIdInput(tmdbIdRaw) && !/^tt\d+$/i.test(tmdbIdRaw)) {
        addTitleError.textContent =
          "Invalid format. Paste only a number (550) or a themoviedb.org link.";
        return;
      }

      if (!listName) {
        addTitleError.textContent =
          'Choose a list under "Assign to list". You can create a new list in the Lists tab.';
        return;
      }

      if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = "Saving…";
      }

      try {
      let type = selectedType;
      let detectedDownloadSeasons = [];
      if (sourceKind === "download") {
          if (
            currentDownloadEpisodesTmdb === tmdbIdRaw &&
            Array.isArray(currentDownloadEpisodesSeasons)
          ) {
            detectedDownloadSeasons = currentDownloadEpisodesSeasons;
          } else {
            detectedDownloadSeasons = await fetchTmdbTvSeasons(
              tmdbId || tmdbIdRaw
            );
            currentDownloadEpisodesTmdb = tmdbIdRaw;
            currentDownloadEpisodesSeasons = detectedDownloadSeasons;
          }
          const hasSeriesByTmdb =
            Array.isArray(detectedDownloadSeasons) &&
            detectedDownloadSeasons.length > 0;
          const hasSeriesRows =
            !!epContainer &&
            epContainer.querySelectorAll(".admin-episode-row").length > 0;
          const isSeries = hasSeriesByTmdb || hasSeriesRows;

          if (isSeries) {
            type =
              selectedType === "anime" || selectedType === "animeMovie"
                ? "anime"
                : "tv";
          } else {
            type =
              selectedType === "anime" || selectedType === "animeMovie"
                ? "animeMovie"
                : "movie";
          }
      }

      let meta;
      let seasons = [];
        if (saveBtn) saveBtn.textContent = "TMDB…";
        const tmdbResult = await fetchTmdbMetaForAdd(tmdbIdRaw, type);
        meta = tmdbResult.meta;
        type = tmdbResult.type;
        const resolvedTmdbId = tmdbResult.tmdbId || tmdbId;
        if (type === "tv" || type === "anime") {
          if (saveBtn) saveBtn.textContent = "Episodes…";
          seasons =
            Array.isArray(detectedDownloadSeasons) &&
            detectedDownloadSeasons.length
              ? detectedDownloadSeasons
              : await fetchTmdbTvSeasons(resolvedTmdbId, sourceKind === "download" ? 10 : 3);
        }
        if (saveBtn) saveBtn.textContent = "Saving…";

      const key = getMovieIdKey(resolvedTmdbId, type);

      const movieRecord = {
        key,
        tmdbId: resolvedTmdbId,
        type,
        title: meta.title,
        overview: meta.overview,
        tags: meta.tags || "",
        posterUrl: meta.posterUrl,
        seasons: seasons.length ? seasons : null,
        sourceKind,
        createdAt: Date.now(),
      };

      if (sourceKind === "download") {
        if (type === "tv" || type === "anime") {
          // Per-episode codes from UI
          const epMap = {};
          if (epContainer) {
            const rows = Array.from(
              epContainer.querySelectorAll(".admin-episode-row")
            );
            rows.forEach((row) => {
              const keyAttr = row.dataset.epKey;
              const ta = row.querySelector(".download-episode-script");
              const code = ta?.value?.trim();
              if (keyAttr && code) {
                epMap[keyAttr] = { script: code };
              }
            });
          }
          // For TV/Anime downloads we support multiple languages later in Edit.
          // During Add we treat this as "Original" (langIndex = 0).
          movieRecord.languages = [{ name: "Original" }];
          movieRecord.downloadEpisodesByLang = { "0": epMap };
          // Backward compatibility
          movieRecord.downloadEpisodes = epMap;
        } else {
          if (!downloadScript.trim()) {
            addTitleError.textContent =
              "For downloads movies, Fluid Player code is required.";
            return;
          }
          // Movie / Anime movie: single Fluid code via languages
          movieRecord.languages = [
            {
              name: "Original",
              script: downloadScript.trim(),
            },
          ];
        }
      }

        await upsertList(listName);
        await upsertMovie(movieRecord);
        await assignMovieToList(listName, key);

        cachedData.movies = cachedData.movies || {};
        cachedData.movies[key] = movieRecord;
        cachedData.lists = cachedData.lists || {};
        if (!Array.isArray(cachedData.lists[listName])) {
          cachedData.lists[listName] = [];
        }
        if (!cachedData.lists[listName].includes(key)) {
          cachedData.lists[listName].push(key);
        }
        renderDashboard();
        renderLists();
        refreshData().catch((e) => console.warn("Background refresh:", e));

        const tmdbInput = document.getElementById("tmdb-id");
        if (tmdbInput) tmdbInput.value = "";
        const scriptInput = document.getElementById("download-fluid-script");
        if (scriptInput) scriptInput.value = "";
        addTitleSuccess.textContent = `"${meta.title}" saved — it will appear on the home page in list "${listName}".`;
      } catch (err) {
        console.error(err);
        addTitleError.textContent =
          err?.message ||
          "Save failed. Run `node server.js` in the terminal and ensure MongoDB is connected.";
      } finally {
        if (saveBtn) {
          saveBtn.disabled = false;
          saveBtn.textContent = "Save Title";
        }
      }
    });
  }

  function rebuildDownloadEpisodesInputs(movie, onlyLangIndex = null) {
    const listEl = document.getElementById("edit-movie-languages");
    if (!listEl) return;

    // Preserve current values before rebuilding
    const preserved = {};
    const existingEpisodeRows = Array.from(
      listEl.querySelectorAll(".admin-episode-row")
    );
    existingEpisodeRows.forEach((row) => {
      const langIndex = row.dataset.langIndex;
      const epKey = row.dataset.epKey;
      const ta = row.querySelector(".edit-episode-script");
      const code = ta?.value?.trim();
      if (!langIndex || !epKey) return;
      if (!preserved[langIndex]) preserved[langIndex] = {};
      if (code) preserved[langIndex][epKey] = { script: code };
    });

    const downloadEpisodesByLang =
      movie.downloadEpisodesByLang &&
      Object.keys(movie.downloadEpisodesByLang).length
        ? movie.downloadEpisodesByLang
        : movie.downloadEpisodes
          ? { "0": movie.downloadEpisodes }
          : {};

    // Render episodes under each language row (directly below language)
    const languageRows = Array.from(listEl.querySelectorAll(".admin-language-row"));
    languageRows.forEach((langRow, idx) => {
      langRow.dataset.langIndex = String(idx);
      const langIndex = String(idx);

      if (onlyLangIndex !== null && String(langIndex) !== String(onlyLangIndex)) {
        return;
      }

      const episodesWrapper = langRow.querySelector(".admin-language-episodes");
      if (!episodesWrapper) return;
      episodesWrapper.innerHTML = "";

      const frag = document.createDocumentFragment();

      (movie.seasons || []).forEach((s) => {
        const seasonHeader = document.createElement("h4");
        seasonHeader.textContent = `Season ${s.season_number}`;
        frag.appendChild(seasonHeader);

        (s.episodes || []).forEach((ep) => {
          const key = episodeKey(s.season_number, ep.episode_number);
          const row = document.createElement("div");
          row.className = "admin-episode-row";
          row.dataset.epKey = key;
          row.dataset.langIndex = langIndex;

          const existingForLang = downloadEpisodesByLang[langIndex] || {};
          const preservedScript =
            preserved[langIndex]?.[key]?.script || "";
          const baseScript =
            existingForLang[key]?.script || existingForLang[key] || "";
          const existingScript = preservedScript || baseScript;

          row.innerHTML = `
            <label class="admin-label admin-episode-label">S${s.season_number} · E${ep.episode_number} - ${
              ep.name || ""
            }</label>
            <textarea
              class="admin-input admin-episode-input edit-episode-script"
              rows="3"
              placeholder="Fluid Player code for this episode (optional)"
            >${existingScript}</textarea>
          `;
          frag.appendChild(row);
        });
      });

      episodesWrapper.appendChild(frag);
    });
  }

  if (editLangAddBtn) {
    editLangAddBtn.addEventListener("click", () => {
      if (!currentEditMovieKey) return;
      const data = loadMovieData();
      const movie = data.movies[currentEditMovieKey];
      if (!movie) return;
      if (movie.sourceKind !== "download") return;

      const isDownloadSeries =
        Array.isArray(movie.seasons) &&
        movie.seasons.length &&
        (movie.downloadEpisodesByLang ||
          (movie.downloadEpisodes !== undefined &&
            movie.downloadEpisodes !== null));

      const listEl = document.getElementById("edit-movie-languages");
      if (!listEl) return;
      // Remove placeholder help text if present
      listEl.querySelectorAll(".admin-help-text").forEach((n) => n.remove());
      const newLangIndex = listEl.querySelectorAll(".admin-language-row").length;
      listEl.appendChild(
        buildLanguageRow(
          { name: "", script: "" },
          {
            showScript: !isDownloadSeries,
            langIndex: newLangIndex,
            includeEpisodesPlaceholder: isDownloadSeries,
          }
        )
      );

      if (isDownloadSeries) {
        rebuildDownloadEpisodesInputs(movie, String(newLangIndex));
      }
    });
  }

  if (editLangSaveBtn) {
    editLangSaveBtn.addEventListener("click", async () => {
      if (!currentEditMovieKey) return;
      const data = loadMovieData();
      const movie = data.movies[currentEditMovieKey];
      if (!movie) return;
      if (movie.sourceKind !== "download") {
        await upsertMovie(movie);
        await refreshData();
        renderDashboard();
        renderLists();
        currentEditMovieKey = null;
        switchSection("dashboard-section");
        return;
      }

      const isDownloadSeries =
        Array.isArray(movie.seasons) && movie.seasons.length;

      const listEl = document.getElementById("edit-movie-languages");
      if (!listEl) return;

      const languageRows = Array.from(
        listEl.querySelectorAll(".admin-language-row")
      );
      const languages = [];
      languageRows.forEach((row, idx) => {
        const nameInput = row.querySelector(".edit-lang-name");
        const scriptInput = row.querySelector(".edit-lang-script");
        const name =
          nameInput?.value?.trim() || `Language ${idx + 1}`;
        const script = scriptInput?.value?.trim() || "";
        languages.push(isDownloadSeries ? { name } : { name, script });
      });
      movie.languages = languages;

      // Save per-episode Fluid codes for downloads TV/Anime (per language)
      if (isDownloadSeries) {
        const downloadEpisodesByLang = {};
        const rowsEp = Array.from(
          listEl.querySelectorAll(".admin-episode-row")
        );
        rowsEp.forEach((row) => {
          const langIndex = row.dataset.langIndex;
          const keyAttr = row.dataset.epKey;
          const ta = row.querySelector(".edit-episode-script");
          const code = ta?.value?.trim();
          if (!langIndex || !keyAttr || !code) return;
          if (!downloadEpisodesByLang[langIndex]) {
            downloadEpisodesByLang[langIndex] = {};
          }
          downloadEpisodesByLang[langIndex][keyAttr] = { script: code };
        });

        movie.downloadEpisodesByLang = downloadEpisodesByLang;

        // Backward compatibility: keep old single-language format for lang 0
        if (downloadEpisodesByLang["0"]) {
          movie.downloadEpisodes = downloadEpisodesByLang["0"];
        } else {
          movie.downloadEpisodes = {};
        }
      }

      await upsertMovie(movie);
      await refreshData();
      renderDashboard();
      renderLists();
      currentEditMovieKey = null;
      switchSection("dashboard-section");
    });
  }

  if (editLangCancelBtn) {
    editLangCancelBtn.addEventListener("click", () => {
      currentEditMovieKey = null;
      switchSection("dashboard-section");
    });
  }

  const editLangContainer = document.getElementById("edit-movie-languages");
  if (editLangContainer) {
    editLangContainer.addEventListener("click", (e) => {
      const target = e.target;
      if (target?.classList?.contains("edit-lang-remove")) {
        if (!currentEditMovieKey) return;
        const data = loadMovieData();
        const movie = data.movies[currentEditMovieKey];
        if (!movie || movie.sourceKind !== "download") return;

        const row = target.closest(".admin-language-row");
        if (row) row.remove();

        const isDownloadSeries =
          movie &&
          Array.isArray(movie.seasons) &&
          movie.seasons.length &&
          (movie.downloadEpisodesByLang ||
            (movie.downloadEpisodes !== undefined &&
              movie.downloadEpisodes !== null));
        if (isDownloadSeries) {
          rebuildDownloadEpisodesInputs(movie);
        }
      }
    });
  }

  if (sourceKindSelect && downloadFields) {
    const updateDownloadVisibility = () => {
      const sourceVal = sourceKindSelect.value;
      // Show/hide overall download block based on source
      downloadFields.style.display = sourceVal === "download" ? "block" : "none";

      if (downloadMovieOnlyFields) {
        const hasSeriesData =
          Array.isArray(currentDownloadEpisodesSeasons) &&
          currentDownloadEpisodesSeasons.length > 0;
        const shouldShowMovieCode =
          sourceVal === "download" &&
          !hasSeriesData;
        downloadMovieOnlyFields.style.display = shouldShowMovieCode ? "block" : "none";
      }
    };
    sourceKindSelect.addEventListener("change", () => {
      updateDownloadVisibility();
    });
    if (contentTypeSelect) {
      contentTypeSelect.addEventListener("change", () => {
        updateDownloadVisibility();
      });
    }
    updateDownloadVisibility();
  }

  async function maybeLoadDownloadEpisodes() {
    if (!sourceKindSelect || !downloadFields) return;
    const sourceVal = sourceKindSelect.value;
    const tmdbVal = tmdbInput?.value?.trim();
    const epContainer = document.getElementById("download-episodes-container");
    if (
      sourceVal !== "download" ||
      !tmdbVal ||
      !epContainer
    ) {
      if (epContainer) epContainer.innerHTML = "";
      if (sourceVal !== "download" || !tmdbVal) {
        currentDownloadEpisodesTmdb = null;
        currentDownloadEpisodesSeasons = null;
      }
      if (downloadMovieOnlyFields) {
        downloadMovieOnlyFields.style.display =
          sourceVal === "download" && tmdbVal ? "block" : "none";
      }
      return;
    }

    // Avoid refetch if same TMDB id
    if (
      currentDownloadEpisodesTmdb === tmdbVal &&
      Array.isArray(currentDownloadEpisodesSeasons) &&
      currentDownloadEpisodesSeasons.length
    ) {
      // Already rendered once; don't rebuild here
      return;
    }

    try {
      const seasons = await fetchTmdbTvSeasons(tmdbVal);
      currentDownloadEpisodesTmdb = tmdbVal;
      currentDownloadEpisodesSeasons = seasons;
      epContainer.innerHTML = "";

      if (Array.isArray(seasons) && seasons.length > 0) {
        // This TMDB id clearly has seasons/episodes => treat as series.
        // Hide movie-only field and show per-episode fields.
        if (downloadMovieOnlyFields) {
          downloadMovieOnlyFields.style.display = "none";
        }
        seasons.forEach((s) => {
          const seasonHeader = document.createElement("h4");
          seasonHeader.textContent = `Season ${s.season_number}`;
          epContainer.appendChild(seasonHeader);
          (s.episodes || []).forEach((ep) => {
            const key = episodeKey(s.season_number, ep.episode_number);
            const row = document.createElement("div");
            row.className = "admin-episode-row";
            row.dataset.epKey = key;
            row.innerHTML = `
              <label class="admin-label admin-episode-label">S${s.season_number} · E${ep.episode_number} - ${
              ep.name || ""
            }</label>
              <textarea class="admin-input admin-episode-input download-episode-script" rows="3"
                placeholder="Fluid Player code for this episode (optional)"></textarea>
            `;
            epContainer.appendChild(row);
          });
        });
      } else {
        // No seasons => treat as movie, clear episode list and show big movie field.
        epContainer.innerHTML = "";
        if (downloadMovieOnlyFields && sourceVal === "download") {
          downloadMovieOnlyFields.style.display = "block";
        }
      }
    } catch (_) {
      // If TMDB season lookup fails (network/rate-limit), keep at least movie-code input visible.
      if (epContainer) epContainer.innerHTML = "";
      currentDownloadEpisodesTmdb = tmdbVal;
      currentDownloadEpisodesSeasons = [];
      if (downloadMovieOnlyFields && sourceVal === "download") {
        downloadMovieOnlyFields.style.display = "block";
      }
    }
  }

  let tmdbLookupTimer = null;
  const scheduleDownloadEpisodesLookup = () => {
    if (tmdbLookupTimer) clearTimeout(tmdbLookupTimer);
    tmdbLookupTimer = setTimeout(() => {
      currentDownloadEpisodesTmdb = null;
      currentDownloadEpisodesSeasons = null;
      maybeLoadDownloadEpisodes();
    }, 350);
  };

  if (sourceKindSelect) {
    sourceKindSelect.addEventListener("change", () => {
      if (sourceKindSelect.value === "download") {
        scheduleDownloadEpisodesLookup();
      } else {
        if (tmdbLookupTimer) clearTimeout(tmdbLookupTimer);
        currentDownloadEpisodesTmdb = null;
        currentDownloadEpisodesSeasons = null;
      }
      maybeLoadDownloadEpisodes();
    });
  }
  async function updateTmdbTagsPreview() {
    const previewWrap = document.getElementById("tmdb-tags-preview");
    const previewText = document.getElementById("tmdb-tags-preview-text");
    if (!previewWrap || !previewText || !tmdbInput) return;
    const raw = tmdbInput.value?.trim();
    if (!raw) {
      previewWrap.style.display = "none";
      previewText.textContent = "";
      return;
    }
    try {
      const type = contentTypeSelect?.value || "movie";
      const hit = await fetchTmdbMetaForAdd(raw, type);
      const tags = hit?.meta?.tags?.trim();
      if (tags) {
        previewText.textContent = tags;
        previewWrap.style.display = "block";
      } else {
        previewWrap.style.display = "none";
      }
    } catch (_) {
      previewWrap.style.display = "none";
    }
  }

  if (tmdbInput) {
    tmdbInput.addEventListener("input", () => {
      if (!sourceKindSelect || sourceKindSelect.value !== "download") return;
      const val = tmdbInput.value?.trim() || "";
      if (!val) {
        currentDownloadEpisodesTmdb = null;
        currentDownloadEpisodesSeasons = null;
        maybeLoadDownloadEpisodes();
        return;
      }
      scheduleDownloadEpisodesLookup();
    });
    tmdbInput.addEventListener("paste", () => {
      if (!sourceKindSelect || sourceKindSelect.value !== "download") return;
      scheduleDownloadEpisodesLookup();
    });
    tmdbInput.addEventListener("change", () => {
      if (sourceKindSelect?.value === "download") scheduleDownloadEpisodesLookup();
      updateTmdbTagsPreview();
    });
    tmdbInput.addEventListener("blur", () => {
      currentDownloadEpisodesTmdb = null;
      currentDownloadEpisodesSeasons = null;
      maybeLoadDownloadEpisodes();
      updateTmdbTagsPreview();
    });
  }
  if (contentTypeSelect) {
    contentTypeSelect.addEventListener("change", () => {
      currentDownloadEpisodesTmdb = null;
      currentDownloadEpisodesSeasons = null;
      maybeLoadDownloadEpisodes();
      updateTmdbTagsPreview();
    });
  }
});
