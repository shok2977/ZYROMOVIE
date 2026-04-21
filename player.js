const STORAGE_KEY = "flakes_movies_data";

// Default = Google demo tag only so local testing shows a real preroll. Production: put YOUR
// Ad Manager / GAM / third-party VAST URL here — the player does not whitelist domains; IMA loads
// whatever tag you give. If the server returns empty VAST (no <Ad>), you get no ad on ANY tag.
// Optional test override: player.html?key=...&adtag=ENCODED_FULL_TAG_URL
const VAST_TAG_URL_BASE =
  "https://exalted-engineering.com/dQm.FJzGdyGLNjvHZCGvUe/CeNme9WuIZxUpl/kTPvTBYC5bNAztY/woNoDcU_trNFjbks3uN/jwAj0QOiQK";

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
const IMA_BOOTSTRAP_CONTENT =
  "https://storage.googleapis.com/gvabox/media/samples/stock.mp4";

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
  const clickThroughUrl =
    opts && typeof opts.clickThroughUrl === "string" && opts.clickThroughUrl.trim()
      ? opts.clickThroughUrl.trim()
      : null;
  const impressionUrls = Array.isArray(opts?.impressionUrls) ? opts.impressionUrls : [];
  const clickTrackingUrls = Array.isArray(opts?.clickTrackingUrls)
    ? opts.clickTrackingUrls
    : [];

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

  // Fire impression trackers once when ad starts playing.
  let didFireImpression = false;
  const fireTrackers = (urls) => {
    (urls || []).forEach((u) => {
      if (!u) return;
      fetch(`${API_BASE}/api/vast/track?u=` + encodeURIComponent(u)).catch(() => {});
    });
  };

  const onPlay = () => {
    if (didFireImpression) return;
    didFireImpression = true;
    fireTrackers(impressionUrls);
  };

  // Click-through: user click on video opens advertiser URL (new tab),
  // and we ping click trackers.
  const onClick = () => {
    if (!clickThroughUrl) return;
    fireTrackers(clickTrackingUrls);
    try {
      window.open(clickThroughUrl, "_blank", "noopener,noreferrer");
    } catch (_) {}
  };

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
  player.on("play", onPlay);
  player.on("click", onClick);
  document.addEventListener("keydown", onKeyDown, true);
  onTimeUpdate();

  return () => {
    try {
      player.off("seeking", preventSeek);
      player.off("timeupdate", onTimeUpdate);
      player.off("play", onPlay);
      player.off("click", onClick);
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
      class="video-js vjs-default-skin"
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

  const videoEl = box.querySelector("#ad-player");
  if (!videoEl) {
    showContent(url);
    return;
  }

  let switched = false;
  const safeShowContent = () => {
    if (switched) return;
    switched = true;
    showContent(url);
  };

  const formatPlayhead = (secs) => {
    const s = Math.max(0, Number(secs) || 0);
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = Math.floor(s % 60);
    const ms = Math.floor((s - Math.floor(s)) * 1000);
    return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
  };

  const normalizeTrackerUrl = (raw, currentTime = 0) => {
    const now = Date.now();
    const cb = `${now}${Math.floor(Math.random() * 1e7)}`;
    return String(raw || "")
      .replace(/\[TIMESTAMP\]/gi, encodeURIComponent(new Date(now).toISOString()))
      .replace(/\[CACHEBUSTING\]/gi, cb)
      .replace(/\[RANDOM\]/gi, cb)
      .replace(/\[CACHEBUSTER\]/gi, cb)
      .replace(/\[CONTENTPLAYHEAD\]/gi, encodeURIComponent(formatPlayhead(currentTime)))
      .replace(/\[ERRORCODE\]/gi, "405");
  };

  const pingTrackers = (urls, currentTime = 0) => {
    (urls || []).forEach((u) => {
      const finalUrl = normalizeTrackerUrl(u, currentTime);
      if (!finalUrl) return;
      try {
        if (navigator.sendBeacon) {
          navigator.sendBeacon(finalUrl, new Blob([], { type: "text/plain" }));
        }
      } catch (_) {}
      try {
        const img = new Image();
        img.referrerPolicy = "no-referrer-when-downgrade";
        img.src = finalUrl;
      } catch (_) {}
    });
  };

  (async () => {
    try {
      const r = await fetch(
        `${API_BASE}/api/vast/media?tag=` + encodeURIComponent(vastTagUrl)
      );
      if (!r.ok) {
        safeShowContent();
        return;
      }
      const ad = await r.json();
      if (!ad?.media?.url) {
        safeShowContent();
        return;
      }

      let impressionSent = false;
      let startTracked = false;
      let q1Tracked = false;
      let midTracked = false;
      let q3Tracked = false;
      let completeTracked = false;
      let skipEnabled = false;
      const skipOffset = Number.isFinite(Number(ad.skipOffsetSeconds))
        ? Number(ad.skipOffsetSeconds)
        : null;
      const track = ad.trackingEvents || {};

      // Optional skip button (only if provider allows via skipoffset).
      let skipBtn = null;
      if (skipOffset != null) {
        skipBtn = document.createElement("button");
        skipBtn.type = "button";
        skipBtn.textContent = `Skip in ${Math.ceil(skipOffset)}s`;
        skipBtn.style.position = "absolute";
        skipBtn.style.right = "16px";
        skipBtn.style.bottom = "18px";
        skipBtn.style.zIndex = "15";
        skipBtn.style.padding = "8px 10px";
        skipBtn.style.borderRadius = "8px";
        skipBtn.style.border = "1px solid rgba(255,255,255,0.35)";
        skipBtn.style.background = "rgba(0,0,0,0.55)";
        skipBtn.style.color = "#fff";
        skipBtn.style.cursor = "not-allowed";
        skipBtn.disabled = true;
        box.appendChild(skipBtn);
        skipBtn.addEventListener("click", () => {
          if (!skipEnabled) return;
          safeShowContent();
        });
      }

      videoEl.style.width = "100%";
      videoEl.style.height = "500px";
      videoEl.style.background = "#000";
      videoEl.style.cursor = ad.clickThroughUrl ? "pointer" : "default";
      videoEl.playsInline = true;
      videoEl.muted = true;
      videoEl.autoplay = true;
      videoEl.controls = false;
      videoEl.src = ad.media.url;

      // Ensure visible clickable cursor and click target on top of video.
      let clickLayer = null;
      if (ad.clickThroughUrl) {
        clickLayer = document.createElement("button");
        clickLayer.type = "button";
        clickLayer.setAttribute("aria-label", "Open advertiser");
        clickLayer.style.position = "absolute";
        clickLayer.style.inset = "0";
        clickLayer.style.zIndex = "12";
        clickLayer.style.background = "transparent";
        clickLayer.style.border = "0";
        clickLayer.style.cursor = "pointer";
        clickLayer.style.padding = "0";
        clickLayer.style.margin = "0";
        box.appendChild(clickLayer);
      }

      videoEl.addEventListener("playing", () => {
        if (impressionSent) return;
        impressionSent = true;
        pingTrackers(ad.impressionUrls || [], videoEl.currentTime || 0);
        if (!startTracked) {
          startTracked = true;
          pingTrackers(track.start || [], videoEl.currentTime || 0);
        }
      });

      videoEl.addEventListener("timeupdate", () => {
        const ct = videoEl.currentTime || 0;
        const d =
          Number.isFinite(Number(ad.durationSeconds)) && Number(ad.durationSeconds) > 0
            ? Number(ad.durationSeconds)
            : videoEl.duration || 0;
        if (d > 0) {
          const p = ct / d;
          if (!q1Tracked && p >= 0.25) {
            q1Tracked = true;
            pingTrackers(track.firstQuartile || [], ct);
          }
          if (!midTracked && p >= 0.5) {
            midTracked = true;
            pingTrackers(track.midpoint || [], ct);
          }
          if (!q3Tracked && p >= 0.75) {
            q3Tracked = true;
            pingTrackers(track.thirdQuartile || [], ct);
          }
        }

        if (skipBtn && !skipEnabled) {
          const left = skipOffset - ct;
          if (left <= 0) {
            skipEnabled = true;
            skipBtn.disabled = false;
            skipBtn.textContent = "Skip Ad";
            skipBtn.style.cursor = "pointer";
          } else {
            skipBtn.textContent = `Skip in ${Math.ceil(left)}s`;
          }
        }
      });

      videoEl.addEventListener("click", () => {
        if (ad.clickThroughUrl) {
          pingTrackers(ad.clickTrackingUrls || [], videoEl.currentTime || 0);
          window.open(ad.clickThroughUrl, "_blank", "noopener,noreferrer");
        }
      });
      if (clickLayer) {
        clickLayer.addEventListener("click", () => {
          pingTrackers(ad.clickTrackingUrls || [], videoEl.currentTime || 0);
          window.open(ad.clickThroughUrl, "_blank", "noopener,noreferrer");
        });
      }

      videoEl.addEventListener("ended", () => {
        if (!completeTracked) {
          completeTracked = true;
          pingTrackers(track.complete || [], videoEl.currentTime || 0);
        }
        try {
          if (clickLayer) clickLayer.remove();
        } catch (_) {}
        safeShowContent();
      });
      videoEl.addEventListener("error", () => {
        try {
          if (clickLayer) clickLayer.remove();
        } catch (_) {}
        safeShowContent();
      });

      try {
        await videoEl.play();
      } catch (_) {
        safeShowContent();
      }
    } catch (_) {
      safeShowContent();
    }
  })();
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
