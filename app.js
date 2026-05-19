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

async function fetchAllData() {
  const res = await fetch(`${API_BASE}/api/data`);
  if (!res.ok) throw new Error("Failed to load data");
  return await res.json();
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

async function fetchAllDataPreferApi() {
  try {
    const data = await fetchAllData();
    if (data?.movies && Object.keys(data.movies).length > 0) {
      return {
        movies: data.movies,
        lists: data.lists || {},
        banners: data.banners || [],
        listOrder: Array.isArray(data.listOrder) ? data.listOrder : [],
      };
    }
  } catch (err) {
    console.warn("API unavailable:", err);
  }

  const local = loadMovieDataLocal();
  if (local?.movies && Object.keys(local.movies).length > 0) {
    return local;
  }

  try {
    return await fetchAllData();
  } catch (_) {
    return { movies: {}, lists: {}, banners: [], listOrder: [] };
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
    item.addEventListener("click", () => navigateToMoviePlayer(movie, movieKey));
    const img = document.createElement("img");
    img.className = "movie-list-item-img";
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

  leftBtn.addEventListener("click", () => {
    wrapper.scrollBy({ left: -850, behavior: "smooth" });
  });
  rightBtn.addEventListener("click", () => {
    wrapper.scrollBy({ left: 850, behavior: "smooth" });
  });

  wrapper.appendChild(listEl);
  container.appendChild(wrapper);
  container.appendChild(leftBtn);
  container.appendChild(rightBtn);
  root.appendChild(container);
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
    if (custom.includes(n)) ordered.push(n);
  });
  custom
    .filter((n) => !ordered.includes(n))
    .sort((a, b) => a.localeCompare(b))
    .forEach((n) => ordered.push(n));
  return ordered;
}

async function renderDynamicLists() {
  const root = document.getElementById("dynamic-lists-root");
  if (!root) return;

  root.innerHTML =
    '<p class="home-status-msg">Loading movies…</p>';

  let data;
  try {
    data = await fetchAllDataPreferApi();
  } catch (err) {
    console.error(err);
    root.innerHTML =
      '<p class="home-status-msg home-status-msg--error">Movies load nahi ho paye. Server chalao: <code>node server.js</code> phir kholo <a href="http://localhost:3001">http://localhost:3001</a></p>';
    return;
  }

  const movies = data.movies || {};
  const allKeys = Object.keys(movies);

  if (!allKeys.length) {
    root.innerHTML =
      '<p class="home-status-msg">Abhi koi movie library me nahi. Admin panel se titles add karein.</p>';
    return;
  }

  root.innerHTML = "";

  const listNames = getOrderedCustomListNames(data);

  listNames.forEach((listName) => {
    let movieIds = (data.lists[listName] || []).filter((k) => movies[k]);
    movieIds = shuffleArray(movieIds);
    appendMovieListSection(root, data, listName, movieIds);
  });

  // Random rows at bottom: every title; 10 per row; shuffled each load.
  if (allKeys.length) {
    const shuffledAll = shuffleArray(allKeys);
    const parts = chunkArray(shuffledAll, RANDOM_ROW_SIZE);
    parts.forEach((chunkKeys, i) => {
      const title = i === 0 ? "Random" : `Random ${i + 1}`;
      appendMovieListSection(root, data, title, chunkKeys);
    });
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

document.addEventListener("DOMContentLoaded", () => {
  renderDynamicLists().catch(console.error);

  // Render top banner slider (admin-managed)
  initBannerSlider();

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

async function initBannerSlider() {
  const root = document.getElementById("banner-slider-root");
  if (!root) return;

  const data = await fetchAllDataPreferApi();
  const movies = data.movies || {};
  const banners = Array.isArray(data.banners) ? data.banners : [];
  if (!banners.length) {
    root.style.display = "none";
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
}
