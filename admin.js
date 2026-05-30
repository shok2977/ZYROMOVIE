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
const HOME_INVALIDATE_KEY = "flakes_home_invalidate";

function apiUrl(path) {
  const p = String(path || "").startsWith("/") ? path : `/${path}`;
  return `${API_BASE}${p}`;
}

async function adminFetch(path, options = {}, timeoutMs = 45000) {
  const url = String(path).startsWith("http") ? path : apiUrl(path);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const headers = {
    "X-Zyro-Admin": "1",
    ...(options.headers || {}),
  };
  try {
    return await fetch(url, { ...options, headers, signal: ctrl.signal });
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

const HOME_DATA_CLIENT_CACHE_KEY = "flakes_home_data_v5";

function signalHomePageRefresh() {
  try {
    localStorage.setItem(HOME_INVALIDATE_KEY, String(Date.now()));
    sessionStorage.removeItem(HOME_DATA_CLIENT_CACHE_KEY);
  } catch (_) {}
}

async function syncLocalStorageWithServerData() {
  await refreshData();
  try {
    localStorage.setItem(
      LOCAL_STORAGE_KEY,
      JSON.stringify({
        movies: cachedData.movies || {},
        lists: cachedData.lists || {},
        banners: cachedData.banners || [],
        listOrder: Array.isArray(cachedData.listOrder) ? cachedData.listOrder : [],
      })
    );
  } catch (_) {}
  signalHomePageRefresh();
}

function patchLocalStorageAfterMovieDelete(key) {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed?.movies?.[key]) {
      delete parsed.movies[key];
    }
    if (parsed?.lists) {
      Object.keys(parsed.lists).forEach((listName) => {
        parsed.lists[listName] = (parsed.lists[listName] || []).filter(
          (k) => k !== key
        );
      });
    }
    if (Array.isArray(parsed.banners)) {
      parsed.banners = parsed.banners.filter((b) => b?.movieKey !== key);
    }
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(parsed));
  } catch (_) {}
}

function patchCacheAfterMovieDelete(key) {
  if (!key) return;
  delete cachedData.movies[key];
  Object.keys(cachedData.lists || {}).forEach((listName) => {
    cachedData.lists[listName] = (cachedData.lists[listName] || []).filter(
      (k) => k !== key
    );
  });
  cachedData.banners = (cachedData.banners || []).filter(
    (b) => b?.movieKey !== key
  );
  patchLocalStorageAfterMovieDelete(key);
  signalHomePageRefresh();
}

function listNameMatches(a, b) {
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
}

function patchLocalStorageAfterListDelete(name, movieKeys) {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    const keys = Array.isArray(movieKeys) ? movieKeys : [];
    keys.forEach((key) => {
      if (parsed?.movies?.[key]) delete parsed.movies[key];
      if (parsed?.lists) {
        Object.keys(parsed.lists).forEach((listName) => {
          parsed.lists[listName] = (parsed.lists[listName] || []).filter(
            (k) => k !== key
          );
        });
      }
      if (Array.isArray(parsed.banners)) {
        parsed.banners = parsed.banners.filter((b) => b?.movieKey !== key);
      }
    });
    if (parsed?.lists) {
      Object.keys(parsed.lists).forEach((listName) => {
        if (listNameMatches(listName, name)) {
          delete parsed.lists[listName];
        }
      });
    }
    if (Array.isArray(parsed.listOrder)) {
      parsed.listOrder = parsed.listOrder.filter((n) => !listNameMatches(n, name));
    }
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(parsed));
  } catch (_) {}
}

function getListMovieKeysFromCache(listName) {
  return getListMoviesFromCache(listName).map((m) => m.key).filter(Boolean);
}

function getListMoviesFromCache(listName) {
  const out = [];
  const seen = new Set();
  Object.keys(cachedData.lists || {}).forEach((n) => {
    if (!listNameMatches(n, listName)) return;
    (cachedData.lists[n] || []).forEach((k) => {
      const key = String(k || "").trim();
      if (!key || seen.has(key)) return;
      seen.add(key);
      const movie = cachedData.movies?.[key] || {};
      out.push({
        key,
        tmdbId: movie.tmdbId != null ? String(movie.tmdbId) : "",
        type: movie.type != null ? String(movie.type) : "",
        title: movie.title != null ? String(movie.title) : "",
      });
    });
  });
  return out;
}

function reconcileCachedLists() {
  if (!cachedData.lists) cachedData.lists = {};
  const keys = Object.keys(cachedData.lists);
  if (Array.isArray(cachedData.listOrder)) {
    cachedData.listOrder = cachedData.listOrder.filter((n) =>
      Object.prototype.hasOwnProperty.call(cachedData.lists, n)
    );
    const orderSet = new Set(cachedData.listOrder);
    keys.forEach((k) => {
      if (!orderSet.has(k)) delete cachedData.lists[k];
    });
  } else {
    cachedData.listOrder = keys.filter((n) => !isReservedRandomListName(n));
  }
  Object.keys(cachedData.lists).forEach((k) => {
    if (!Array.isArray(cachedData.lists[k])) cachedData.lists[k] = [];
  });
}

async function syncListsCacheFromApi() {
  const res = await adminFetch(`/api/lists?_=${Date.now()}`, {}, 15000);
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload.error || `Failed to load lists (HTTP ${res.status})`);
  }
  cachedData.lists = payload.lists || {};
  cachedData.listOrder = Array.isArray(payload.listOrder)
    ? payload.listOrder
    : Array.isArray(payload.names)
      ? payload.names
      : [];
  reconcileCachedLists();
  return cachedData;
}

function patchCacheAfterListDelete(name, deletedMovieKeys) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return;
  Object.keys(cachedData.lists || {}).forEach((listName) => {
    if (listNameMatches(listName, trimmed)) {
      delete cachedData.lists[listName];
    }
  });
  if (Array.isArray(cachedData.listOrder)) {
    cachedData.listOrder = cachedData.listOrder.filter(
      (n) => !listNameMatches(n, trimmed)
    );
  }
  const keys = Array.isArray(deletedMovieKeys) ? deletedMovieKeys : [];
  keys.forEach((key) => {
    if (cachedData.movies) delete cachedData.movies[key];
    patchLocalStorageAfterMovieDelete(key);
  });
  reconcileCachedLists();
  patchLocalStorageAfterListDelete(trimmed, keys);
  signalHomePageRefresh();
}

async function refreshData() {
  let res = await adminFetch("/api/admin/data", {}, 60000);
  if (res.status === 403 || res.status === 404) {
    res = await adminFetch("/api/data", {}, 60000);
  }
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
  reconcileCachedLists();
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
    const key = custom.find((c) => c === n);
    if (key) ordered.push(key);
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

function movieDeletePayload(key, movie) {
  const m = movie || {};
  return {
    key: String(key || m.key || "").trim(),
    tmdbId: m.tmdbId != null ? String(m.tmdbId) : "",
    type: m.type != null ? String(m.type) : "",
    title: m.title != null ? String(m.title) : "",
  };
}

async function purgeMovieFromDb(payload) {
  const res = await adminFetch(
    "/api/movie/purge",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    20000
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      data.error || data.message || `Failed to delete from database (HTTP ${res.status})`
    );
  }
  const keys = Array.isArray(data.deletedKeys)
    ? data.deletedKeys
    : [data.key].filter(Boolean);
  keys.forEach((k) => patchCacheAfterMovieDelete(k));
  if (payload.key) patchCacheAfterMovieDelete(payload.key);
  await syncLocalStorageWithServerData();
  return data;
}

async function deleteMovie(key, movieHint) {
  const trimmed = String(key || "").trim();
  const movie =
    movieHint ||
    cachedData.movies?.[trimmed] ||
    (trimmed ? { key: trimmed } : {});
  const deleteBody = movieDeletePayload(trimmed || movie.key, movie);

  if (!deleteBody.key && !deleteBody.title && !deleteBody.tmdbId) {
    throw new Error("Movie key or title is missing.");
  }

  try {
    return await purgeMovieFromDb(deleteBody);
  } catch (purgeErr) {
    let res = await adminFetch(
      `/api/movie/${encodeURIComponent(deleteBody.key || trimmed)}`,
      { method: "DELETE" },
      20000
    );
    if (res.status === 403 || res.status === 405 || res.status === 404) {
      res = await adminFetch(
        "/api/movie/delete",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(deleteBody),
        },
        20000
      );
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw purgeErr;
    if (deleteBody.key) patchCacheAfterMovieDelete(deleteBody.key);
    return data;
  }
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

async function renameList(oldName, newName) {
  const res = await adminFetch("/api/list/rename", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ oldName, newName }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `List rename failed (HTTP ${res.status})`);
  }
  return data;
}

async function updateMoviePlacement(key, targetList, searchOnly) {
  const res = await adminFetch("/api/movie/placement", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      key,
      targetList: String(targetList || "").trim(),
      searchOnly: searchOnly === true,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Movie placement update failed (HTTP ${res.status})`);
  }
  return data;
}

async function requestListDeleteApi(trimmed, entries) {
  const movieKeys = (entries || []).map((e) => e.key).filter(Boolean);
  const payload = { name: trimmed, movieKeys, movies: entries || [] };
  const attempts = [
    {
      path: "/api/list",
      body: { ...payload, action: "delete" },
    },
    {
      path: "/api/list/delete",
      body: payload,
    },
  ];

  let lastRes = null;
  let lastRaw = "";
  let lastData = {};

  for (const attempt of attempts) {
    const res = await adminFetch(
      attempt.path,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(attempt.body),
      },
      20000
    );
    const raw = await res.text();
    let data = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch (_) {}

    lastRes = res;
    lastRaw = raw;
    lastData = data;

    if (res.ok) return { res, raw, data };
    if (res.status !== 404) break;
  }

  return { res: lastRes, raw: lastRaw, data: lastData };
}

async function deleteList(name, entriesSnapshot) {
  const trimmed = String(name || "").trim();
  if (!trimmed) throw new Error("List name is required.");

  const entries =
    Array.isArray(entriesSnapshot) && entriesSnapshot.length
      ? entriesSnapshot
      : getListMoviesFromCache(trimmed);
  const { res, raw, data } = await requestListDeleteApi(trimmed, entries);

  if (res.status === 404) {
    await deleteMoviesFallback(entries);
    const keys = entries.map((e) => e.key).filter(Boolean);
    patchCacheAfterListDelete(trimmed, keys);
    return { ok: true, alreadyDeleted: true, deletedMovieKeys: keys };
  }

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

  const reported = Array.isArray(data.deletedMovieKeys)
    ? data.deletedMovieKeys
    : [];
  const entryKeys = entries.map((e) => e.key).filter(Boolean);
  const mergedKeys = [...new Set([...entryKeys, ...reported])];
  const deletedCount = Number(data.deletedMovieCount) || 0;

  if (entries.length > 0 && deletedCount === 0) {
    await deleteMoviesFallback(entries);
  } else {
    const stillPresent = entries.filter(
      (e) => e.key && cachedData.movies?.[e.key]
    );
    if (stillPresent.length) {
      await deleteMoviesFallback(stillPresent);
    }
  }

  patchCacheAfterListDelete(trimmed, mergedKeys);
  await syncLocalStorageWithServerData().catch((e) =>
    console.warn("Sync after list delete:", e)
  );
  return { ...data, deletedMovieKeys: mergedKeys };
}

async function deleteMoviesFallback(entries) {
  const list = Array.isArray(entries) ? entries : [];
  for (const entry of list) {
    const key = String(entry?.key || entry || "").trim();
    if (!key && !entry?.title && !entry?.tmdbId) continue;
    try {
      const res = await adminFetch(
        "/api/movie/delete",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            typeof entry === "object"
              ? entry
              : { key: String(entry || "").trim() }
          ),
        },
        20000
      );
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload.error || `HTTP ${res.status}`);
      }
      if (key) patchCacheAfterMovieDelete(key);
    } catch (err) {
      console.warn("Could not delete movie after list delete:", entry, err);
    }
  }
  await syncLocalStorageWithServerData().catch(() => {});
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
  const res = await adminFetch("/api/lists/reorder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Failed to save list order (HTTP ${res.status})`);
  }
  invalidateHomeFromAdmin();
  return data;
}

function patchCacheAfterBannerAdd(banner) {
  if (!banner) return;
  const entry = {
    ...banner,
    id: String(banner.id || banner._id || ""),
  };
  if (!Array.isArray(cachedData.banners)) cachedData.banners = [];
  cachedData.banners = cachedData.banners.filter(
    (b) => String(b?.id || b?._id || "") !== entry.id
  );
  cachedData.banners.push(entry);
  signalHomePageRefresh();
}

function patchCacheAfterBannerDelete(id) {
  const bid = String(id || "").trim();
  if (!bid) return;
  cachedData.banners = (cachedData.banners || []).filter(
    (b) => String(b?.id || b?._id || "") !== bid
  );
  signalHomePageRefresh();
}

function invalidateHomeFromAdmin() {
  signalHomePageRefresh();
}

async function addBanner(payload) {
  const res = await adminFetch("/api/banner", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Failed to add banner (HTTP ${res.status})`);
  }
  patchCacheAfterBannerAdd(data);
  invalidateHomeFromAdmin();
  return data;
}

async function deleteBanner(id) {
  const bid = String(id || "").trim();
  if (!bid) throw new Error("Banner ID is missing.");

  let res = await adminFetch(`/api/banner/${encodeURIComponent(bid)}`, {
    method: "DELETE",
  }, 20000);

  if (res.status === 403 || res.status === 405) {
    res = await adminFetch(
      "/api/banner/delete",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: bid }),
      },
      20000
    );
  }

  const data = await res.json().catch(() => ({}));
  if (res.status === 404 || data?.alreadyDeleted) {
    patchCacheAfterBannerDelete(bid);
    return { ok: true, alreadyDeleted: true };
  }
  if (!res.ok) {
    throw new Error(data.error || data.message || `Failed to delete banner (HTTP ${res.status})`);
  }
  patchCacheAfterBannerDelete(bid);
  return data;
}

async function fetchLocalAds() {
  const res = await adminFetch("/api/local-ads");
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
  const res = await adminFetch(`/api/local-ads/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Failed to update local ad (HTTP ${res.status})`);
  }
  return data;
}

async function deleteLocalAd(id) {
  const res = await adminFetch(`/api/local-ads/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Failed to delete local ad (HTTP ${res.status})`);
  }
  return data;
}

function resolveAdminAssetUrl(url) {
  if (!url) return "";
  const value = String(url);
  if (value.startsWith("data:") || value.startsWith("http")) return value;
  return `${API_BASE}${value}`;
}

async function uploadBlogImage(dataUrl) {
  const res = await adminFetch("/api/blog/upload-image", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dataUrl }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Failed to upload image");
  return data.url;
}

async function addBlog(payload) {
  const res = await adminFetch("/api/blog", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Failed to add blog");
  return data;
}

async function fetchBlogs() {
  const res = await adminFetch("/api/blogs");
  if (!res.ok) throw new Error("Failed to load blogs");
  return await res.json();
}

async function deleteBlog(id) {
  const res = await adminFetch(`/api/blog/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Failed to delete blog");
  return data;
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

function listExistsInData(data, name) {
  const lower = String(name || "").trim().toLowerCase();
  return Object.keys(data?.lists || {}).some(
    (k) => k.trim().toLowerCase() === lower
  );
}

async function ensureDefaultListsInApi() {
  const defaults = ["Anime", "New Releases", "Hidden Gems", "Best", "Top 10"];
  const data = loadMovieData();
  await Promise.all(
    defaults.map(async (name) => {
      if (!listExistsInData(data, name)) {
        await upsertList(name);
      }
    })
  );
  try {
    await syncListsCacheFromApi();
  } catch (_) {
    await refreshData();
  }
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

async function loadSiteAccessModeAdmin() {
  const select = document.getElementById("site-access-mode");
  if (!select) return;
  try {
    const res = await adminFetch("/api/site/mode");
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || "Failed to load site mode");
    select.value =
      data.accessMode === "blogs_only" ? "blogs_only" : "normal";
  } catch (err) {
    const statusEl = document.getElementById("site-access-mode-status");
    if (statusEl) {
      statusEl.textContent = err?.message || "Could not load site mode.";
    }
  }
}

async function saveSiteAccessModeAdmin() {
  const select = document.getElementById("site-access-mode");
  const statusEl = document.getElementById("site-access-mode-status");
  if (!select) return;
  const accessMode = select.value === "blogs_only" ? "blogs_only" : "normal";
  try {
    const res = await adminFetch("/api/site/mode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessMode }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || "Failed to save site mode");
    if (statusEl) {
      statusEl.textContent =
        accessMode === "blogs_only"
          ? "Saved: Blogs only mode is ON. Home and player are blocked for visitors."
          : "Saved: Normal mode — full website for visitors.";
    }
  } catch (err) {
    if (statusEl) statusEl.textContent = err?.message || "Could not save site mode.";
  }
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

  const sortedKeys = movieKeys.slice().sort((a, b) => {
    const ta = Number(data.movies[a]?.createdAt) || 0;
    const tb = Number(data.movies[b]?.createdAt) || 0;
    return tb - ta;
  });

  // Slider-like pagination for lots of titles.
  const PER_PAGE = 10;
  const totalPages = Math.max(1, Math.ceil(sortedKeys.length / PER_PAGE));
  let pageIndex = 0;

  const sliderWrap = document.createElement("div");
  sliderWrap.className = "admin-recent-slider";

  const tableHost = document.createElement("div");
  tableHost.className = "admin-recent-slider-table";
  sliderWrap.appendChild(tableHost);

  const controls = document.createElement("div");
  controls.className = "admin-recent-slider-controls";

  const meta = document.createElement("div");
  meta.className = "admin-recent-slider-meta";
  controls.appendChild(meta);

  const btnGroup = document.createElement("div");
  btnGroup.className = "admin-recent-slider-btn-group";

  const prevBtn = document.createElement("button");
  prevBtn.type = "button";
  prevBtn.className = "admin-secondary-btn admin-recent-slider-btn";
  prevBtn.textContent = "← Prev";
  prevBtn.addEventListener("click", () => {
    pageIndex = Math.max(0, pageIndex - 1);
    renderPage();
  });

  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.className = "admin-secondary-btn admin-recent-slider-btn";
  nextBtn.textContent = "Next →";
  nextBtn.addEventListener("click", () => {
    pageIndex = Math.min(totalPages - 1, pageIndex + 1);
    renderPage();
  });

  btnGroup.appendChild(prevBtn);
  btnGroup.appendChild(nextBtn);
  controls.appendChild(btnGroup);
  sliderWrap.appendChild(controls);

  const renderHeader = () => {
    const header = document.createElement("div");
    header.className = "admin-table-row admin-table-header";
    header.innerHTML = `
      <div>Title</div>
      <div>Type</div>
      <div>TMDB ID</div>
      <div>Lists</div>
      <div></div>
    `;
    return header;
  };

  const renderPage = () => {
    const start = pageIndex * PER_PAGE;
    const endExclusive = Math.min(sortedKeys.length, start + PER_PAGE);
    const pageKeys = sortedKeys.slice(start, endExclusive);

    tableHost.innerHTML = "";

    const table = document.createElement("div");
    table.className = "admin-table-inner";
    table.appendChild(renderHeader());

    pageKeys.forEach((key) => {
      const m = data.movies[key];
      const searchOnly = m.excludeFromLists === true;
      const listLabel = searchOnly
        ? '<span style="color:#ff9f43;">Search &amp; Random only</span>'
        : (() => {
            const names = [];
            Object.keys(data.lists || {}).forEach((listName) => {
              if ((data.lists[listName] || []).includes(key))
                names.push(listName);
            });
            return names.length ? names.join(", ") : "—";
          })();

      const row = document.createElement("div");
      row.className = "admin-table-row";
      row.innerHTML = `
        <div>${m.title || "Untitled"}</div>
        <div>${m.type || "-"}</div>
        <div>${m.tmdbId || "-"}</div>
        <div style="font-size:12px;">${listLabel}</div>
        <div>
          <button class="admin-secondary-btn admin-edit-btn" data-key="${key}">Edit</button>
          <button class="admin-delete-btn" data-key="${key}"
            data-title="${String(m.title || "").replace(/"/g, "&quot;")}"
            data-tmdb-id="${String(m.tmdbId || "")}"
            data-type="${String(m.type || "")}">Delete</button>
        </div>
      `;
      table.appendChild(row);
    });

    tableHost.appendChild(table);

    meta.textContent =
      sortedKeys.length > 0
        ? `Page ${pageIndex + 1} / ${totalPages} • Showing ${start + 1}-${endExclusive} of ${sortedKeys.length}`
        : "";

    prevBtn.disabled = pageIndex <= 0;
    nextBtn.disabled = pageIndex >= totalPages - 1;
  };

  // Hide controls if not needed.
  controls.style.display = totalPages > 1 ? "" : "none";
  recentListEl.appendChild(sliderWrap);
  renderPage();
}

function getMoviePrimaryListName(data, movieKey, movieObj) {
  if (!movieKey) return "";
  const listsObj = data?.lists || {};
  const fromLists = Object.keys(listsObj).find((listName) =>
    (listsObj[listName] || []).includes(movieKey)
  );
  if (fromLists) return fromLists;
  const member = Array.isArray(movieObj?.memberOfLists) ? movieObj.memberOfLists : [];
  const first = member.find((n) => String(n || "").trim());
  return first ? String(first).trim() : "";
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

  ensureEditPlacementControls();
  const editListSelect = document.getElementById("edit-movie-list-select");
  const editSearchOnly = document.getElementById("edit-movie-search-only");
  const ordered = getOrderedCustomListNames(data);
  if (editListSelect) {
    editListSelect.innerHTML = "";
    if (!ordered.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "Create a list in Lists tab first";
      editListSelect.appendChild(opt);
    } else {
      ordered.forEach((name) => {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        editListSelect.appendChild(opt);
      });
    }
  }
  const currentList = getMoviePrimaryListName(data, key, movie);
  if (editSearchOnly) editSearchOnly.checked = movie.excludeFromLists === true;
  if (editListSelect && currentList) {
    const found = ordered.find((n) => listNameMatches(n, currentList));
    if (found) editListSelect.value = found;
  }
  if (editListSelect) editListSelect.disabled = editSearchOnly?.checked === true;

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
  reconcileCachedLists();
  const data = loadMovieData();
  const listsTable = document.getElementById("lists-table");
  const assignListSelect = document.getElementById("assign-list");
  if (!listsTable || !assignListSelect) return;

  listsTable.innerHTML = "";

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
    actionCell.style.display = "flex";
    actionCell.style.gap = "8px";
    actionCell.style.flexWrap = "wrap";

    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.className = "admin-secondary-btn";
    renameBtn.textContent = "Rename";
    renameBtn.addEventListener("click", async () => {
      const next = prompt("Enter new list name:", name);
      const newName = String(next || "").trim();
      if (!newName || listNameMatches(newName, name)) return;
      if (isReservedRandomListName(newName)) {
        alert('This name is reserved for auto-generated Random rows.');
        return;
      }
      renameBtn.disabled = true;
      try {
        await renameList(name, newName);
        await refreshData();
        await refreshAssignListSelect();
        renderLists();
        renderDashboard();
      } catch (e) {
        console.error(e);
        alert(e?.message || "Could not rename list.");
      } finally {
        renameBtn.disabled = false;
      }
    });

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "admin-delete-btn";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", async () => {
      const msg =
        count > 0
          ? `Delete list "${name}" and all ${count} title(s) in it? This cannot be undone.`
          : `Delete list "${name}"?`;
      if (!confirm(msg)) return;
      delBtn.disabled = true;
      const titlesSnapshot = getListMoviesFromCache(name);
      try {
        const result = await deleteList(name, titlesSnapshot);
        const removed =
          Number(result?.deletedMovieCount) ||
          result?.deletedMovieKeys?.length ||
          0;
        await refreshAssignListSelect();
        renderLists();
        renderDashboard();
        if (count > 0 && removed === 0) {
          alert(
            `List "${name}" was removed but titles could not be deleted from the database. Restart the server (node server.js), then delete the title manually from Overview — or try deleting the list again.`
          );
        }
      } catch (e) {
        console.error(e);
        alert(e?.message || "Could not delete list.");
        refreshData()
          .then(() => {
            renderLists();
            renderDashboard();
          })
          .catch(console.error);
      } finally {
        delBtn.disabled = false;
      }
    });
    actionCell.appendChild(renameBtn);
    actionCell.appendChild(delBtn);

    row.appendChild(posCell);
    row.appendChild(nameCell);
    row.appendChild(countCell);
    row.appendChild(actionCell);
    table.appendChild(row);
  });
  listsTable.appendChild(table);
  refreshAssignListSelect().catch(console.error);

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
    delBtn.dataset.bannerId = String(b.id || b._id || "");
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
      <div>${Array.isArray(blog.sections) ? blog.sections.length : 0} block(s)</div>
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

function syncAssignListFieldsVisibility() {
  const exclude = document.getElementById("exclude-from-lists");
  const fields = document.getElementById("assign-list-fields");
  if (!fields) return;
  const hide = exclude?.checked === true;
  fields.style.display = hide ? "none" : "";
}

function renderAssignListOptions(listNames) {
  const select = document.getElementById("assign-list");
  if (!select) return false;

  const prev = select.value;
  select.innerHTML = "";
  const names = (listNames || []).filter((n) => !isReservedRandomListName(n));

  if (!names.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Create a list in the Lists tab first (Anime, Best, …)";
    select.appendChild(opt);
    return false;
  }

  names.forEach((name) => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  });

  const prevKey = names.find((n) => listNameMatches(n, prev));
  if (prevKey) select.value = prevKey;
  return true;
}

async function refreshAssignListSelect() {
  try {
    await syncListsCacheFromApi();
    renderAssignListOptions(getOrderedCustomListNames(loadMovieData()));
    return;
  } catch (err) {
    console.warn("/api/lists failed, reloading admin data:", err);
  }
  try {
    await refreshData();
    renderAssignListOptions(getOrderedCustomListNames(loadMovieData()));
  } catch (err2) {
    console.error("Assign list dropdown could not refresh:", err2);
    renderAssignListOptions([]);
  }
}

function populateAssignListSelect() {
  reconcileCachedLists();
  return renderAssignListOptions(getOrderedCustomListNames(loadMovieData()));
}

function ensureEditPlacementControls() {
  let wrap = document.getElementById("edit-placement-controls");
  if (wrap) return wrap;
  const section = document.getElementById("edit-movie-section");
  const title = document.getElementById("edit-movie-title");
  if (!section || !title) return null;

  wrap = document.createElement("div");
  wrap.id = "edit-placement-controls";
  wrap.className = "admin-form";
  wrap.style.marginTop = "12px";
  wrap.style.marginBottom = "8px";
  wrap.innerHTML = `
    <label class="admin-label" for="edit-movie-list-select">Transfer to list</label>
    <select id="edit-movie-list-select" class="admin-input"></select>
    <label class="admin-label" for="edit-movie-search-only" style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;">
      <input id="edit-movie-search-only" type="checkbox" style="margin-top:3px;width:auto;" />
      <span>Search & Random only (remove from all custom lists)</span>
    </label>
    <p class="admin-small">When saving edit, this title will be moved from old list to selected list.</p>
  `;
  title.insertAdjacentElement("afterend", wrap);

  const checkbox = document.getElementById("edit-movie-search-only");
  const listSelect = document.getElementById("edit-movie-list-select");
  if (checkbox && listSelect) {
    checkbox.addEventListener("change", () => {
      listSelect.disabled = checkbox.checked;
    });
  }
  return wrap;
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
  const excludeFromListsCheckbox = document.getElementById("exclude-from-lists");
  if (excludeFromListsCheckbox) {
    excludeFromListsCheckbox.addEventListener("change", syncAssignListFieldsVisibility);
    syncAssignListFieldsVisibility();
  }

  const siteAccessModeSaveBtn = document.getElementById("site-access-mode-save");
  if (siteAccessModeSaveBtn) {
    siteAccessModeSaveBtn.addEventListener("click", () => {
      saveSiteAccessModeAdmin().catch(console.error);
    });
  }

  if (isAuthed()) {
    if (loginCard) loginCard.style.display = "none";
    if (panel) panel.style.display = "flex";
    await refreshData();
    await syncLocalStorageWithServerData().catch(console.error);
    await maybeMigrateLocalToApi();
    await ensureDefaultListsInApi();
    renderDashboard();
    await loadSiteAccessModeAdmin();
    renderLists();
    await refreshAssignListSelect();
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
        await syncLocalStorageWithServerData().catch(console.error);
        await maybeMigrateLocalToApi();
        await ensureDefaultListsInApi();
        renderDashboard();
        await loadSiteAccessModeAdmin();
        renderLists();
        await refreshAssignListSelect();
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
          await refreshAssignListSelect();
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
      await refreshAssignListSelect();
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
        <span class="blog-block-title" aria-hidden="true">&#9679;</span>
        <button type="button" class="admin-delete-btn blog-section-remove">Remove</button>
      </div>
      <div class="blog-field-group">
        <label class="admin-label" for="${beforeId}">Paragraph / heading</label>
        <textarea id="${beforeId}" class="admin-input blog-section-before" rows="3" placeholder="One short line becomes a heading on the site. Longer text becomes a normal paragraph."></textarea>
      </div>

      <div class="blog-field-row">
        <div class="blog-field-group">
          <label class="admin-label" for="${kindId}">Image size</label>
          <select id="${kindId}" class="admin-input blog-section-kind">
            <option value="photo">Normal</option>
            <option value="banner">Full width</option>
          </select>
        </div>
        <div class="blog-field-group blog-field-group--file">
          <label class="admin-label" for="${fileId}">Upload image</label>
          <input id="${fileId}" type="file" class="blog-section-file admin-input" accept="image/*" />
        </div>
      </div>

      <p class="blog-section-upload-status admin-small"></p>
      <div class="blog-section-preview-wrap">
        <img class="blog-section-preview blog-section-preview--photo" alt="" />
      </div>

      <div class="blog-field-group">
        <label class="admin-label" for="${afterId}">More text</label>
        <textarea id="${afterId}" class="admin-input blog-section-after" rows="4" placeholder="Add more article text here..."></textarea>
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

      const submitBtn = bannerForm.querySelector('button[type="submit"]');
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = "Saving…";
      }
      try {
        await addBanner({
          title,
          description: description || "",
          tmdbId,
          contentType,
          imageDataUrl: currentBannerImageDataUrl,
          createdAt: Date.now(),
        });
        currentBannerImageDataUrl = "";
        if (bannerPreviewWrap) bannerPreviewWrap.style.display = "none";
        if (bannerPreviewImg) bannerPreviewImg.src = "";
        await refreshData();
        renderBanners();
        if (bannerTitleInput) bannerTitleInput.value = "";
        if (bannerDescInput) bannerDescInput.value = "";
        if (bannerTmdbInput) bannerTmdbInput.value = "";
        if (bannerContentTypeSelect) bannerContentTypeSelect.value = "movie";
      } catch (err) {
        console.error(err);
        if (bannerErrorEl) {
          bannerErrorEl.textContent =
            err?.message || "Failed to save banner. Restart server and try again.";
        }
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = "Add Banner";
        }
      }
    });
  }

  if (bannersListEl) {
    bannersListEl.addEventListener("click", async (e) => {
      const btn = e.target?.closest?.("button");
      if (!btn?.classList?.contains("admin-delete-btn")) return;
      const bannerId = btn.dataset.bannerId;
      if (!bannerId) return;
      if (!confirm("Delete this banner?")) return;
      btn.disabled = true;
      try {
        await deleteBanner(bannerId);
        renderBanners();
        refreshData().catch(console.error);
      } catch (err) {
        console.error(err);
        alert(err?.message || "Could not delete banner.");
        refreshData()
          .then(() => renderBanners())
          .catch(console.error);
      } finally {
        btn.disabled = false;
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
            "Add an opening paragraph or at least one content block with text or image.";
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
        const delKey = btn.getAttribute("data-key") || "";
        const delTitle = btn.getAttribute("data-title") || delKey;
        const hint = {
          key: delKey,
          title: delTitle,
          tmdbId: btn.getAttribute("data-tmdb-id") || "",
          type: btn.getAttribute("data-type") || "",
        };
        if (!delKey && !delTitle) return;
        if (
          !confirm(
            `Permanently delete "${delTitle}" from the database and website?`
          )
        )
          return;
        btn.disabled = true;
        try {
          await deleteMovie(delKey, hint);
          renderDashboard();
          renderLists();
        } catch (err) {
          console.error(err);
          alert(err?.message || "Could not delete movie.");
          refreshData()
            .then(() => {
              renderDashboard();
              renderLists();
            })
            .catch(console.error);
        } finally {
          btn.disabled = false;
        }
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
      const excludeFromLists =
        document.getElementById("exclude-from-lists")?.checked === true;
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

      if (!excludeFromLists && !listName) {
        addTitleError.textContent =
          'Choose a list under "Assign to list", or tick "Search & Random only".';
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
        excludeFromLists,
        memberOfLists:
          !excludeFromLists && listName ? [listName] : [],
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

        if (!excludeFromLists) {
          await upsertList(listName);
          await assignMovieToList(listName, key);
        }
        await upsertMovie(movieRecord);

        cachedData.movies = cachedData.movies || {};
        cachedData.movies[key] = movieRecord;
        if (!excludeFromLists) {
          cachedData.lists = cachedData.lists || {};
          if (!Array.isArray(cachedData.lists[listName])) {
            cachedData.lists[listName] = [];
          }
          if (!cachedData.lists[listName].includes(key)) {
            cachedData.lists[listName].push(key);
          }
        }
        renderDashboard();
        renderLists();
        refreshData().catch((e) => console.warn("Background refresh:", e));

        const tmdbInput = document.getElementById("tmdb-id");
        if (tmdbInput) tmdbInput.value = "";
        const scriptInput = document.getElementById("download-fluid-script");
        if (scriptInput) scriptInput.value = "";
        const excludeCheckbox = document.getElementById("exclude-from-lists");
        if (excludeCheckbox) excludeCheckbox.checked = false;
        syncAssignListFieldsVisibility();
        addTitleSuccess.textContent = excludeFromLists
          ? `"${meta.title}" saved — search & Random rows only (not in any list).`
          : `"${meta.title}" saved — it will appear on the home page in list "${listName}".`;
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
      const editListSelect = document.getElementById("edit-movie-list-select");
      const editSearchOnly = document.getElementById("edit-movie-search-only");
      const selectedList = String(editListSelect?.value || "").trim();
      const searchOnly = editSearchOnly?.checked === true;
      if (!searchOnly && !selectedList) {
        alert("Choose a target list, or enable Search & Random only.");
        return;
      }
      if (movie.sourceKind !== "download") {
        try {
          await upsertMovie(movie);
          await updateMoviePlacement(currentEditMovieKey, selectedList, searchOnly);
          await refreshData();
          await refreshAssignListSelect();
          renderDashboard();
          renderLists();
          currentEditMovieKey = null;
          switchSection("dashboard-section");
        } catch (e) {
          console.error(e);
          alert(e?.message || "Could not save title changes.");
        }
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

      try {
        await upsertMovie(movie);
        await updateMoviePlacement(currentEditMovieKey, selectedList, searchOnly);
        await refreshData();
        await refreshAssignListSelect();
        renderDashboard();
        renderLists();
        currentEditMovieKey = null;
        switchSection("dashboard-section");
      } catch (e) {
        console.error(e);
        alert(e?.message || "Could not save title changes.");
      }
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
