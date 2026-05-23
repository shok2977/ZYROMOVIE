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

const SITE_URL =
  window.location.hostname === "localhost" ||
  window.location.hostname === "127.0.0.1"
    ? window.location.origin
    : "https://zyromovie.onrender.com";

async function fetchBlogs() {
  const res = await fetch(`${API_BASE}/api/blogs`);
  if (!res.ok) throw new Error("Failed to fetch blogs");
  return await res.json();
}

async function fetchBlogBySlug(slug) {
  const res = await fetch(`${API_BASE}/api/blog/${encodeURIComponent(slug)}`);
  if (!res.ok) throw new Error("Blog not found");
  return await res.json();
}

async function fetchSiteData() {
  const res = await fetch(`${API_BASE}/api/data`);
  if (!res.ok) throw new Error("Failed to load site data");
  return await res.json();
}

let siteAccessMode = "normal";

async function loadSiteAccessMode() {
  try {
    const res = await fetch(`${API_BASE}/api/site/mode`);
    if (!res.ok) return siteAccessMode;
    const data = await res.json();
    siteAccessMode =
      data?.accessMode === "blogs_only" ? "blogs_only" : "normal";
  } catch (_) {
    siteAccessMode = "normal";
  }
  return siteAccessMode;
}

function isBlogsOnlyMode() {
  return siteAccessMode === "blogs_only";
}

function applyBlogsOnlyChrome() {
  if (!isBlogsOnlyMode()) return;

  document.body.classList.add("site-blogs-only");

  document.querySelectorAll("a").forEach((link) => {
    const href = (link.getAttribute("href") || "").trim();
    const lower = href.toLowerCase();
    const isHome =
      lower === "index.html" ||
      lower === "/index.html" ||
      lower === "/" ||
      lower.endsWith("/index.html");
    if (!isHome) return;
    const text = (link.textContent || "").trim().toLowerCase();
    if (text === "home") {
      link.style.display = "none";
      return;
    }
    link.setAttribute("href", "/blog.html");
  });

  document.querySelectorAll(".blog-play-wrap, .blog-play-btn").forEach((el) => {
    el.style.display = "none";
    el.setAttribute("hidden", "");
  });
}

function getBlogExcerpt(blog) {
  if (blog?.description) return blog.description;
  const sections = Array.isArray(blog?.sections) ? blog.sections : [];
  for (const section of sections) {
    if (section?.textBefore) return section.textBefore;
    if (section?.textAfter) return section.textAfter;
  }
  return blog?.overview || "";
}

function buildBlogSeoMeta(blog) {
  const focusList = String(blog?.seoKeywords || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const focusPhrase = focusList[0] || blog?.title || "ZyroMovies";
  const excerpt = getBlogExcerpt(blog);
  const pageTitle = `${blog.title} Watch Online | ${focusPhrase} | ZyroMovies`;
  const pageDescription = `Watch ${blog.title} online free on ZyroMovies (Zyro Movies). ${excerpt}`.slice(
    0,
    165
  );
  const keywords = [
    "zyro movies",
    "zyromovies",
    "ZyroMovies",
    "zyro movie",
    "watch online",
    blog.title,
    ...focusList,
  ]
    .filter(Boolean)
    .join(", ");
  return { pageTitle, pageDescription, keywords, focusPhrase };
}

function normalizeImageKind(kind) {
  return String(kind || "").toLowerCase() === "banner" ? "banner" : "photo";
}

/** Remove old UI placeholder text if it was saved into the blog body. */
function stripLegacyBlogLabelText(text) {
  const t = String(text || "").trim();
  if (!t) return "";
  if (/^intro$/i.test(t)) return "";
  if (/^section\s*\d+$/i.test(t)) return "";
  if (/^text\s*before\s*image$/i.test(t)) return "";
  if (/^text\s*after\s*image$/i.test(t)) return "";
  return t;
}

function normalizeBlogParagraph(text) {
  return stripLegacyBlogLabelText(text).replace(/\n{3,}/g, "\n\n");
}

function estimateBlogReadMinutes(blog) {
  const chunks = [blog?.description || ""];
  const sections = Array.isArray(blog?.sections) ? blog.sections : [];
  sections.forEach((s) => {
    chunks.push(s?.textBefore || "", s?.textAfter || "");
  });
  const words = chunks
    .join(" ")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  return Math.max(1, Math.ceil(words / 200));
}

function renderBlogPostInfo(blog) {
  const infoEl = document.getElementById("blog-post-info");
  if (!infoEl) return;
  const readMin = estimateBlogReadMinutes(blog);
  const ts = blog.createdAt || blog.updatedAt;
  const dateLabel = ts
    ? new Date(ts).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : "";
  infoEl.textContent = dateLabel
    ? `${readMin} min read · ${dateLabel}`
    : `${readMin} min read`;
}

/** Short single-line text before an image is shown as a section heading (h2). */
function isLikelyBlogHeading(text) {
  const t = String(text || "").trim();
  if (!t || t.includes("\n")) return false;
  return t.length <= 100;
}

function appendBlogTextEl(parent, text, { preferHeading = null } = {}) {
  const trimmed = normalizeBlogParagraph(text);
  if (!trimmed) return;
  const asH2 =
    preferHeading === true ||
    (preferHeading !== false && isLikelyBlogHeading(trimmed));
  const onArticle = document.body.classList.contains("blog-page--article");
  const el = document.createElement(asH2 ? "h2" : "p");
  el.className = onArticle
    ? asH2
      ? "article-h2"
      : "article-p"
    : asH2
      ? "blog-section-heading"
      : "blog-detail-text";
  el.textContent = trimmed;
  parent.appendChild(el);
}

function getSiteOrigin() {
  if (API_BASE) return API_BASE.replace(/\/$/, "");
  if (window.location?.origin && window.location.protocol !== "file:") {
    return window.location.origin.replace(/\/$/, "");
  }
  return SITE_URL.replace(/\/$/, "");
}

function resolveBlogImageUrl(url) {
  const value = String(url || "").trim();
  if (!value) return "";
  if (value.startsWith("data:")) return value;
  if (value.startsWith("http://") || value.startsWith("https://")) return value;
  const path = value.startsWith("/") ? value : `/${value}`;
  return `${getSiteOrigin()}${path}`;
}

function getBlogSlugFromLocation() {
  const fromQuery = new URLSearchParams(window.location.search).get("slug");
  if (fromQuery) return fromQuery.trim();
  const match = window.location.pathname.match(/\/blog\/([^/]+)\/?$/i);
  return match ? decodeURIComponent(match[1]) : "";
}

function getBlogSeoImage(blog) {
  const sections = Array.isArray(blog?.sections) ? blog.sections : [];
  for (const section of sections) {
    const raw = String(section?.imageDataUrl || section?.imageUrl || "").trim();
    if (raw) return resolveBlogImageUrl(raw);
  }
  if (blog?.bannerUrl) return resolveBlogImageUrl(blog.bannerUrl);
  if (blog?.posterUrl) return resolveBlogImageUrl(blog.posterUrl);
  return `${getSiteOrigin()}/img/1.jpeg`;
}

function getBlogCardImage(blog) {
  const sections = Array.isArray(blog?.sections) ? blog.sections : [];
  for (const section of sections) {
    const raw = String(section?.imageDataUrl || section?.imageUrl || "").trim();
    if (raw) return resolveBlogImageUrl(raw);
  }
  if (blog?.bannerUrl) return resolveBlogImageUrl(blog.bannerUrl);
  if (blog?.posterUrl) return resolveBlogImageUrl(blog.posterUrl);
  return "img/1.jpeg";
}

function buildPlayerUrl(movie, movieKey) {
  if (
    movie?.sourceKind === "download" &&
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
    const url = new URL("/player-lang.html", window.location.origin);
    url.searchParams.set("key", movieKey);
    url.searchParams.set("season", String(firstSeason.season_number));
    url.searchParams.set("episode", String(firstEp));
    url.searchParams.set("lang", "0");
    return url.toString();
  }

  if (
    movie?.sourceKind === "download" &&
    (movie.type === "movie" || movie.type === "animeMovie")
  ) {
    const url = new URL("/player-lang.html", window.location.origin);
    url.searchParams.set("key", movieKey);
    url.searchParams.set("lang", "0");
    return url.toString();
  }

  return `/player.html?key=${encodeURIComponent(movieKey)}`;
}

async function resolvePlayUrl(blog) {
  const movies = (await fetchSiteData()).movies || {};
  const preferredKey =
    blog.movieKey || `${blog.contentType || "movie"}-${blog.tmdbId}`;

  if (movies[preferredKey]) {
    return buildPlayerUrl(movies[preferredKey], preferredKey);
  }

  for (const [key, movie] of Object.entries(movies)) {
    if (movie && String(movie.tmdbId) === String(blog.tmdbId)) {
      return buildPlayerUrl(movie, key);
    }
  }

  if (preferredKey && blog.tmdbId) {
    return `/player.html?key=${encodeURIComponent(preferredKey)}`;
  }

  return "";
}

function updateSeoForDetail(blog) {
  const { pageTitle, pageDescription, keywords } = buildBlogSeoMeta(blog);
  const image = getBlogSeoImage(blog);
  const canonical = `${SITE_URL}/blog/${encodeURIComponent(blog.slug)}`;

  document.title = pageTitle;

  const upsertMeta = (selector, attr, value) => {
    let el = document.querySelector(selector);
    if (!el) {
      el = document.createElement("meta");
      if (selector.includes("property=")) {
        const prop = selector.match(/property="([^"]+)"/)?.[1];
        if (prop) el.setAttribute("property", prop);
      } else {
        const name = selector.match(/name="([^"]+)"/)?.[1];
        if (name) el.setAttribute("name", name);
      }
      document.head.appendChild(el);
    }
    el.setAttribute(attr, value);
  };

  upsertMeta('meta[name="description"]', "content", pageDescription);
  upsertMeta('meta[name="keywords"]', "content", keywords);
  upsertMeta('meta[property="og:title"]', "content", pageTitle);
  upsertMeta('meta[property="og:description"]', "content", pageDescription);
  upsertMeta('meta[property="og:image"]', "content", image);
  upsertMeta('meta[property="og:url"]', "content", canonical);
  upsertMeta('meta[property="og:type"]', "content", "article");
  upsertMeta('meta[name="twitter:title"]', "content", pageTitle);
  upsertMeta('meta[name="twitter:description"]', "content", pageDescription);
  upsertMeta('meta[name="twitter:image"]', "content", image);

  let link = document.querySelector('link[rel="canonical"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "canonical";
    document.head.appendChild(link);
  }
  link.href = canonical;
}

function renderBlogList(blogs) {
  const listEl = document.getElementById("blog-list");
  if (!listEl) return;
  listEl.innerHTML = "";

  if (!blogs.length) {
    listEl.innerHTML = '<p class="admin-empty">No blogs yet.</p>';
    return;
  }

  blogs.forEach((blog) => {
    const card = document.createElement("a");
    card.className = "blog-card";
    card.href = `/blog/${encodeURIComponent(blog.slug)}`;
    const excerpt = getBlogExcerpt(blog).slice(0, 180);
    const safeTitle = (blog.title || "Untitled").replace(/</g, "&lt;");
    const safeExcerpt = excerpt.replace(/</g, "&lt;");
    card.innerHTML = `
      <div class="blog-card-media">
        <img class="blog-card-image" src="${getBlogCardImage(blog)}" alt="${safeTitle}" loading="lazy" decoding="async" />
        <span class="blog-card-badge">Article</span>
      </div>
      <div class="blog-card-body">
        <h2 class="blog-card-title">${safeTitle}</h2>
        <p class="blog-card-text">${safeExcerpt}</p>
        <span class="blog-card-cta">Read more <span aria-hidden="true">→</span></span>
      </div>
    `;
    listEl.appendChild(card);
  });
}

function renderBlogSections(blog) {
  const sectionsEl = document.getElementById("blog-detail-sections");
  if (!sectionsEl) return;
  sectionsEl.innerHTML = "";

  const sections = Array.isArray(blog.sections) ? blog.sections : [];
  if (!sections.length) return;

  sections.forEach((section) => {
    const textBefore = normalizeBlogParagraph(section?.textBefore);
    const textAfter = normalizeBlogParagraph(section?.textAfter);
    const rawImage = String(
      section?.imageDataUrl || section?.imageUrl || ""
    ).trim();
    const imageSrc = rawImage ? resolveBlogImageUrl(rawImage) : "";

    if (!textBefore && !textAfter && !imageSrc) return;

    if (textBefore) appendBlogTextEl(sectionsEl, textBefore);

    if (imageSrc) {
      const kind = normalizeImageKind(section.imageKind);
      const figure = document.createElement("figure");
      const onArticle = document.body.classList.contains("blog-page--article");
      figure.className = onArticle
        ? `article-figure article-figure--${kind}`
        : `blog-figure blog-figure--${kind}`;
      const img = document.createElement("img");
      img.src = imageSrc;
      img.alt = blog.title || "Blog image";
      img.loading = "lazy";
      img.decoding = "async";
      img.referrerPolicy = "no-referrer";
      img.onerror = () => {
        img.style.outline = "2px solid #ff6b6b";
        img.alt = "Image failed to load";
      };
      figure.appendChild(img);
      sectionsEl.appendChild(figure);
    }

    if (textAfter) appendBlogTextEl(sectionsEl, textAfter, { preferHeading: false });
  });
}

async function setupPlayButton(blog) {
  const wrap = document.getElementById("blog-play-wrap");
  const btn =
    document.getElementById("blog-play-btn") ||
    document.querySelector(".blog-seo-article .article-cta") ||
    document.querySelector(".blog-seo-article .blog-play-btn");
  if (!btn) return;

  if (isBlogsOnlyMode()) {
    if (wrap) wrap.style.display = "none";
    btn.style.display = "none";
    btn.removeAttribute("href");
    return;
  }

  const playUrl = await resolvePlayUrl(blog);
  if (!playUrl) {
    if (wrap) wrap.style.display = "none";
    else btn.style.display = "none";
    return;
  }

  btn.href = playUrl;
  btn.textContent = "▶ Start Watching";
  btn.className = "article-cta";
  if (wrap) wrap.style.display = "block";
  else btn.style.display = "";
}

function isServerRenderedBlogArticle() {
  return Boolean(
    document.querySelector(".blog-seo-article .article-blocks") &&
    !document.getElementById("blog-detail-view")
  );
}

function renderBlogDetail(blog) {
  const listView = document.getElementById("blog-list-view");
  const detailView = document.getElementById("blog-detail-view");
  const titleEl =
    document.getElementById("blog-detail-title") ||
    document.querySelector(".blog-article-title") ||
    document.querySelector(".blog-seo-article .movie-list-title");
  const descEl =
    document.getElementById("blog-detail-description") ||
    document.querySelector(".blog-detail-description");
  const sectionsEl = document.getElementById("blog-detail-sections");

  if (!titleEl && !sectionsEl) return;

  // SSR page already has clean HTML — do not replace with JS (avoids stale cached blog.js)
  if (isServerRenderedBlogArticle()) {
    if (titleEl) titleEl.textContent = blog.title || "Untitled";
    updateSeoForDetail(blog);
    setupPlayButton(blog);
    return;
  }

  document.body.classList.add("blog-page--article");

  if (listView) listView.style.display = "none";
  if (detailView) detailView.style.display = "block";

  const heroWrap = document.getElementById("blog-post-hero-wrap");
  const heroImg = document.getElementById("blog-post-hero-img");
  const heroUrl = getBlogSeoImage(blog);
  if (heroWrap && heroImg && heroUrl) {
    heroImg.src = heroUrl;
    heroImg.alt = blog.title || "Blog cover";
    heroWrap.style.display = "block";
  } else if (heroWrap) {
    heroWrap.style.display = "none";
  }

  if (titleEl) titleEl.textContent = blog.title || "Untitled";

  const intro = normalizeBlogParagraph(blog.description || "");
  if (descEl) {
    descEl.textContent = intro;
    descEl.style.display = intro ? "block" : "none";
  }

  renderBlogPostInfo(blog);
  renderBlogSections(blog);
  updateSeoForDetail(blog);
  setupPlayButton(blog);
}

document.addEventListener("DOMContentLoaded", async () => {
  await loadSiteAccessMode();
  applyBlogsOnlyChrome();

  const slug = getBlogSlugFromLocation();

  try {
    if (slug) {
      const blog = await fetchBlogBySlug(slug);
      renderBlogDetail(blog);
      return;
    }
    document.body.classList.remove("blog-page--article");
    const blogs = await fetchBlogs();
    renderBlogList(blogs);
  } catch (error) {
    const listEl = document.getElementById("blog-list");
    if (listEl) listEl.innerHTML = '<p class="admin-empty">Failed to load blogs.</p>';
    console.error(error);
  }
});
