const STORAGE_KEY = "flakes_movies_data";
const VAST_TAG_URL = "YOUR_VAST_TAG_URL"; // Replace with your VAST tag URL

const API_BASE = "http://localhost:3001";

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

function runAdThenContent(url) {
  const box = document.getElementById("player-box");
  if (!box) return;

  box.innerHTML = `
    <video id="ad-player" class="video-js vjs-default-skin vjs-big-play-centered"
      controls width="100%" height="500"></video>
  `;

  const hasVast = VAST_TAG_URL && VAST_TAG_URL !== "YOUR_VAST_TAG_URL";

  if (!hasVast) {
    showContent(url);
    return;
  }

  const player = videojs("ad-player");
  // Ensure ad player starts at full volume and is not muted
  try {
    player.volume(1);
    player.muted(false);
  } catch (_) {}
  player.ready(function () {
    try {
      player.vastClient({
        adTagUrl: VAST_TAG_URL,
        playAdAlways: true,
        timeout: 5000,
        adsEnabled: true,
      });
    } catch (_) {
      showContent(url);
      return;
    }
    player.one("adend", function () {
      showContent(url);
    });
    player.one("aderror", function () {
      showContent(url);
    });
    setTimeout(function () {
      if (document.querySelector("#player-box iframe")) return;
      try {
        player.trigger("adend");
      } catch (_) {}
    }, 6000);
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
  const movieKey = getQueryParam("key");
  const titleEl = document.getElementById("player-title");
  const overviewEl = document.getElementById("player-overview");
  const languagesEl = document.getElementById("player-languages");

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

  // Render language options (always show bar with "Original")
  const extraLanguages = Array.isArray(movie.languages) ? movie.languages : [];
  if (languagesEl) {
    languagesEl.innerHTML = "";

    const label = document.createElement("span");
    label.className = "player-languages-label";
    label.textContent = "Languages:";
    languagesEl.appendChild(label);

    const list = document.createElement("div");
    list.className = "player-languages-list";

    // Original language (default vidsrc)
    const originalBtn = document.createElement("button");
    originalBtn.className = "player-language-chip active";
    originalBtn.textContent = "Original";
    originalBtn.addEventListener("click", () => {
      // Stay on same page (default vidsrc)
      const url = new URL(window.location.href);
      url.searchParams.delete("lang");
      window.location.href = url.toString();
    });
    list.appendChild(originalBtn);

    // Extra languages defined by admin
    extraLanguages.forEach((lang, index) => {
      const btn = document.createElement("button");
      btn.className = "player-language-chip";
      btn.textContent = lang?.name || `Language ${index + 1}`;
      btn.addEventListener("click", () => {
        // Use relative URL so it works on file:// and http://
        const url = new URL("player-lang.html", window.location.href);
        url.searchParams.set("key", movieKey);
        url.searchParams.set("lang", String(index));
        window.location.href = url.toString();
      });
      list.appendChild(btn);
    });

    languagesEl.appendChild(list);
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
      if (movie.type === "anime") {
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

  // Initial playback for vidsrc sources only; downloads wait for episode click
  if (movie.sourceKind !== "download") {
    const url =
      movie.type === "movie"
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
