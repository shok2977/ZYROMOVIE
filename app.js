// UTILITIES FOR MOVIE STORAGE

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

const HOME_DATA_CLIENT_CACHE_KEY = "flakes_home_data_v5";
const HOME_DATA_CLIENT_CACHE_MS = 60 * 1000;
const HOME_INVALIDATE_KEY = "flakes_home_invalidate";
let homeDataInflight = null;

function clearHomeDataClientCache() {
  try {
    sessionStorage.removeItem(HOME_DATA_CLIENT_CACHE_KEY);
  } catch (_) {}
}

function getHomeInvalidateSignal() {
  try {
    return Number(localStorage.getItem(HOME_INVALIDATE_KEY) || 0);
  } catch (_) {
    return 0;
  }
}

async function fetchAllData() {
  const revisionHint = getHomeInvalidateSignal();
  const url = `${API_BASE}/api/data${revisionHint ? `?v=${revisionHint}` : ""}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error("Failed to load data");
  return await res.json();
}

async function fetchHomeBanners() {
  const revisionHint = getHomeInvalidateSignal();
  const url = `${API_BASE}/api/banners${revisionHint ? `?v=${revisionHint}` : ""}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return [];
  const payload = await res.json().catch(() => ({}));
  const raw = Array.isArray(payload?.banners)
    ? payload.banners
    : Array.isArray(payload)
      ? payload
      : [];
  return raw.map((b) => ({
    ...b,
    id: b?.id || b?._id || "",
  }));
}

async function enrichHomeDataWithBanners(data) {
  const normalized = normalizeHomeData(data);
  try {
    const fresh = await fetchHomeBanners();
    if (fresh.length) {
      return { ...normalized, banners: fresh };
    }
  } catch (err) {
    console.warn("Banner fetch failed:", err);
  }
  return normalized;
}

function readHomeDataCache() {
  try {
    const raw = sessionStorage.getItem(HOME_DATA_CLIENT_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const invalidateAt = getHomeInvalidateSignal();
    if (parsed?.invalidateAt && parsed.invalidateAt < invalidateAt) {
      return null;
    }
    if (!parsed?.ts || Date.now() - parsed.ts > HOME_DATA_CLIENT_CACHE_MS) {
      return null;
    }
    return parsed.data || null;
  } catch (_) {
    return null;
  }
}

function writeHomeDataCache(data) {
  try {
    sessionStorage.setItem(
      HOME_DATA_CLIENT_CACHE_KEY,
      JSON.stringify({
        ts: Date.now(),
        invalidateAt: getHomeInvalidateSignal(),
        data,
      })
    );
  } catch (_) {}
}

function normalizeHomeData(data) {
  const movies = data?.movies || {};
  const listsRaw = data?.lists || {};
  const lists = {};
  Object.keys(listsRaw).forEach((name) => {
    lists[name] = (listsRaw[name] || []).filter((k) => {
      const movie = movies[k];
      return movie && !isExcludedFromCustomLists(movie);
    });
  });
  const banners = (Array.isArray(data?.banners) ? data.banners : []).map(
    (b) => ({
      ...b,
      id: b?.id || b?._id || "",
    })
  );
  return {
    movies,
    lists,
    banners,
    listOrder: Array.isArray(data?.listOrder) ? data.listOrder : [],
    dbReady: data?.dbReady !== false,
    revision: data?.revision,
  };
}

function homeMovieKeysSignature(data) {
  return Object.keys(data?.movies || {})
    .sort()
    .join("|");
}

function homeListsSignature(data) {
  return getOrderedCustomListNames(data).sort().join("|");
}

function homeBannersSignature(data) {
  return (data?.banners || [])
    .map((b) => String(b?.id || b?._id || ""))
    .filter(Boolean)
    .sort()
    .join("|");
}

function homeDataSignature(data) {
  return [
    homeMovieKeysSignature(data),
    homeListsSignature(data),
    homeBannersSignature(data),
    String(data?.revision ?? ""),
  ].join("::");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchAllDataFromApiWithRetry(maxAttempts = 5) {
  let last = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const data = await fetchAllData();
      last = data;
      const movieCount = Object.keys(data?.movies || {}).length;
      if (movieCount > 0 || data?.dbReady === true) return data;
    } catch (err) {
      if (attempt === maxAttempts - 1) throw err;
    }
    if (attempt < maxAttempts - 1) {
      await delay(350 * (attempt + 1));
    }
  }
  return (
    last || {
      movies: {},
      lists: {},
      listOrder: [],
      banners: [],
      dbReady: false,
    }
  );
}

// Fallback for current setup (admin still writes to localStorage).
// Once admin/player migrate fully, MongoDB will be the only source.
const STORAGE_KEY = "flakes_movies_data";
function loadMovieDataLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { movies: {}, lists: {}, banners: [] };
    const parsed = JSON.parse(raw);
    return {
      movies: parsed.movies || {},
      lists: parsed.lists || {},
      banners: parsed.banners || [],
      listOrder: Array.isArray(parsed.listOrder) ? parsed.listOrder : [],
    };
  } catch (_) {
    return { movies: {}, lists: {}, banners: [] };
  }
}

/** Keep browser localStorage in sync with MongoDB so deleted titles do not reappear on the site. */
function writeLocalStorageFromApiData(data) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        movies: data?.movies || {},
        lists: data?.lists || {},
        banners: data?.banners || [],
        listOrder: Array.isArray(data?.listOrder) ? data.listOrder : [],
      })
    );
  } catch (_) {}
}

async function fetchAllDataPreferApi() {
  if (homeDataInflight) return homeDataInflight;

  homeDataInflight = (async () => {
    try {
      const data = await fetchAllDataFromApiWithRetry();
      const normalized = await enrichHomeDataWithBanners(data);
      if (data?.dbReady === true) {
        writeHomeDataCache(normalized);
        writeLocalStorageFromApiData(normalized);
        return normalized;
      }
      if (Object.keys(normalized.movies || {}).length > 0) {
        writeHomeDataCache(normalized);
        writeLocalStorageFromApiData(normalized);
        return normalized;
      }
    } catch (err) {
      console.warn("API unavailable:", err);
    }

    const cached = readHomeDataCache();
    if (cached?.movies && Object.keys(cached.movies).length > 0) {
      return normalizeHomeData(cached);
    }

    const local = loadMovieDataLocal();
    if (local?.movies && Object.keys(local.movies).length > 0) {
      return normalizeHomeData(local);
    }

    try {
      const data = await fetchAllDataFromApiWithRetry(3);
      const normalized = await enrichHomeDataWithBanners(data);
      if (data?.dbReady === true || Object.keys(normalized.movies || {}).length > 0) {
        writeHomeDataCache(normalized);
        writeLocalStorageFromApiData(normalized);
      }
      return normalized;
    } catch (_) {
      return {
        movies: {},
        lists: {},
        banners: [],
        listOrder: [],
        dbReady: false,
      };
    }
  })();

  try {
    return await homeDataInflight;
  } finally {
    homeDataInflight = null;
  }
}

function getMovieIdKey(tmdbId, type) {
  return `${type}-${tmdbId}`;
}

/** Home page only: "Random" / "Random 2" … are built-in (not stored in DB). */
function isReservedRandomListName(name) {
  const t = String(name || "").trim();
  if (/^Random$/i.test(t)) return true;
  if (/^Random\s+\d+$/i.test(t)) return true;
  return false;
}

function isExcludedFromCustomLists(movie) {
  return movie?.excludeFromLists === true;
}

function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

const RANDOM_ROW_SIZE = 10;

function bindMovieItemActivation(item, onActivate) {
  let touchMoved = false;
  let touchStartX = 0;
  let touchStartY = 0;

  item.addEventListener(
    "touchstart",
    (e) => {
      const t = e.touches[0];
      if (!t) return;
      touchMoved = false;
      touchStartX = t.clientX;
      touchStartY = t.clientY;
    },
    { passive: true }
  );

  item.addEventListener(
    "touchmove",
    (e) => {
      const t = e.touches[0];
      if (!t) return;
      if (
        Math.abs(t.clientX - touchStartX) > 10 ||
        Math.abs(t.clientY - touchStartY) > 10
      ) {
        touchMoved = true;
      }
    },
    { passive: true }
  );

  item.addEventListener("touchend", () => {
    if (!touchMoved) onActivate();
  });

  item.addEventListener("click", () => {
    if ("ontouchstart" in window) return;
    onActivate();
  });
}

function navigateToMoviePlayer(movie, movieKey) {
  if (
    movie.sourceKind === "download" &&
    (movie.type === "tv" || movie.type === "anime") &&
    Array.isArray(movie.seasons) &&
    movie.seasons.length
  ) {
    const firstSeason = movie.seasons[0];
    const firstEp =
      (firstSeason.episodes &&
        firstSeason.episodes[0] &&
        firstSeason.episodes[0].episode_number) ||
      1;
    const url = new URL("player-lang.html", window.location.href);
    url.searchParams.set("key", movieKey);
    url.searchParams.set("season", String(firstSeason.season_number));
    url.searchParams.set("episode", String(firstEp));
    url.searchParams.set("lang", "0");
    window.location.href = url.toString();
  } else {
    window.location.href = `player.html?key=${encodeURIComponent(movieKey)}`;
  }
}

function appendMovieListSection(root, data, listTitle, movieKeys) {
  if (!movieKeys.length) return;

  const container = document.createElement("div");
  container.className = "movie-list-container";

  const titleEl = document.createElement("h1");
  titleEl.className = "movie-list-title";
  titleEl.textContent = listTitle;
  container.appendChild(titleEl);

  const wrapper = document.createElement("div");
  wrapper.className = "movie-list-wrapper";

  const leftBtn = document.createElement("button");
  leftBtn.type = "button";
  leftBtn.className = "movie-list-nav movie-list-nav-left";
  leftBtn.setAttribute("aria-label", "Scroll left");
  leftBtn.textContent = "<";

  const rightBtn = document.createElement("button");
  rightBtn.type = "button";
  rightBtn.className = "movie-list-nav movie-list-nav-right";
  rightBtn.setAttribute("aria-label", "Scroll right");
  rightBtn.textContent = ">";

  const listEl = document.createElement("div");
  listEl.className = "movie-list";

  movieKeys.forEach((movieKey) => {
    const movie = data.movies[movieKey];
    if (!movie) return;

    const item = document.createElement("div");
    item.className = "movie-list-item";
    item.dataset.movieKey = movieKey;
    bindMovieItemActivation(item, () =>
      navigateToMoviePlayer(movie, movieKey)
    );
    const img = document.createElement("img");
    img.className = "movie-list-item-img";
    img.loading = "lazy";
    img.decoding = "async";
    img.src = movie.posterUrl || "img/1.jpeg";
    img.alt = movie.title || "";

    const caption = document.createElement("p");
    caption.className = "movie-list-item-caption";
    caption.textContent = movie.title || "Untitled";

    item.appendChild(img);
    item.appendChild(caption);
    listEl.appendChild(item);
  });

  // NOTE: sliding should only happen via buttons (no wheel/touch scroll).

  const updateEdges = () => {
    const max = Math.max(0, wrapper.scrollWidth - wrapper.clientWidth);
    const left = Math.max(0, wrapper.scrollLeft || 0);
    const atStart = left <= 2;
    const atEnd = left >= max - 2;
    container.classList.toggle("movie-list-container--at-start", atStart);
    container.classList.toggle("movie-list-container--at-end", atEnd);
    leftBtn.disabled = atStart;
    rightBtn.disabled = atEnd;
  };

  leftBtn.addEventListener("click", () => {
    wrapper.scrollBy({ left: -850, behavior: "smooth" });
    window.setTimeout(updateEdges, 260);
  });
  rightBtn.addEventListener("click", () => {
    wrapper.scrollBy({ left: 850, behavior: "smooth" });
    window.setTimeout(updateEdges, 260);
  });

  const showRowNav = () => container.classList.add("movie-list-container--nav-visible");
  const hideRowNav = () => container.classList.remove("movie-list-container--nav-visible");

  container.addEventListener("mouseenter", () => {
    showRowNav();
  });
  container.addEventListener("mouseleave", () => {
    hideRowNav();
  });
  container.addEventListener("focusin", () => {
    showRowNav();
  });
  container.addEventListener("focusout", (e) => {
    if (!container.contains(e.relatedTarget)) hideRowNav();
  });

  wrapper.appendChild(listEl);
  container.appendChild(wrapper);
  container.appendChild(leftBtn);
  container.appendChild(rightBtn);
  root.appendChild(container);

  // Initial edge state + keep it accurate on resize/scroll.
  updateEdges();
  wrapper.addEventListener("scroll", () => {
    if (container.classList.contains("movie-list-container--nav-visible")) updateEdges();
  });
  window.addEventListener("resize", updateEdges);
}

// RENDER LISTS ON HOME PAGE (DYNAMIC)

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

async function renderDynamicLists(dataIn) {
  const root = document.getElementById("dynamic-lists-root");
  if (!root) return;

  if (!dataIn) {
    root.innerHTML =
      '<p class="home-status-msg">Loading movies…</p>';
  }

  let data = dataIn;
  if (!data) {
    try {
      data = await fetchAllDataPreferApi();
    } catch (err) {
      console.error(err);
      root.innerHTML =
        '<p class="home-status-msg home-status-msg--error">Could not load movies. Start the server: <code>node server.js</code> then open <a href="http://localhost:3001">http://localhost:3001</a></p>';
      return;
    }
  }

  const movies = data.movies || {};
  const allKeys = Object.keys(movies);

  if (!allKeys.length) {
    if (data.dbReady === false) {
      root.innerHTML =
        '<p class="home-status-msg">Connecting to the library…</p>';
      return;
    }
    root.innerHTML =
      '<p class="home-status-msg">No titles in the library yet. Add titles from the admin panel.</p>';
    return;
  }

  root.innerHTML = "";

  const listNames = getOrderedCustomListNames(data);

  const yieldToMain = () =>
    new Promise((resolve) => requestAnimationFrame(() => resolve()));

  for (const listName of listNames) {
    let movieIds = (data.lists[listName] || []).filter((k) => {
      const movie = movies[k];
      return movie && !isExcludedFromCustomLists(movie);
    });
    movieIds = shuffleArray(movieIds);
    if (!movieIds.length) continue;
    appendMovieListSection(root, data, listName, movieIds);
    // Prevent long blocking renders for huge libraries.
    await yieldToMain();
  }

  // Random rows at bottom: every title; 10 per row; shuffled each load.
  if (allKeys.length) {
    const shuffledAll = shuffleArray(allKeys);
    const parts = chunkArray(shuffledAll, RANDOM_ROW_SIZE);
    for (let i = 0; i < parts.length; i++) {
      const chunkKeys = parts[i];
      const title = i === 0 ? "Random" : `Random ${i + 1}`;
      appendMovieListSection(root, data, title, chunkKeys);
      await yieldToMain();
    }
  }
}

// SEARCH (popup modal — title + tags + overview)

function tokenizeSearchQuery(query) {
  return String(query || "")
    .trim()
    .toLowerCase()
    .split(/[\s,]+/)
    .filter((t) => t.length >= 1);
}

function movieSearchHaystack(movie) {
  const typeLabel =
    movie.type === "tv"
      ? "tv show series"
      : movie.type === "anime"
        ? "anime"
        : movie.type === "animeMovie"
          ? "anime movie"
          : "movie";
  return [
    movie.title,
    movie.overview,
    movie.tags,
    typeLabel,
    movie.type,
    movie.tmdbId,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function parseMovieTagList(tagsStr) {
  return String(tagsStr || "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

function scoreMovieForSearch(movie, tokens) {
  const title = String(movie.title || "").toLowerCase();
  const tagsRaw = String(movie.tags || "").toLowerCase();
  const tagList = parseMovieTagList(movie.tags);
  const overview = String(movie.overview || "").toLowerCase();
  const hay = movieSearchHaystack(movie);
  let score = 0;
  const fullQ = tokens.join(" ");
  if (fullQ && title.includes(fullQ)) score += 40;
  if (fullQ && tagsRaw.includes(fullQ)) score += 35;
  if (fullQ && overview.includes(fullQ)) score += 22;
  if (fullQ && hay.includes(fullQ)) score += 10;

  tagList.forEach((tag) => {
    if (fullQ && (tag === fullQ || tag.includes(fullQ))) score += 38;
    tokens.forEach((t) => {
      if (t && (tag === t || tag.includes(t))) score += 18;
    });
  });

  tokens.forEach((t) => {
    if (!t) return;
    if (title === t) score += 50;
    else if (title.startsWith(t)) score += 25;
    else if (title.includes(t)) score += 12;
    if (overview.includes(t)) score += 6;
    if (hay.includes(t)) score += 4;
  });
  return score;
}

function findMovieSearchMatches(moviesObj, query) {
  const tokens = tokenizeSearchQuery(query);
  if (!tokens.length) return [];
  return Object.entries(moviesObj || {})
    .map(([movieKey, movie]) => ({
      movieKey,
      movie,
      score: scoreMovieForSearch(movie, tokens),
    }))
    .filter((row) => row.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.movie.title || "").localeCompare(b.movie.title || "")
    );
}

let searchModalBound = false;

function bindSearchModal() {
  if (searchModalBound) return;
  const modal = document.getElementById("search-modal");
  if (!modal) return;
  searchModalBound = true;

  const close = () => closeSearchModal();
  document.getElementById("search-modal-close")?.addEventListener("click", close);
  modal.querySelectorAll("[data-search-close]").forEach((el) => {
    el.addEventListener("click", close);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.hidden) closeSearchModal();
  });
}

function openSearchModal() {
  const modal = document.getElementById("search-modal");
  if (!modal) return;
  modal.hidden = false;
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("search-modal-open");
}

function closeSearchModal() {
  const modal = document.getElementById("search-modal");
  if (!modal) return;
  modal.hidden = true;
  modal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("search-modal-open");
}

function renderSearchModalResults(matches, query) {
  const resultsEl = document.getElementById("search-modal-results");
  const emptyEl = document.getElementById("search-modal-empty");
  const queryEl = document.getElementById("search-modal-query");
  const titleEl = document.getElementById("search-modal-title");
  if (!resultsEl) return;

  const q = String(query || "").trim();
  if (queryEl) {
    queryEl.textContent = q
      ? `Results for “${q}” (${matches.length})`
      : "";
  }
  if (titleEl) titleEl.textContent = "Search";

  resultsEl.innerHTML = "";

  if (!matches.length) {
    if (emptyEl) emptyEl.hidden = false;
    return;
  }
  if (emptyEl) emptyEl.hidden = true;

  matches.forEach(({ movieKey, movie }) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "search-modal-card";
    card.addEventListener("click", () => {
      closeSearchModal();
      navigateToMoviePlayer(movie, movieKey);
    });

    const img = document.createElement("img");
    img.className = "search-modal-card-img";
    img.src = movie.posterUrl || "img/1.jpeg";
    img.alt = movie.title || "";
    img.loading = "lazy";

    const meta = document.createElement("div");
    meta.className = "search-modal-card-meta";

    const name = document.createElement("h3");
    name.className = "search-modal-card-title";
    name.textContent = movie.title || "Untitled";

    const sub = document.createElement("p");
    sub.className = "search-modal-card-sub";
    const typeBits =
      movie.type === "tv"
        ? "TV"
        : movie.type === "anime"
          ? "Anime"
          : movie.type === "animeMovie"
            ? "Anime Movie"
            : "Movie";
    const tagLine = String(movie.tags || "").trim();
    sub.textContent = tagLine ? `${typeBits} · ${tagLine}` : typeBits;

    meta.appendChild(name);
    meta.appendChild(sub);
    card.appendChild(img);
    card.appendChild(meta);
    resultsEl.appendChild(card);
  });
}

async function performSearch(query) {
  const trimmed = String(query || "").trim();
  bindSearchModal();

  if (!trimmed) {
    closeSearchModal();
    return;
  }

  openSearchModal();
  const resultsEl = document.getElementById("search-modal-results");
  const emptyEl = document.getElementById("search-modal-empty");
  if (resultsEl) {
    resultsEl.innerHTML = '<p class="search-modal-loading">Searching…</p>';
  }
  if (emptyEl) emptyEl.hidden = true;

  let matches = [];
  try {
    const res = await fetch(
      `${API_BASE}/api/search?q=${encodeURIComponent(trimmed)}`
    );
    if (res.ok) {
      const payload = await res.json();
      matches = Array.isArray(payload.matches) ? payload.matches : [];
    }
  } catch (_) {}

  if (!matches.length) {
    const data = await fetchAllDataPreferApi();
    matches = findMovieSearchMatches(data.movies, trimmed);
  }

  renderSearchModalResults(matches, trimmed);
}

async function initHomePage() {
  try {
    const modeRes = await fetch(`${API_BASE}/api/site/mode`);
    if (modeRes.ok) {
      const modeData = await modeRes.json();
      if (modeData?.accessMode === "blogs_only") {
        window.location.replace(`${API_BASE}/blog.html`);
        return;
      }
    }
  } catch (_) {}

  const cached = readHomeDataCache();
  const hasCached =
    cached?.movies && Object.keys(cached.movies).length > 0;
  let cachedNorm = null;

  if (hasCached) {
    cachedNorm = normalizeHomeData(cached);
    renderDynamicLists(cachedNorm).catch(console.error);
    if ((cachedNorm.banners || []).length > 0) {
      initBannerSlider(cachedNorm).catch(console.error);
    }
  }

  const data = await fetchAllDataPreferApi();
  const freshSig = homeDataSignature(data);
  const cachedSig = cachedNorm ? homeDataSignature(cachedNorm) : "";

  if (!hasCached || cachedSig !== freshSig) {
    await renderDynamicLists(data);
  }

  // Always sync banner slider from latest API (banners can change without movie/list changes)
  await initBannerSlider(data);
}

document.addEventListener("DOMContentLoaded", () => {
  window.addEventListener("storage", (e) => {
    if (e.key === HOME_INVALIDATE_KEY) {
      clearHomeDataClientCache();
      initHomePage().catch(console.error);
    }
  });
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) initHomePage().catch(console.error);
  });
  initHomePage().catch(console.error);

  const searchInput = document.getElementById("search-input");
  const searchButton = document.getElementById("search-button");

  if (searchInput) {
    searchInput.addEventListener("keyup", (e) => {
      if (e.key === "Enter") {
        performSearch(searchInput.value);
      }
    });
  }

  if (searchButton && searchInput) {
    searchButton.addEventListener("click", () => {
      performSearch(searchInput.value);
    });
  }

  bindSearchModal();

  const urlQ = new URLSearchParams(window.location.search).get("q");
  if (urlQ && searchInput) {
    searchInput.value = urlQ;
    performSearch(urlQ);
  }
});

async function initBannerSlider(dataIn) {
  const root = document.getElementById("banner-slider-root");
  if (!root) return;

  const data = normalizeHomeData(dataIn || (await fetchAllDataPreferApi()));
  const movies = data.movies || {};
  let banners = [];
  try {
    banners = (await fetchHomeBanners()).filter((b) =>
      String(b?.imageDataUrl || "").trim()
    );
  } catch (_) {
    banners = (data.banners || []).filter((b) =>
      String(b?.imageDataUrl || "").trim()
    );
  }
  if (!banners.length) {
    root.style.display = "none";
    root.innerHTML = "";
    return;
  }

  const multi = banners.length > 1;
  root.style.display = "block";
  root.innerHTML = "";

  let currentIndex = 0;
  let timerId = null;
  let suppressClick = false;

  const slideHost = document.createElement("div");
  slideHost.className = "banner-slide-host";
  const track = document.createElement("div");
  track.className = "banner-track";
  slideHost.appendChild(track);
  root.appendChild(slideHost);

  if (multi) {
    const controls = document.createElement("div");
    controls.className = "banner-controls";

    const prevBtn = document.createElement("button");
    prevBtn.type = "button";
    prevBtn.className = "banner-control-btn";
    prevBtn.setAttribute("aria-label", "Previous banner");
    prevBtn.innerHTML = "&#10094;";
    prevBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      userGoTo(currentIndex - 1);
    });

    const nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.className = "banner-control-btn";
    nextBtn.setAttribute("aria-label", "Next banner");
    nextBtn.innerHTML = "&#10095;";
    nextBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      userGoTo(currentIndex + 1);
    });

    controls.appendChild(prevBtn);
    controls.appendChild(nextBtn);
    slideHost.appendChild(controls);
  }

  const dotsHost = document.createElement("div");
  dotsHost.className = "banner-dots";
  if (multi) root.appendChild(dotsHost);

  const openBannerMovie = (banner) => {
    goToBannerTarget(banner, movies);
  };

  const buildSlide = (banner) => {
    const slide = document.createElement("div");
    slide.className = "banner-slide";

    const img = document.createElement("img");
    img.className = "banner-slide-img";
    img.src = banner.imageDataUrl || "";
    img.alt = banner.title || "Banner";
    img.decoding = "async";
    img.draggable = false;
    slide.appendChild(img);

    const overlay = document.createElement("div");
    overlay.className = "banner-slide-overlay";

    const title = document.createElement("div");
    title.className = "banner-slide-title";
    title.textContent = banner.title || "";
    overlay.appendChild(title);

    const desc = document.createElement("p");
    desc.className = "banner-slide-desc";
    desc.textContent = banner.description || "";
    overlay.appendChild(desc);

    const cta = document.createElement("button");
    cta.type = "button";
    cta.className = "banner-slide-cta";
    cta.textContent = "Play Now";
    cta.addEventListener("click", (e) => {
      e.stopPropagation();
      openBannerMovie(banner);
    });
    overlay.appendChild(cta);

    slide.appendChild(overlay);
    slide.addEventListener("click", () => {
      if (suppressClick) return;
      openBannerMovie(banner);
    });
    return slide;
  };

  const slideEls = banners.map((b) => buildSlide(b));

  slideEls.forEach((el) => {
    track.appendChild(el);
  });

  const updateTrack = () => {
    const w = slideHost.clientWidth || 0;
    track.style.transform = w ? `translateX(-${currentIndex * w}px)` : "";
    slideEls.forEach((el, i) => {
      el.classList.toggle("active", i === currentIndex);
    });
  };

  const renderDots = () => {
    if (!multi) return;
    dotsHost.innerHTML = "";
    banners.forEach((_, i) => {
      const dot = document.createElement("button");
      dot.className = "banner-dot" + (i === currentIndex ? " active" : "");
      dot.type = "button";
      dot.setAttribute("aria-label", `Go to banner ${i + 1}`);
      dot.addEventListener("click", () => userGoTo(i));
      dotsHost.appendChild(dot);
    });
  };

  const goTo = (idx) => {
    if (!banners.length) return;
    currentIndex = (idx + banners.length) % banners.length;
    updateTrack();
    renderDots();
  };

  const userGoTo = (idx) => {
    goTo(idx);
    restartAutoSlide();
  };

  const stopTimer = () => {
    if (timerId) clearInterval(timerId);
    timerId = null;
  };

  const restartAutoSlide = () => {
    stopTimer();
    if (!multi) return;
    timerId = setInterval(() => {
      goTo(currentIndex + 1);
    }, 5000);
  };

  let touchStartX = 0;
  let touchStartY = 0;
  let dragging = false;

  const onPointerDown = (clientX, clientY) => {
    if (!multi) return;
    dragging = true;
    touchStartX = clientX;
    touchStartY = clientY;
  };

  const onPointerUp = (clientX, clientY) => {
    if (!dragging) return;
    dragging = false;
    const dx = clientX - touchStartX;
    const dy = clientY - touchStartY;
    if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy)) return;
    suppressClick = true;
    setTimeout(() => {
      suppressClick = false;
    }, 320);
    if (dx < 0) userGoTo(currentIndex + 1);
    else userGoTo(currentIndex - 1);
  };

  slideHost.addEventListener(
    "touchstart",
    (e) => {
      const t = e.changedTouches?.[0];
      if (!t) return;
      onPointerDown(t.clientX, t.clientY);
    },
    { passive: true }
  );
  slideHost.addEventListener(
    "touchend",
    (e) => {
      const t = e.changedTouches?.[0];
      if (!t) return;
      onPointerUp(t.clientX, t.clientY);
    },
    { passive: true }
  );
  slideHost.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    onPointerDown(e.clientX, e.clientY);
  });
  slideHost.addEventListener("mouseup", (e) => {
    if (e.button !== 0) return;
    onPointerUp(e.clientX, e.clientY);
  });

  root.addEventListener("keydown", (e) => {
    if (!multi) return;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      userGoTo(currentIndex - 1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      userGoTo(currentIndex + 1);
    }
  });
  root.tabIndex = 0;

  window.addEventListener("resize", updateTrack);

  goTo(0);
  requestAnimationFrame(updateTrack);
  restartAutoSlide();
}

function goToBannerTarget(banner, moviesFromCaller) {
  const movies = moviesFromCaller || {};
  const movieKey = String(banner?.movieKey || "").trim();
  if (movieKey && movies[movieKey]) {
    navigateToMoviePlayer(movies[movieKey], movieKey);
    return;
  }

  const tmdbId = String(banner?.tmdbId || "").trim();
  if (!tmdbId) return;

  if (banner.contentType) {
    const targetKey = `${banner.contentType}-${tmdbId}`;
    if (movies[targetKey]) {
      navigateToMoviePlayer(movies[targetKey], targetKey);
      return;
    }
  }

  for (const key of Object.keys(movies)) {
    const m = movies[key];
    if (m && String(m.tmdbId) === tmdbId) {
      navigateToMoviePlayer(m, key);
      return;
    }
  }

  if (banner.contentType) {
    window.location.href = `player.html?key=${encodeURIComponent(
      `${banner.contentType}-${tmdbId}`
    )}`;
  }
}
