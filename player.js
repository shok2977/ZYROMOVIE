const STORAGE_KEY = "flakes_movies_data";

// Default = Google demo tag only so local testing shows a real preroll. Production: put YOUR
// Ad Manager / GAM / third-party VAST URL here — the player does not whitelist domains; IMA loads
// whatever tag you give. If the server returns empty VAST (no <Ad>), you get no ad on ANY tag.
// Optional test override: player.html?key=...&adtag=ENCODED_FULL_TAG_URL
const VAST_TAG_URL_BASE =
  "https://exalted-engineering.com/d/mAFRzYd.GdNhvQZbG/UJ/ie/ms9nu/ZrUslHkNP_TNYc5kNhzlYxwCNiDIUBtxNQjikq3/N_jJA/0pOBQs";

// Use same-origin API in producti(on Renedr), still works locally.
const API_BASE =
  window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
    ? "http://localhost:3001"
    : "";

function getEffectiveVastTagBase() {
  const raw = getQueryParam("adtag");
  if (raw && String(raw).trim()) {
    try {
      return decodeURIComponent(String(raw).trim());
    } catch (_) {
      return String(raw).trim();
    }
  }
  return String(VAST_TAG_URL_BASE || "").trim();
}

function buildVastTagUrl() {
  const base = getEffectiveVastTagBase();
  if (!base) return "";
  // NOTE: Adding a random correlator disables caching and can make VAST slower
  // (extra redirects + no CDN warmup). Many networks don't need it.
  // If you ever need forced no-cache, pass player.html?...&adtag=<url-with-your-own-cachebust>.
  return base;
}

// Keep one VAST URL per page-load so we can prefetch it early.
let _sessionVastTagUrl = null;
function getSessionVastTagUrl() {
  if (_sessionVastTagUrl) return _sessionVastTagUrl;
  _sessionVastTagUrl = buildVastTagUrl();
  return _sessionVastTagUrl;
}

let _preloadedVast = null;
function preloadAds() {
  try {
    const vastBaseForCheck = getEffectiveVastTagBase();
    const hasVast = !!(vastBaseForCheck && String(vastBaseForCheck).trim());
    if (!hasVast) return;

    const vastTagUrl = getSessionVastTagUrl();
    if (!vastTagUrl) return;

    // Fire and forget: warm up redirects + CDN + our proxy route.
    const proxyUrl =
      `${API_BASE}/api/vast/proxy?tag=` + encodeURIComponent(vastTagUrl);
    const mediaUrl =
      `${API_BASE}/api/vast/media?tag=` + encodeURIComponent(vastTagUrl);

    _preloadedVast = {
      vastTagUrl,
      proxyUrl,
      mediaPromise: fetch(mediaUrl).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      proxyPromise: fetch(proxyUrl).catch(() => null),
    };
  } catch (_) {}
}

async function fetchAllData() {
  const res = await fetch(`${API_BASE}/api/data`);
  if (!res.ok) throw new Error("Failed to load data");
  return await res.json();
}

async function loadMovieDataPreferApi(movieKey) {
  try {
    const data = await fetchAllData();
    if (data?.movies && data.movies[movieKey]) return data;
  } catch (_) {}
  return loadMovieData();
}

function loadMovieData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { movies: {}, lists: {} };
    const parsed = JSON.parse(raw);
    return { movies: parsed.movies || {}, lists: parsed.lists || {} };
  } catch (e) {
    return { movies: {}, lists: {} };
  }
}

function getQueryParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

function buildVidsrcUrl(movie, season, episode, animeDub) {
  const id = movie.tmdbId;
  if (movie.type === "movie" || movie.type === "animeMovie") {
    return `https://vidsrc.icu/embed/movie/${id}`;
  }
  if (movie.type === "anime") {
    const ep = episode !== undefined ? episode : 1;
    const dub = animeDub || "sub";
    return `https://vidsrc.icu/embed/anime/${id}/${ep}/${dub}`;
  }
  if (movie.type === "tv") {
    const s = season !== undefined ? season : 1;
    const e = episode !== undefined ? episode : 1;
    return `https://vidsrc.icu/embed/tv/${id}/${s}/${e}`;
  }
  return `https://vidsrc.icu/embed/movie/${id}`;
}

const STREAMMAFIA_QUERY =
  "?autoplay=false&autonext=true&audio=true&title=true&download=false&setting=true&episodelist=true&watchparty=false&chromecast=true&pip=true&nextbutton=true&hidecontrols=false&primarycolor=f00000&secondarycolor=000000&iconcolor=43ff0f&iconsize=1&logowidth=100px&font=Roboto&fontcolor=ffffff&fontsize=20&opacity=0.50&glasscolor=000000&glassopacity=65&glassblur=20&subtitle=Off&subdelay=0&subtextsize=45&subtextcolor=ffffff&subcapitalize=false&subbold=false&subfont=Roboto&subbgenabled=false&subbgcolor=000000&subbgopacity=0&subbgblur=0";

function buildStreammafiaUrl(movie, season, episode) {
  const id = movie.tmdbId;
  if (movie.type === "movie" || movie.type === "animeMovie") {
    return `https://embed.streammafia.to/embed/movie/${id}${STREAMMAFIA_QUERY}`;
  }
  const s = season !== undefined ? season : 1;
  const e = episode !== undefined ? episode : 1;
  return `https://embed.streammafia.to/embed/tv/${id}/${s}/${e}${STREAMMAFIA_QUERY}`;
}

function computeAnimeLinearEpisode(seasons, seasonNum, episodeNum) {
  let linear = 0;
  for (const s of seasons || []) {
    if (s.season_number < seasonNum) {
      linear += (s.episodes || []).length;
    } else if (s.season_number === seasonNum) {
      linear += episodeNum;
      return linear;
    }
  }
  return 1;
}

function showContent(url) {
  const box = document.getElementById("player-box");
  if (!box) return;
  box.innerHTML = `<iframe src="${url}" allowfullscreen allow="autoplay; encrypted-media"></iframe>`;
}

// Short MP4 so Video.js + contrib-ads have real content; preroll runs before this plays.
// (Removed) placeholder preview video: we want ad to be the first thing shown.

function formatTime(totalSeconds) {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function attachAdUi(player, opts) {
  const durationSeconds =
    opts && Number.isFinite(opts.durationSeconds) ? opts.durationSeconds : null;
  const skipOffsetSeconds =
    opts && Number.isFinite(opts.skipOffsetSeconds) ? opts.skipOffsetSeconds : null;
  const onSkip = opts && typeof opts.onSkip === "function" ? opts.onSkip : null;

  // Hide default controls so user can't seek (no forward/back scrubber).
  try {
    player.controls(false);
  } catch (_) {}

  const box = document.getElementById("player-box");
  if (!box) return () => {};

  box.style.position = "relative";

  const overlay = document.createElement("div");
  overlay.className = "ad-overlay-ui";
  overlay.style.position = "absolute";
  overlay.style.left = "0";
  overlay.style.right = "0";
  overlay.style.bottom = "0";
  overlay.style.padding = "10px 12px";
  overlay.style.background =
    "linear-gradient(to top, rgba(0,0,0,0.75), rgba(0,0,0,0.0))";
  overlay.style.pointerEvents = "none";

  const topRow = document.createElement("div");
  topRow.style.display = "flex";
  topRow.style.alignItems = "center";
  topRow.style.justifyContent = "space-between";
  topRow.style.gap = "10px";

  const timeEl = document.createElement("div");
  timeEl.style.color = "#fff";
  timeEl.style.fontSize = "13px";
  timeEl.style.fontWeight = "700";
  timeEl.textContent = "Ad";

  const skipBtn = document.createElement("button");
  skipBtn.type = "button";
  skipBtn.textContent = "Skip Ad";
  skipBtn.style.pointerEvents = "auto";
  skipBtn.style.display = "none";
  skipBtn.style.padding = "8px 10px";
  skipBtn.style.borderRadius = "10px";
  skipBtn.style.border = "1px solid rgba(255,255,255,0.35)";
  skipBtn.style.background = "rgba(0,0,0,0.45)";
  skipBtn.style.color = "#fff";
  skipBtn.style.fontSize = "13px";
  skipBtn.style.fontWeight = "800";
  skipBtn.addEventListener("click", () => {
    if (onSkip) onSkip();
  });

  topRow.appendChild(timeEl);
  topRow.appendChild(skipBtn);
  overlay.appendChild(topRow);

  const bar = document.createElement("div");
  bar.style.marginTop = "10px";
  bar.style.height = "3px";
  bar.style.width = "100%";
  bar.style.background = "rgba(255,255,255,0.25)";
  bar.style.borderRadius = "999px";
  bar.style.overflow = "hidden";

  const barInner = document.createElement("div");
  barInner.style.height = "100%";
  barInner.style.width = "0%";
  barInner.style.background = "#ffd400"; // yellow line
  bar.appendChild(barInner);
  overlay.appendChild(bar);

  box.appendChild(overlay);

  let lastTime = 0;
  const preventSeek = () => {
    try {
      const ct = player.currentTime();
      if (Math.abs(ct - lastTime) > 0.75) {
        player.currentTime(lastTime);
      }
    } catch (_) {}
  };

  const onTimeUpdate = () => {
    let ct = 0;
    try {
      ct = player.currentTime() || 0;
    } catch (_) {}
    lastTime = ct;

    const d = durationSeconds || player.duration?.() || 0;
    if (d && Number.isFinite(d) && d > 0) {
      barInner.style.width = `${Math.max(0, Math.min(100, (ct / d) * 100))}%`;
      timeEl.textContent = `Ad ${formatTime(ct)} / ${formatTime(d)}`;
    } else {
      timeEl.textContent = `Ad ${formatTime(ct)}`;
    }

    if (skipOffsetSeconds != null && Number.isFinite(skipOffsetSeconds)) {
      skipBtn.style.display = "inline-flex";
      if (ct >= skipOffsetSeconds) {
        skipBtn.textContent = "Skip Ad";
      } else {
        skipBtn.textContent = `Skip in ${Math.ceil(skipOffsetSeconds - ct)}s`;
      }
    } else {
      skipBtn.style.display = "none";
    }
  };

  const onKeyDown = (e) => {
    const k = e.key;
    if (
      k === "ArrowLeft" ||
      k === "ArrowRight" ||
      k === "j" ||
      k === "l" ||
      k === "J" ||
      k === "L"
    ) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  player.on("seeking", preventSeek);
  player.on("timeupdate", onTimeUpdate);
  document.addEventListener("keydown", onKeyDown, true);
  onTimeUpdate();

  return () => {
    try {
      player.off("seeking", preventSeek);
      player.off("timeupdate", onTimeUpdate);
    } catch (_) {}
    document.removeEventListener("keydown", onKeyDown, true);
    try {
      overlay.remove();
    } catch (_) {}
  };
}

function runAdThenContent(url) {
  const box = document.getElementById("player-box");
  if (!box) return;

  box.innerHTML = `
    <video
      id="ad-player"
      class="video-js vjs-default-skin vjs-big-play-centered"
      controls
      playsinline
      width="100%"
      height="500"
    ></video>
  `;

  const vastBaseForCheck = getEffectiveVastTagBase();
  const hasVast =
    vastBaseForCheck && vastBaseForCheck !== "https://pubads.g.doubleclick.net/gampad/ads?sz=400x300&iu=/124319096/external/single_ad_samples&ciu_szs=300x250&impl=s&gdfp_req=1&env=vp&output=vast&unviewed_position_start=1&cust_params=deployment%3Ddevsite&correlator=";
  if (!hasVast) {
    showContent(url);
    return;
  }

  const vastTagUrl = (_preloadedVast && _preloadedVast.vastTagUrl) || getSessionVastTagUrl();
  if (!vastTagUrl) {
    showContent(url);
    return;
  }

  const imaPageUrl = (function () {
    try {
      const h = String(window.location.href || "");
      if (h && !h.startsWith("file:")) return h;
    } catch (_) {}
    return "http://localhost:3001/player.html";
  })();

  const startedAtMs = Date.now();
  const MIN_AD_WAIT_MS = 60000; // at least 60s wait for slow ad tags/CDNs
  let scheduledFallback = false;
  let shownContent = false;
  let cleanupAdUi = null;
  const player = videojs("ad-player", {
    controls: true,
    autoplay: true,
    muted: true,
    playsinline: true,
    preload: "auto",
    fluid: false,
    width: "100%",
    height: 500,
  });

  function safeShowContent(reason) {
    if (shownContent) return;
    // If ad fails quickly, still wait a bit before falling back to content.
    // This helps slow VAST/redirect chains that often trigger early errors.
    const elapsed = Date.now() - startedAtMs;
    if (elapsed < MIN_AD_WAIT_MS) {
      if (!scheduledFallback) {
        scheduledFallback = true;
        setTimeout(() => safeShowContent("min-wait-elapsed"), MIN_AD_WAIT_MS - elapsed);
      }
      return;
    }
    shownContent = true;
    try {
      if (cleanupAdUi) cleanupAdUi();
      cleanupAdUi = null;
    } catch (_) {}
    try {
      player.dispose();
    } catch (_) {}
    try {
      showContent(url);
    } catch (_) {}
  }

  player.ready(function () {
    // Fast path: try to play the VAST MP4 mediafile directly (prefetched/cached),
    // so the very first thing the user sees is the ad (no stock preview video).
    (async () => {
      try {
        const j =
          (_preloadedVast && (await _preloadedVast.mediaPromise)) ||
          (await fetch(
            `${API_BASE}/api/vast/media?tag=` + encodeURIComponent(vastTagUrl)
          ).then((r) => (r.ok ? r.json() : null)));

        if (j?.media?.url) {
          try {
            if (cleanupAdUi) cleanupAdUi();
          } catch (_) {}
          cleanupAdUi = attachAdUi(player, {
            durationSeconds:
              j.durationSeconds != null ? Number(j.durationSeconds) : null,
            skipOffsetSeconds:
              j.skipOffsetSeconds != null ? Number(j.skipOffsetSeconds) : null,
            onSkip: () => safeShowContent("skip-click"),
          });
          player.src({ src: j.media.url, type: j.media.type || "video/mp4" });
          player.one("ended", () => safeShowContent("mediafile-ended"));
          try {
            await player.play();
          } catch (_) {}
          return;
        }
      } catch (_) {}
    })();

    let imaPluginOk = true;
    if (typeof videojs !== "undefined" && typeof videojs.getPlugin === "function") {
      imaPluginOk = typeof videojs.getPlugin("ima") === "function";
    }
    if (typeof google === "undefined" || !google.ima || !imaPluginOk) {
      // No IMA available — try direct mediafile preroll, else fallback to content.
      (async () => {
        try {
          const r = await fetch(
            `${API_BASE}/api/vast/media?tag=` + encodeURIComponent(vastTagUrl)
          );
          if (!r.ok) throw new Error("vast-media");
          const j = await r.json();
          if (j?.media?.url) {
            try {
              if (cleanupAdUi) cleanupAdUi();
            } catch (_) {}
            cleanupAdUi = attachAdUi(player, {
              durationSeconds:
                j.durationSeconds != null ? Number(j.durationSeconds) : null,
              skipOffsetSeconds:
                j.skipOffsetSeconds != null ? Number(j.skipOffsetSeconds) : null,
              onSkip: () => safeShowContent("skip-click"),
            });
            player.src({ src: j.media.url, type: j.media.type || "video/mp4" });
            player.one("ended", () => safeShowContent("mediafile-ended"));
            try {
              await player.play();
            } catch (_) {}
            return;
          }
        } catch (_) {}
        safeShowContent("ima-missing");
      })();
      return;
    }

    let allAdsCompletedBound = false;
    function bindAllAdsCompleted(ev) {
      if (allAdsCompletedBound) return;
      try {
        const ctrl = player.ima;
        const mgr =
          (ev && ev.adsManager) ||
          (ctrl && ctrl.getAdsManager && ctrl.getAdsManager());
        if (!mgr || !mgr.addEventListener) return;
        allAdsCompletedBound = true;
        mgr.addEventListener(
          google.ima.AdEvent.Type.ALL_ADS_COMPLETED,
          function () {
            safeShowContent("ALL_ADS_COMPLETED");
          }
        );
      } catch (_) {}
    }

    try {
      // Many ad providers block direct browser fetch (CORS / bot rules / redirects).
      // Proxy via our server so IMA always loads from same origin.
      const proxiedVast =
        (_preloadedVast && _preloadedVast.proxyUrl) ||
        `${API_BASE}/api/vast/proxy?tag=` + encodeURIComponent(vastTagUrl);
      player.ima({
        id: "ad-player",
        adTagUrl: proxiedVast,
        vpaidMode: google.ima.ImaSdkSettings.VpaidMode.ENABLED,
        adsRequest: {
          pageUrl: imaPageUrl,
          vastLoadTimeout: 90000,
        },
        contribAdsSettings: {
          // Slow VAST/CDN tags need more time before we fallback to content.
          timeout: 90000,
          prerollTimeout: 60000,
        },
      });
    } catch (_) {
      safeShowContent("ima-plugin");
      return;
    }

    // If IMA doesn't start any ad within a grace period, force mediafile preroll.
    let adStarted = false;
    player.one("ads-ad-started", function () {
      adStarted = true;
    });

    setTimeout(async function () {
      if (shownContent || adStarted) return;
      try {
        const j =
          (_preloadedVast && (await _preloadedVast.mediaPromise)) ||
          (await fetch(
            `${API_BASE}/api/vast/media?tag=` + encodeURIComponent(vastTagUrl)
          ).then((r) => (r.ok ? r.json() : null)));
        if (j?.media?.url) {
          try {
            player.ima?.reset?.();
          } catch (_) {}
          try {
            if (cleanupAdUi) cleanupAdUi();
          } catch (_) {}
          cleanupAdUi = attachAdUi(player, {
            durationSeconds:
              j.durationSeconds != null ? Number(j.durationSeconds) : null,
            skipOffsetSeconds:
              j.skipOffsetSeconds != null ? Number(j.skipOffsetSeconds) : null,
            onSkip: () => safeShowContent("skip-click"),
          });
          player.src({ src: j.media.url, type: j.media.type || "video/mp4" });
          player.one("ended", () => safeShowContent("mediafile-ended"));
          try {
            await player.play();
          } catch (_) {}
          return;
        }
      } catch (_) {}
      safeShowContent("ima-no-start");
    }, 20000);

    player.on("ads-manager", function (ev) {
      bindAllAdsCompleted(ev);
    });
    player.one("ads-ad-started", function () {
      bindAllAdsCompleted();
    });

    player.on("adserror", function () {
      safeShowContent("adserror");
    });

    // IMA requires AdDisplayContainer.initialize() from a user gesture on many browsers
    // (esp. mobile). Capture phase runs before Video.js big-play-button so preroll can start.
    const el = player.el();
    const primeImaFromUser = function () {
      try {
        player.ima.initializeAdDisplayContainer();
      } catch (_) {}
    };
    el.addEventListener("click", primeImaFromUser, true);
    el.addEventListener("touchend", primeImaFromUser, {
      capture: true,
      passive: true,
    });
    el.addEventListener("keydown", primeImaFromUser, true);

    try {
      player.play().catch(function () {});
    } catch (_) {
      safeShowContent("ima-init");
    }

    setTimeout(function () {
      if (document.querySelector("#player-box iframe")) return;
      safeShowContent("timeout");
    }, 240000);
  });
}

function renderEpisodes(movie, onSelect, currentSeason, currentEpisode) {
  const container = document.getElementById("player-episodes");
  if (!container) return;
  container.innerHTML = "";

  if (movie.type !== "tv" && movie.type !== "anime") return;
  const seasons = movie.seasons || [];
  if (seasons.length === 0) return;

  const title = document.createElement("div");
  title.className = "player-episodes-title";
  title.textContent = "Episodes";
  container.appendChild(title);

  const list = document.createElement("div");
  list.className = "player-episodes-list";

  seasons.forEach((s) => {
    const eps = s.episodes || [];
    eps.forEach((ep) => {
      const chip = document.createElement("button");
      chip.className = "player-episode-chip";
      const isActive =
        currentSeason === s.season_number &&
        currentEpisode === ep.episode_number;
      if (isActive) chip.classList.add("active");
      chip.textContent = `S${s.season_number} · E${ep.episode_number}`;
      chip.dataset.season = String(s.season_number);
      chip.dataset.episode = String(ep.episode_number);
      chip.addEventListener("click", () => {
        onSelect(s.season_number, ep.episode_number);
      });
      list.appendChild(chip);
    });
  });

  container.appendChild(list);
}

document.addEventListener("DOMContentLoaded", async () => {
  // Start fetching VAST early so ads start faster.
  preloadAds();

  const movieKey = getQueryParam("key");
  const titleEl = document.getElementById("player-title");
  const overviewEl = document.getElementById("player-overview");

  if (!movieKey) {
    if (titleEl) titleEl.textContent = "Not found";
    if (overviewEl) overviewEl.textContent = "No title selected.";
    return;
  }

  const data = await loadMovieDataPreferApi(movieKey);
  const movie = data.movies[movieKey];

  if (!movie) {
    if (titleEl) titleEl.textContent = "Not found";
    if (overviewEl) overviewEl.textContent = "This title is not in the library.";
    return;
  }

  if (titleEl) titleEl.textContent = movie.title || "Untitled";
  if (overviewEl) overviewEl.textContent = movie.overview || "";

  // SEO helpers (client-side): update title + meta description on the fly.
  try {
    const movieTitle = movie.title || "Untitled";
    document.title = `${movieTitle} | ZyroMovies`;

    const metaDesc =
      document.querySelector('meta[name="description"]') ||
      (() => {
        const m = document.createElement("meta");
        m.setAttribute("name", "description");
        document.head.appendChild(m);
        return m;
      })();
    metaDesc.setAttribute("content", movie.overview || movieTitle);
  } catch (_) {}

  // If this title is a download/Fluid source and is a movie/animeMovie,
  // send user directly to Fluid player page (single code).
  if (
    movie.sourceKind === "download" &&
    (movie.type === "movie" || movie.type === "animeMovie")
  ) {
    const url = new URL("player-lang.html", window.location.href);
    url.searchParams.set("key", movieKey);
    url.searchParams.set("lang", "0");
    window.location.href = url.toString();
    return;
  }

  let selectedSeason = 1;
  let selectedEpisode = 1;

  if (movie.type === "tv" && movie.seasons && movie.seasons.length) {
    const first = movie.seasons[0];
    selectedSeason = first.season_number;
    selectedEpisode = (first.episodes && first.episodes[0]?.episode_number) || 1;
  }
  if (movie.type === "anime" && movie.seasons && movie.seasons.length) {
    const first = movie.seasons[0];
    selectedSeason = first.season_number;
    selectedEpisode = (first.episodes && first.episodes[0]?.episode_number) || 1;
  }
  const playEpisode = (season, episode) => {
    selectedSeason = season;
    selectedEpisode = episode;
    renderEpisodes(movie, playEpisode, season, episode);
    // For downloads TV/Anime, go to Fluid player per-episode page
    if (movie.sourceKind === "download") {
      const url = new URL("player-lang.html", window.location.href);
      url.searchParams.set("key", movieKey);
      url.searchParams.set("season", String(season));
      url.searchParams.set("episode", String(episode));
      window.location.href = url.toString();
    } else {
      let url;
      if (movie.sourceKind === "streammafia") {
        url = buildStreammafiaUrl(movie, season, episode);
      } else if (movie.type === "anime") {
        const linearEp = computeAnimeLinearEpisode(
          movie.seasons,
          season,
          episode
        );
        url = buildVidsrcUrl(movie, null, linearEp, "sub");
      } else {
        url = buildVidsrcUrl(movie, season, episode);
      }
      runAdThenContent(url);
    }
  };

  renderEpisodes(movie, playEpisode, selectedSeason, selectedEpisode);

  // Initial playback for embedded sources; downloads wait for episode click
  if (movie.sourceKind !== "download") {
    const url =
      movie.sourceKind === "streammafia"
        ? buildStreammafiaUrl(movie, selectedSeason, selectedEpisode)
        : movie.type === "movie"
          ? buildVidsrcUrl(movie)
          : movie.type === "anime"
            ? buildVidsrcUrl(
                movie,
                null,
                computeAnimeLinearEpisode(
                  movie.seasons,
                  selectedSeason,
                  selectedEpisode
                ),
                "sub"
              )
            : buildVidsrcUrl(movie, selectedSeason, selectedEpisode);

    runAdThenContent(url);
  }
});
