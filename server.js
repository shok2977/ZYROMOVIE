import "dotenv/config";
import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import dns from "dns";
import fs from "fs/promises";
import path from "path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "url";

const app = express();
app.use(cors());
app.use(express.json({ limit: "80mb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

const SITE_URL = String(process.env.SITE_URL || "https://zyromovie.onrender.com").replace(
  /\/$/,
  ""
);
const TMDB_API_KEY =
  process.env.TMDB_API_KEY || "e84730516a1d5987f96fd63d46d2f119";

async function tmdbApiGet(pathAndQuery) {
  const sep = pathAndQuery.includes("?") ? "&" : "?";
  const url = `https://api.themoviedb.org/3${pathAndQuery}${sep}api_key=${TMDB_API_KEY}&language=en-US`;
  const r = await fetch(url);
  if (!r.ok) {
    const err = new Error(`TMDB request failed (${r.status})`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

function parseTmdbIdInput(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (/^\d+$/.test(s)) return s;
  const fromPath = s.match(/\/(?:movie|tv)\/(\d+)/i);
  if (fromPath) return fromPath[1];
  const fromQuery = s.match(/[?&]tmdb_id=(\d+)/i);
  if (fromQuery) return fromQuery[1];
  const digits = s.match(/(\d{5,})/);
  if (digits) return digits[1];
  const shortDigits = s.match(/^(\d{1,9})$/);
  return shortDigits ? shortDigits[1] : "";
}

function isTmdbMovieKind(type) {
  return type === "movie" || type === "animeMovie";
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

async function fetchTmdbKeywordNames(tmdbId, isMovie) {
  try {
    const path = isMovie
      ? `/movie/${tmdbId}/keywords`
      : `/tv/${tmdbId}/keywords`;
    const data = await tmdbApiGet(path);
    const list = isMovie ? data?.keywords : data?.results;
    return (Array.isArray(list) ? list : [])
      .map((k) => k?.name)
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

async function fetchTmdbAlternativeTitleNames(tmdbId, isMovie) {
  try {
    const path = isMovie
      ? `/movie/${tmdbId}/alternative_titles`
      : `/tv/${tmdbId}/alternative_titles`;
    const data = await tmdbApiGet(path);
    const list = data?.titles || data?.results || [];
    return (Array.isArray(list) ? list : [])
      .map((t) => t?.title || t?.name)
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

async function buildTagsForMovieFromTmdb(tmdbId, type) {
  const id = String(tmdbId || "").trim();
  if (!id) return "";
  const tryMovieFirst = isTmdbMovieKind(type);
  const order = tryMovieFirst ? [true, false] : [false, true];
  for (const isMovie of order) {
    try {
      const path = isMovie ? `/movie/${id}` : `/tv/${id}`;
      const data = await tmdbApiGet(path);
      const [keywordNames, altTitles] = await Promise.all([
        fetchTmdbKeywordNames(id, isMovie),
        fetchTmdbAlternativeTitleNames(id, isMovie),
      ]);
      return buildTmdbSearchTags(data, [...keywordNames, ...altTitles]);
    } catch (_) {}
  }
  return "";
}

async function enrichMovieTagsFromTmdb(movie) {
  const existing = String(movie?.tags || "").trim();
  if (existing) return existing;
  const tmdbId = String(movie?.tmdbId || "").trim();
  if (!tmdbId || !movie?.key) return "";
  const tags = await buildTagsForMovieFromTmdb(tmdbId, movie.type || "movie");
  if (tags) {
    await Movie.updateOne({ key: movie.key }, { $set: { tags } });
  }
  return tags;
}

function parseMovieTagList(tagsStr) {
  return String(tagsStr || "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

function tokenizeSearchQuery(query) {
  return String(query || "")
    .trim()
    .toLowerCase()
    .split(/[\s,]+/)
    .filter((t) => t.length >= 1);
}

function scoreMovieForSearch(movie, tokens) {
  const title = String(movie.title || "").toLowerCase();
  const tagsRaw = String(movie.tags || "").toLowerCase();
  const tagList = parseMovieTagList(movie.tags);
  const overview = String(movie.overview || "").toLowerCase();
  const fullQ = tokens.join(" ");
  let score = 0;

  if (fullQ && title.includes(fullQ)) score += 40;
  if (fullQ && tagsRaw.includes(fullQ)) score += 35;
  if (fullQ && overview.includes(fullQ)) score += 22;

  tagList.forEach((tag) => {
    if (fullQ && (tag === fullQ || tag.includes(fullQ))) score += 38;
    tokens.forEach((t) => {
      if (!t) return;
      if (tag === t || tag.includes(t)) score += 18;
    });
  });

  tokens.forEach((t) => {
    if (!t) return;
    if (title === t) score += 50;
    else if (title.startsWith(t)) score += 25;
    else if (title.includes(t)) score += 12;
    if (overview.includes(t)) score += 6;
  });

  return score;
}

async function tmdbMetaFromPayload(data, tmdbId, mediaKind) {
  const id = String(tmdbId || data?.id || "").trim();
  const isMovie = isTmdbMovieKind(mediaKind);
  const [keywordNames, altTitles] =
    id && mediaKind
      ? await Promise.all([
          fetchTmdbKeywordNames(id, isMovie),
          fetchTmdbAlternativeTitleNames(id, isMovie),
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

async function resolveTmdbByImdb(imdbId) {
  const id = String(imdbId || "").trim();
  if (!/^tt\d+$/i.test(id)) return null;
  const found = await tmdbApiGet(
    `/find/${encodeURIComponent(id)}?external_source=imdb_id`
  );
  const movie = found.movie_results?.[0];
  if (movie?.id) {
    const id = String(movie.id);
    const data = await tmdbApiGet(`/movie/${id}`);
    return {
      tmdbId: id,
      type: "movie",
      meta: await tmdbMetaFromPayload(data, id, "movie"),
    };
  }
  const tv = found.tv_results?.[0];
  if (tv?.id) {
    const id = String(tv.id);
    const data = await tmdbApiGet(`/tv/${id}`);
    const type = tv.genre_ids?.includes(16) ? "anime" : "tv";
    return {
      tmdbId: id,
      type,
      meta: await tmdbMetaFromPayload(data, id, type),
    };
  }
  return null;
}

async function resolveTmdbMeta(tmdbIdRaw, preferredType = "movie") {
  const imdbHit = await resolveTmdbByImdb(tmdbIdRaw);
  if (imdbHit) return imdbHit;

  const tmdbId = parseTmdbIdInput(tmdbIdRaw);
  if (!tmdbId) {
    const err = new Error(
      "Invalid TMDB ID. Paste only a number or a themoviedb.org link (e.g. 550 or /movie/550-...)."
    );
    err.status = 400;
    throw err;
  }

  const tryTypes = buildTmdbTryTypes(preferredType);
  for (const type of tryTypes) {
    try {
      const path =
        type === "movie" || type === "animeMovie"
          ? `/movie/${tmdbId}`
          : `/tv/${tmdbId}`;
      const data = await tmdbApiGet(path);
      const meta = await tmdbMetaFromPayload(data, tmdbId, type);
      if (meta.title?.trim()) {
        return { tmdbId, type, meta };
      }
    } catch (_) {}
  }

  const err = new Error(
    `TMDB ID "${tmdbId}" not found. Open themoviedb.org — copy the number from the URL (Movie page for films, TV page for series).`
  );
  err.status = 404;
  throw err;
}

// ---- Simple in-memory cache (per instance) ----
const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes
const _cache = new Map();
function _now() {
  return Date.now();
}
function _normalizeTagKey(tag) {
  // Strip common cache-busters so repeated plays reuse warm cache.
  try {
    const u = new URL(tag);
    u.searchParams.delete("correlator");
    u.searchParams.delete("cb");
    u.searchParams.delete("cachebust");
    return u.toString();
  } catch (_) {
    return String(tag || "");
  }
}
function _cacheGet(key) {
  const item = _cache.get(key);
  if (!item) return null;
  if (_now() - item.t > CACHE_TTL_MS) {
    _cache.delete(key);
    return null;
  }
  return item.v;
}
function _cacheSet(key, value) {
  _cache.set(key, { t: _now(), v: value });
}

// WARNING: rotate this password in Atlas, never keep real creds in code for production.
const MONGO_URI =
  process.env.MONGODB_URI ||
  process.env.MONGO_URI ||
  "mongodb+srv://Aditya:Aditya@cap.nwkww.mongodb.net/cap?retryWrites=true&w=majority";

// Render (and some ISPs) can refuse SRV DNS queries. We set well-known resolvers
// and retry so the web service can still start even if DB is temporarily down.
try {
  if (typeof dns.setDefaultResultOrder === "function") {
    dns.setDefaultResultOrder("ipv4first");
  }
  if (typeof dns.setServers === "function") {
    dns.setServers(["1.1.1.1", "8.8.8.8"]);
  }
} catch (_) {}

async function connectMongoWithRetry() {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await mongoose.connect(MONGO_URI, {
        serverSelectionTimeoutMS: 15000,
      });
      console.log("✅ MongoDB Connected");
      ensureListSortOrdersOnce().catch((e) => {
        console.warn("List sort order backfill:", e?.message ?? e);
      });
      backfillMovieTagsInBackground().catch((e) => {
        console.warn("Tag backfill:", e?.message ?? e);
      });
      return;
    } catch (err) {
      console.error(
        `❌ MongoDB Connection Error (attempt ${attempt}/${maxAttempts}):`,
        err?.message ?? err
      );
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
  }
  console.error("❌ MongoDB not connected. API will run with empty data until DB is reachable.");
}

connectMongoWithRetry().catch((e) => {
  console.error("❌ MongoDB connect routine failed:", e?.message ?? e);
});

async function backfillMovieTagsInBackground() {
  if (mongoose.connection.readyState !== 1) return;
  const movies = await Movie.find({
    tmdbId: { $exists: true, $nin: ["", null] },
    $or: [{ tags: { $exists: false } }, { tags: "" }, { tags: null }],
  }).lean();
  if (!movies.length) return;
  console.log(`🏷️ Backfilling search tags for ${movies.length} title(s)...`);
  for (const m of movies) {
    try {
      await enrichMovieTagsFromTmdb(m);
      await new Promise((r) => setTimeout(r, 220));
    } catch (e) {
      console.warn("Tag backfill failed:", m.key, e?.message ?? e);
    }
  }
  console.log("✅ Search tag backfill finished");
}

const movieSchema = new mongoose.Schema({
  key: String,
  tmdbId: String,
  type: String,
  title: String,
  overview: String,
  /** Comma-separated — home search by name + tags */
  tags: { type: String, default: "" },
  posterUrl: String,
  seasons: Array,
  sourceKind: String,
  languages: Array,
  downloadEpisodes: Object,
  downloadEpisodesByLang: Object,
  createdAt: Number,
});

const listSchema = new mongoose.Schema({
  name: String,
  movieKeys: [String],
  sortOrder: { type: Number, default: 0 },
});

const bannerSchema = new mongoose.Schema({
  title: String,
  description: String,
  tmdbId: String,
  contentType: String,
  movieKey: String,
  imageDataUrl: String,
  createdAt: Number,
});

const blogSectionSchema = new mongoose.Schema(
  {
    textBefore: { type: String, default: "" },
    imageDataUrl: { type: String, default: "" },
    imageKind: { type: String, enum: ["photo", "banner"], default: "photo" },
    textAfter: { type: String, default: "" },
  },
  { _id: false }
);

const blogSchema = new mongoose.Schema({
  slug: { type: String, unique: true, index: true },
  tmdbId: String,
  contentType: String,
  movieKey: String,
  title: String,
  overview: String,
  description: String,
  seoKeywords: String,
  sections: [blogSectionSchema],
  posterUrl: String,
  bannerUrl: String,
  createdAt: Number,
  updatedAt: Number,
});

const localAdSchema = new mongoose.Schema({
  title: { type: String, default: "" },
  videoUrl: { type: String, required: true },
  maxPlays: { type: Number, default: 100 },
  playCount: { type: Number, default: 0 },
  active: { type: Boolean, default: true },
  clickThroughUrl: { type: String, default: "" },
  /** true = user can skip (skipOffsetSeconds = seconds before skip is allowed) */
  allowSkip: { type: Boolean, default: false },
  /** null = skip off; 0–600 = seconds after start when skip is allowed */
  skipOffsetSeconds: { type: Number, default: null },
  createdAt: { type: Number, default: () => Date.now() },
});

function normalizeLocalAdSkipFields(ad) {
  if (!ad) return { allowSkip: false, skipOffsetSeconds: null };
  if (ad.allowSkip === true) {
    const raw = ad.skipOffsetSeconds ?? ad.skipAfterSeconds ?? 5;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0 && n <= 600) {
      return {
        allowSkip: true,
        skipOffsetSeconds: Math.floor(n),
      };
    }
    return { allowSkip: true, skipOffsetSeconds: 5 };
  }
  const legacy = ad.skipOffsetSeconds;
  if (
    legacy != null &&
    legacy !== "" &&
    Number.isFinite(Number(legacy)) &&
    Number(legacy) >= 0 &&
    Number(legacy) <= 600
  ) {
    return {
      allowSkip: true,
      skipOffsetSeconds: Math.floor(Number(legacy)),
    };
  }
  return { allowSkip: false, skipOffsetSeconds: null };
}

const Movie = mongoose.model("Movie", movieSchema);
const List = mongoose.model("List", listSchema);
const Banner = mongoose.model("Banner", bannerSchema);
const Blog = mongoose.model("Blog", blogSchema);
const LocalAd = mongoose.model("LocalAd", localAdSchema);

function escapeHtml(input) {
  return String(input || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function toSlug(title, tmdbId) {
  const base = String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return base ? `${base}-${tmdbId}` : `movie-${tmdbId}`;
}

function isValidVideoMediaUrl(url, mediaType) {
  const value = String(url || "").trim().toLowerCase();
  if (!value.startsWith("http://") && !value.startsWith("https://")) return false;
  if (/\.(js|css|html|htm|xml|json|txt|ico|svg|woff|woff2)(\?|#|$)/i.test(value)) {
    return false;
  }
  if (
    /google\.com|gstatic\.com|googletagmanager|doubleclick|googleapis\.com\/js/i.test(
      value
    )
  ) {
    return false;
  }
  if (mediaType === "video/mp4" || mediaType === "video/webm") {
    return true;
  }
  return (
    /\.(mp4|webm|m3u8|mov|ogv)(\?|#|$)/i.test(value) ||
    /\/video\//i.test(value) ||
    /type=video/i.test(value)
  );
}

const VAST_FETCH_MS = 15000;
const VAST_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 ZyroMoviesVastProxy";

async function fetchVastText(tagUrl) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), VAST_FETCH_MS);
  try {
    const r = await fetch(tagUrl, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "user-agent": VAST_UA, accept: "application/xml,text/xml,*/*" },
    });
    if (!r.ok) {
      const err = new Error("failed to fetch VAST tag");
      err.status = r.status;
      throw err;
    }
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

function extractWrapperTagUri(xml) {
  const block = xml.match(/<VASTAdTagURI[^>]*>[\s\S]*?<\/VASTAdTagURI>/i);
  if (!block) return null;
  const cdata = block[0].match(/<!\[CDATA\[([\s\S]*?)\]\]>/i);
  const url = String((cdata ? cdata[1] : block[0].replace(/<[^>]+>/g, "")) || "").trim();
  return url.startsWith("http://") || url.startsWith("https://") ? url : null;
}

async function resolveVastXml(initialTag, maxHops = 6) {
  let tagUrl = initialTag;
  const wrapperImpressions = [];
  let xml = "";

  for (let hop = 0; hop < maxHops; hop++) {
    xml = await fetchVastText(tagUrl);
    const next = extractWrapperTagUri(xml);
    if (next && /<Wrapper[\s>]/i.test(xml)) {
      const imp =
        xml.match(/<Impression[^>]*>[\s\S]*?<\/Impression>/gi) || [];
      for (const block of imp) {
        const cdata = block.match(/<!\[CDATA\[([\s\S]*?)\]\]>/i);
        const url = String((cdata ? cdata[1] : "") || "").trim();
        if (url) wrapperImpressions.push(url);
      }
      tagUrl = next;
      continue;
    }
    return { xml, wrapperImpressions };
  }

  return { xml, wrapperImpressions };
}

function parseVastMediaPayload(xml, wrapperImpressions = []) {
  const durationMatchH = xml.match(
    /<Duration>\s*(\d{1,2}):(\d{2}):(\d{2})\s*<\/Duration>/
  );
  const durationSeconds = durationMatchH
    ? Number(durationMatchH[1]) * 3600 +
      Number(durationMatchH[2]) * 60 +
      Number(durationMatchH[3])
    : (() => {
        const durationMatchM = xml.match(
          /<Duration>\s*(\d{1,2}):(\d{2})\s*<\/Duration>/
        );
        return durationMatchM
          ? Number(durationMatchM[1]) * 60 + Number(durationMatchM[2])
          : null;
      })();

  const skipOffsetSeconds = (() => {
    const m = xml.match(/<Linear[^>]*\sskipoffset="([^"]+)"[^>]*>/i);
    if (!m) return null;
    const raw = String(m[1] || "").trim();
    if (!raw) return null;
    if (raw.endsWith("%")) {
      const pct = parseFloat(raw.slice(0, -1));
      if (!Number.isFinite(pct) || durationSeconds == null) return null;
      return Math.max(0, Math.floor((pct / 100) * durationSeconds));
    }
    const hms = raw.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
    if (hms) {
      return Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3]);
    }
    const ms = raw.match(/^(\d{1,2}):(\d{2})$/);
    if (ms) {
      return Number(ms[1]) * 60 + Number(ms[2]);
    }
    const secs = parseInt(raw, 10);
    if (Number.isFinite(secs) && secs >= 0) return secs;
    return null;
  })();

  const extractCdataUrls = (re) => {
    const out = [];
    const matches = xml.match(re) || [];
    for (const block of matches) {
      const cdata = block.match(/<!\[CDATA\[([\s\S]*?)\]\]>/i);
      const url = String((cdata ? cdata[1] : "") || "").trim();
      if (url) out.push(url);
    }
    return out;
  };

  const clickThroughUrl = (() => {
    const m = xml.match(
      /<ClickThrough[^>]*>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/ClickThrough>/i
    );
    const url = String((m && m[1]) || "").trim();
    return url || null;
  })();

  const impressionUrls = [
    ...wrapperImpressions,
    ...extractCdataUrls(/<Impression[^>]*>[\s\S]*?<\/Impression>/gi),
  ];
  const clickTrackingUrls = extractCdataUrls(
    /<ClickTracking[^>]*>[\s\S]*?<\/ClickTracking>/gi
  );
  const trackingEvents = {
    start: extractCdataUrls(/<Tracking[^>]*event="start"[^>]*>[\s\S]*?<\/Tracking>/gi),
    firstQuartile: extractCdataUrls(
      /<Tracking[^>]*event="firstQuartile"[^>]*>[\s\S]*?<\/Tracking>/gi
    ),
    midpoint: extractCdataUrls(
      /<Tracking[^>]*event="midpoint"[^>]*>[\s\S]*?<\/Tracking>/gi
    ),
    thirdQuartile: extractCdataUrls(
      /<Tracking[^>]*event="thirdQuartile"[^>]*>[\s\S]*?<\/Tracking>/gi
    ),
    complete: extractCdataUrls(
      /<Tracking[^>]*event="complete"[^>]*>[\s\S]*?<\/Tracking>/gi
    ),
  };

  const extractMediaFile = (wantedType) => {
    const typePattern = wantedType.replace(/\//g, "\\/");
    const blocks = xml.match(/<MediaFile[\s\S]*?<\/MediaFile>/gi) || [];
    const progressiveFirst = [];
    const any = [];

    for (const block of blocks) {
      if (!new RegExp(`type=["']${typePattern}["']`, "i").test(block)) continue;
      const cdataMatch = block.match(/<!\[CDATA\[([\s\S]*?)\]\]>/i);
      const url = String((cdataMatch ? cdataMatch[1] : block.replace(/<[^>]+>/g, "")) || "")
        .replace(/^\s+|\s+$/g, "");
      if (!url) continue;

      const isProgressive = /delivery=["']progressive["']/i.test(block);
      const item = { type: wantedType, url };
      if (isProgressive) progressiveFirst.push(item);
      else any.push(item);
    }

    if (
      progressiveFirst.length &&
      isValidVideoMediaUrl(progressiveFirst[0].url, wantedType)
    ) {
      return progressiveFirst[0];
    }
    if (any.length && isValidVideoMediaUrl(any[0].url, wantedType)) return any[0];
    return null;
  };

  let media = extractMediaFile("video/mp4");
  if (!media) media = extractMediaFile("video/webm");
  if (media && !isValidVideoMediaUrl(media.url, media.type)) media = null;

  return {
    durationSeconds,
    skipOffsetSeconds,
    clickThroughUrl,
    impressionUrls,
    clickTrackingUrls,
    trackingEvents,
    media,
  };
}

function requestSiteOrigin(req) {
  if (req) {
    const host = req.get("host");
    if (host) return `${req.protocol}://${host}`;
  }
  return SITE_URL.replace(/\/$/, "");
}

function absSiteUrl(url, req) {
  const value = String(url || "").trim();
  if (!value) return "";
  if (value.startsWith("data:")) return value;
  if (value.startsWith("http://") || value.startsWith("https://")) return value;
  if (value.startsWith("/")) return `${requestSiteOrigin(req)}${value}`;
  return value;
}

function blogSectionHasImage(section) {
  return Boolean(
    String(section?.imageDataUrl || section?.imageUrl || "").trim()
  );
}

async function resolveMovieKey(tmdbId, contentType) {
  const id = String(tmdbId || "").trim();
  if (!id) return "";
  const type = String(contentType || "").trim();
  if (type) {
    const directKey = `${type}-${id}`;
    const direct = await Movie.findOne({ key: directKey }).lean();
    if (direct) return direct.key;
  }
  const byTmdb = await Movie.findOne({ tmdbId: id }).lean();
  if (byTmdb?.key) return byTmdb.key;
  return type ? `${type}-${id}` : "";
}

function buildBlogSeoMeta(blog, req) {
  const sectionText = Array.isArray(blog.sections)
    ? blog.sections
        .map((s) => [s.textBefore, s.textAfter].filter(Boolean).join(" "))
        .join(" ")
        .trim()
    : "";
  const focusList = String(blog.seoKeywords || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const focusPhrase = focusList[0] || blog.title || "ZyroMovies";
  const excerpt = blog.description || sectionText || blog.overview || "";
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
    "watch free",
    blog.title,
    ...focusList,
  ]
    .filter(Boolean)
    .join(", ");
  let image = "";
  const sections = Array.isArray(blog.sections) ? blog.sections : [];
  for (const section of sections) {
    const raw = String(section?.imageDataUrl || section?.imageUrl || "").trim();
    if (raw) {
      image = absSiteUrl(raw, req);
      break;
    }
  }
  if (!image) {
    image =
      absSiteUrl(blog.bannerUrl, req) ||
      absSiteUrl(blog.posterUrl, req) ||
      `${SITE_URL.replace(/\/$/, "")}/img/1.jpeg`;
  }
  return { pageTitle, pageDescription, keywords, image, focusPhrase, excerpt };
}

function renderBlogSectionsHtml(blog, req) {
  const sections = Array.isArray(blog.sections) ? blog.sections : [];
  return sections
    .map((section, index) => {
      const textBefore = String(section?.textBefore || "").trim();
      const textAfter = String(section?.textAfter || "").trim();
      const rawImage = String(
        section?.imageDataUrl || section?.imageUrl || ""
      ).trim();
      const imageSrc = rawImage ? absSiteUrl(rawImage, req) : "";
      const kind = section?.imageKind === "banner" ? "banner" : "photo";
      if (!textBefore && !textAfter && !imageSrc) return "";

      let html = `<section class="blog-content-block"><h2 class="blog-block-label">Section ${index + 1}</h2>`;
      if (textBefore) {
        html += `<div class="blog-text-block"><span class="blog-text-block-label">Text before image</span><p class="blog-detail-text">${escapeHtml(textBefore)}</p></div>`;
      }
      if (imageSrc) {
        html += `<figure class="blog-figure blog-figure--${kind}"><img src="${escapeHtml(imageSrc)}" alt="${escapeHtml(blog.title || "Blog")}" loading="lazy" decoding="async" /></figure>`;
      }
      if (textAfter) {
        html += `<div class="blog-text-block"><span class="blog-text-block-label">Text after image</span><p class="blog-detail-text">${escapeHtml(textAfter)}</p></div>`;
      }
      html += `</section>`;
      return html;
    })
    .join("");
}

// ---- API ----

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    db: mongoose.connection.readyState === 1,
    features: { localAds: true, listDelete: true },
  });
});

app.get("/api/tmdb/resolve", async (req, res) => {
  try {
    const out = await resolveTmdbMeta(
      req.query.tmdbId,
      String(req.query.type || "movie")
    );
    res.json(out);
  } catch (e) {
    res.status(e?.status === 404 ? 404 : e?.status === 400 ? 400 : 502).json({
      error: e?.message || "TMDB lookup failed",
    });
  }
});

app.get("/api/tmdb/details", async (req, res) => {
  const tmdbId = parseTmdbIdInput(req.query.tmdbId);
  const type = String(req.query.type || "movie").trim();
  if (!tmdbId) {
    res.status(400).json({ error: "tmdbId is required" });
    return;
  }
  try {
    const path =
      type === "movie" || type === "animeMovie"
        ? `/movie/${tmdbId}`
        : `/tv/${tmdbId}`;
    const data = await tmdbApiGet(path);
    res.json(await tmdbMetaFromPayload(data, tmdbId, type));
  } catch (e) {
    res.status(e?.status === 404 ? 404 : 502).json({
      error: e?.message || "TMDB lookup failed",
    });
  }
});

app.get("/api/tmdb/seasons", async (req, res) => {
  const tmdbId = parseTmdbIdInput(req.query.tmdbId);
  const maxRaw = parseInt(String(req.query.max || "3"), 10);
  const maxSeasons = Number.isFinite(maxRaw)
    ? Math.max(1, Math.min(maxRaw, 10))
    : 3;
  if (!tmdbId) {
    res.status(400).json({ error: "tmdbId is required" });
    return;
  }
  try {
    const tv = await tmdbApiGet(`/tv/${tmdbId}`);
    const total = Math.min(tv.number_of_seasons || 0, maxSeasons);
    const seasons = [];
    for (let s = 1; s <= total; s++) {
      try {
        const seasonData = await tmdbApiGet(`/tv/${tmdbId}/season/${s}`);
        const episodes = (seasonData.episodes || []).map((ep) => ({
          episode_number: ep.episode_number,
          name: ep.name || `Episode ${ep.episode_number}`,
        }));
        seasons.push({ season_number: s, episodes });
      } catch (_) {}
    }
    res.json(seasons);
  } catch (e) {
    res.status(502).json({ error: e?.message || "TMDB seasons failed" });
  }
});

let homeDataPayloadCache = null;
let homeDataPayloadCacheAt = 0;
const HOME_DATA_SERVER_CACHE_MS = 45 * 1000;

function invalidateHomeDataCache() {
  homeDataPayloadCache = null;
  homeDataPayloadCacheAt = 0;
}

function movieForHomeClient(doc) {
  return {
    key: doc.key,
    tmdbId: doc.tmdbId,
    type: doc.type,
    title: doc.title,
    overview: doc.overview,
    tags: doc.tags,
    posterUrl: doc.posterUrl,
    sourceKind: doc.sourceKind,
  };
}

let listSortOrdersEnsured = false;
async function ensureListSortOrdersOnce() {
  if (listSortOrdersEnsured || mongoose.connection.readyState !== 1) return;
  const lists = await List.find().lean();
  const missingOrder = lists.filter(
    (l) => l.sortOrder == null || l.sortOrder === undefined
  );
  if (missingOrder.length) {
    const maxSo = lists.reduce(
      (m, l) => Math.max(m, Number(l.sortOrder) || 0),
      0
    );
    let next = maxSo + 1;
    missingOrder.sort((a, b) =>
      String(a.name).localeCompare(String(b.name))
    );
    for (const l of missingOrder) {
      await List.updateOne({ _id: l._id }, { $set: { sortOrder: next++ } });
    }
  }
  listSortOrdersEnsured = true;
}

async function buildHomeDataPayload() {
  const [movies, listsFromDb, banners] = await Promise.all([
    Movie.find().select(
      "key tmdbId type title overview tags posterUrl sourceKind"
    ).lean(),
    List.find().select("name movieKeys sortOrder").lean(),
    Banner.find().lean(),
  ]);

  const moviesByKey = {};
  movies.forEach((m) => {
    if (m?.key) moviesByKey[m.key] = movieForHomeClient(m);
  });

  const listsByName = {};
  const lists = [...listsFromDb].sort(
    (a, b) =>
      (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0) ||
      String(a.name).localeCompare(String(b.name))
  );
  lists.forEach((l) => {
    listsByName[l.name] = l.movieKeys || [];
  });
  const listOrder = lists.map((l) => l.name);

  const bannersWithKeys = banners.map((b) => {
    const lean = { ...b, id: b._id?.toString?.() || b.id };
    if (!lean.movieKey && lean.tmdbId && lean.contentType) {
      lean.movieKey = `${lean.contentType}-${lean.tmdbId}`;
    }
    return lean;
  });

  return {
    movies: moviesByKey,
    lists: listsByName,
    listOrder,
    banners: bannersWithKeys,
    dbReady: true,
  };
}

// All data for front-end (movies by key, lists by name, banners array)
app.get("/api/data", async (req, res) => {
  res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=120");

  if (mongoose.connection.readyState !== 1) {
    res.set("Cache-Control", "no-store");
    res.json({
      movies: {},
      lists: {},
      listOrder: [],
      banners: [],
      dbReady: false,
    });
    return;
  }

  const now = _now();
  if (
    homeDataPayloadCache &&
    now - homeDataPayloadCacheAt < HOME_DATA_SERVER_CACHE_MS
  ) {
    res.json(homeDataPayloadCache);
    return;
  }

  try {
    const payload = await buildHomeDataPayload();
    homeDataPayloadCache = payload;
    homeDataPayloadCacheAt = now;
    res.json(payload);
  } catch (e) {
    res.status(500).json({
      movies: {},
      lists: {},
      listOrder: [],
      banners: [],
      dbReady: false,
      error: e?.message || "Failed to load data",
    });
  }
});

app.get("/api/search", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) {
    res.json({ matches: [] });
    return;
  }
  if (mongoose.connection.readyState !== 1) {
    res.json({ matches: [] });
    return;
  }

  try {
    let movies = await Movie.find().lean();
    const missing = movies.filter(
      (m) => !String(m.tags || "").trim() && String(m.tmdbId || "").trim()
    );
    if (missing.length) {
      const batch = 6;
      for (let i = 0; i < missing.length; i += batch) {
        await Promise.all(
          missing
            .slice(i, i + batch)
            .map((m) => enrichMovieTagsFromTmdb(m).catch(() => ""))
        );
      }
      movies = await Movie.find().lean();
    }

    const tokens = tokenizeSearchQuery(q);
    const matches = movies
      .map((movie) => ({
        movieKey: movie.key,
        movie,
        score: scoreMovieForSearch(movie, tokens),
      }))
      .filter((row) => row.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          String(a.movie.title || "").localeCompare(String(b.movie.title || ""))
      )
      .slice(0, 60);

    res.json({ matches });
  } catch (e) {
    res.status(500).json({
      error: "Search failed",
      message: e?.message ?? String(e),
    });
  }
});

app.get("/api/blogs", async (req, res) => {
  if (mongoose.connection.readyState !== 1) {
    res.json([]);
    return;
  }
  const blogs = await Blog.find().sort({ createdAt: -1 }).lean();
  res.json(blogs);
});

app.get("/api/blog/:slug", async (req, res) => {
  if (mongoose.connection.readyState !== 1) {
    res.status(503).json({ error: "Database unavailable" });
    return;
  }
  const blog = await Blog.findOne({ slug: req.params.slug }).lean();
  if (!blog) {
    res.status(404).json({ error: "Blog not found" });
    return;
  }
  res.json(blog);
});

// Fetch VAST tag and return a usable HTML5 mediafile (prefer mp4/progressive)
// This avoids player.vast-vpaid picking a format that may render as black.
app.get("/api/vast/media", async (req, res) => {
  const tag = req.query.tag;
  if (!tag || typeof tag !== "string") {
    res.status(400).json({ error: "tag query param is required" });
    return;
  }

  try {
    const cacheKey = "vast:media:" + _normalizeTagKey(tag);
    const cached = _cacheGet(cacheKey);
    if (cached) {
      res.json(cached);
      return;
    }

    const { xml, wrapperImpressions } = await resolveVastXml(tag);
    const out = parseVastMediaPayload(xml, wrapperImpressions);
    if (out.media?.url) {
      out.media.playbackUrl =
        "/api/vast/stream?u=" + encodeURIComponent(out.media.url);
    }
    res.json(out);
    _cacheSet(cacheKey, out);
  } catch (e) {
    if (e?.status) {
      res.status(502).json({ error: "failed to fetch VAST tag", status: e.status });
      return;
    }
    res.status(500).json({
      error: "VAST parsing failed",
      message: e?.message ?? String(e),
    });
  }
});

// Proxy preroll MP4 through our server (referrer / hotlink blocks break direct <video src>).
app.get("/api/vast/stream", async (req, res) => {
  const u = req.query.u;
  if (!u || typeof u !== "string") {
    res.status(400).end();
    return;
  }
  if (!isValidVideoMediaUrl(u)) {
    res.status(400).end();
    return;
  }

  let referer = `${SITE_URL}/`;
  try {
    referer = new URL(u).origin + "/";
  } catch (_) {}

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const headers = {
      "user-agent": VAST_UA,
      referer,
      accept: "video/mp4,video/webm,video/*,*/*",
    };
    if (req.headers.range) headers.range = req.headers.range;

    const r = await fetch(u, {
      signal: ctrl.signal,
      headers,
      redirect: "follow",
    });
    if (!r.ok) {
      res.status(r.status === 404 ? 404 : 502).end();
      return;
    }

    res.status(r.status);
    for (const name of [
      "content-type",
      "content-length",
      "content-range",
      "accept-ranges",
    ]) {
      const v = r.headers.get(name);
      if (v) res.setHeader(name, v);
    }
    if (!res.getHeader("content-type")) {
      res.setHeader("content-type", "video/mp4");
    }
    res.setHeader("cache-control", "private, max-age=120");

    if (r.body) {
      await pipeline(Readable.fromWeb(r.body), res);
    } else {
      res.end();
    }
  } catch (_) {
    if (!res.headersSent) res.status(502).end();
  } finally {
    clearTimeout(timer);
  }
});

// Fire-and-forget tracker pings server-side (avoids CORS).
// Usage: /api/vast/track?u=ENCODED_URL
app.get("/api/vast/track", async (req, res) => {
  const u = req.query.u;
  if (!u || typeof u !== "string") {
    res.status(400).json({ error: "u query param is required" });
    return;
  }
  try {
    const r = await fetch(u, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ZyroMoviesVastTracker",
        accept: "*/*",
      },
      redirect: "follow",
    });
    res.json({ ok: r.ok, status: r.status });
  } catch (e) {
    res.status(502).json({ ok: false, error: e?.message ?? String(e) });
  }
});

// Proxy a VAST tag through this server (helps with CORS / blocked client fetches).
// Returns the raw VAST XML (or whatever upstream returns).
app.get("/api/vast/proxy", async (req, res) => {
  const tag = req.query.tag;
  if (!tag || typeof tag !== "string") {
    res.status(400).json({ error: "tag query param is required" });
    return;
  }

  try {
    const cacheKey = "vast:proxy:" + _normalizeTagKey(tag);
    const cached = _cacheGet(cacheKey);
    if (cached) {
      res.status(cached.status);
      res.setHeader("content-type", cached.contentType);
      res.send(cached.body);
      return;
    }

    const r = await fetch(tag, {
      headers: {
        "user-agent": VAST_UA,
        accept: "application/xml,text/xml,*/*",
      },
      redirect: "follow",
    });

    const ct = r.headers.get("content-type") || "";
    const body = await r.text();
    res.status(r.status);
    res.setHeader("content-type", ct || "application/xml; charset=utf-8");
    res.send(body);
    _cacheSet(cacheKey, {
      status: r.status,
      contentType: ct || "application/xml; charset=utf-8",
      body,
    });
  } catch (e) {
    res.status(502).json({
      error: "failed to proxy VAST tag",
      message: e?.message ?? String(e),
    });
  }
});

// Debug a VAST tag quickly: status, content-type, first bytes.
app.get("/api/vast/debug", async (req, res) => {
  const tag = req.query.tag;
  if (!tag || typeof tag !== "string") {
    res.status(400).json({ error: "tag query param is required" });
    return;
  }

  try {
    const cacheKey = "vast:debug:" + _normalizeTagKey(tag);
    const cached = _cacheGet(cacheKey);
    if (cached) {
      res.json(cached);
      return;
    }

    const body = await fetchVastText(tag);
    const out = {
      ok: true,
      status: 200,
      contentType: "application/xml",
      snippet: body.slice(0, 800),
    };
    res.json(out);
    _cacheSet(cacheKey, out);
  } catch (e) {
    res.status(502).json({
      error: "failed to debug VAST tag",
      message: e?.message ?? String(e),
    });
  }
});

// Create / update movie (used by admin Add + Edit)
app.post("/api/movie", async (req, res) => {
  if (mongoose.connection.readyState !== 1) {
    res.status(503).json({
      error: "Database not connected. Restart the server and check your MongoDB URI.",
    });
    return;
  }
  if (!req.body?.key) {
    res.status(400).json({ error: "Movie key is required." });
    return;
  }
  try {
    const body = { ...req.body };
    if (body.tmdbId) {
      try {
        body.tags = await buildTagsForMovieFromTmdb(
          body.tmdbId,
          body.type || "movie"
        );
      } catch (_) {}
    }
    const movie = await Movie.findOneAndUpdate(
      { key: body.key },
      body,
      { upsert: true, returnDocument: "after" }
    );
    invalidateHomeDataCache();
    res.json(movie);
  } catch (e) {
    res.status(500).json({
      error: "Failed to save movie",
      message: e?.message ?? String(e),
    });
  }
});

// Delete movie
app.delete("/api/movie/:key", async (req, res) => {
  const key = req.params.key;
  await Movie.deleteOne({ key });
  await List.updateMany({}, { $pull: { movieKeys: key } });
  invalidateHomeDataCache();
  res.json({ ok: true });
});

function isReservedRandomListName(name) {
  const t = String(name || "").trim();
  if (/^Random$/i.test(t)) return true;
  if (/^Random\s+\d+$/i.test(t)) return true;
  return false;
}

async function deleteListByName(name, res) {
  const trimmed = String(name || "").trim();
  if (!trimmed) {
    res.status(400).json({ error: "List name is required." });
    return;
  }
  if (isReservedRandomListName(trimmed)) {
    res.status(400).json({ error: "Random lists cannot be deleted." });
    return;
  }
  try {
    let result = await List.deleteOne({ name: trimmed });
    if (!result.deletedCount) {
      const all = await List.find().lean();
      const match = all.find(
        (l) =>
          String(l.name || "").trim().toLowerCase() === trimmed.toLowerCase()
      );
      if (match) {
        result = await List.deleteOne({ _id: match._id });
      }
    }
    if (!result.deletedCount) {
      res.status(404).json({
        error: `List "${trimmed}" was not found in the database. Restart the server and try again.`,
      });
      return;
    }
    invalidateHomeDataCache();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({
      error: "Failed to delete list",
      message: e?.message ?? String(e),
    });
  }
}

app.post("/api/list/delete", async (req, res) => {
  if (mongoose.connection.readyState !== 1) {
    res.status(503).json({
      error: "Database not connected. Restart the server and check your MongoDB URI.",
    });
    return;
  }
  await deleteListByName(req.body?.name, res);
});

app.delete("/api/list/:name", async (req, res) => {
  if (mongoose.connection.readyState !== 1) {
    res.status(503).json({
      error: "Database not connected. Restart the server and check your MongoDB URI.",
    });
    return;
  }
  await deleteListByName(decodeURIComponent(req.params.name || ""), res);
});

// Create list (if not exists) — also delete when body.action === "delete"
app.post("/api/list", async (req, res) => {
  if (mongoose.connection.readyState !== 1) {
    res.status(503).json({
      error: "Database not connected. Restart the server and check your MongoDB URI.",
    });
    return;
  }
  const { name, action } = req.body || {};
  if (action === "delete" || action === "remove") {
    await deleteListByName(name, res);
    return;
  }
  const listName = String(name || "").trim();
  if (!listName) {
    res.status(400).json({ error: "List name is required." });
    return;
  }
  const existing = await List.findOne({ name: listName });
  if (existing) {
    res.json(existing);
    return;
  }
  const maxAgg = await List.aggregate([
    { $group: { _id: null, m: { $max: "$sortOrder" } } },
  ]);
  const nextOrder = (maxAgg[0]?.m ?? 0) + 1;
  const list = await List.create({
    name: listName,
    movieKeys: [],
    sortOrder: nextOrder,
  });
  invalidateHomeDataCache();
  res.json(list);
});

// Set display order for lists on home page (1 = top). Random rows are always last (client-side).
app.post("/api/lists/reorder", async (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) {
    res.status(400).json({ error: "order must be an array of list names" });
    return;
  }
  await Promise.all(
    order.map((listName, i) =>
      List.updateOne({ name: listName }, { $set: { sortOrder: i + 1 } })
    )
  );
  invalidateHomeDataCache();
  res.json({ ok: true });
});

// Assign movie to list
app.post("/api/list/assign", async (req, res) => {
  if (mongoose.connection.readyState !== 1) {
    res.status(503).json({
      error: "Database not connected. Restart the server and check your MongoDB URI.",
    });
    return;
  }
  const { name, key } = req.body;
  if (!name || !key) {
    res.status(400).json({ error: "name and key are required" });
    return;
  }
  try {
    const list = await List.findOneAndUpdate(
      { name },
      { $addToSet: { movieKeys: key } },
      { upsert: true, returnDocument: "after" }
    );
    invalidateHomeDataCache();
    res.json(list);
  } catch (e) {
    res.status(500).json({
      error: "Failed to assign movie to list",
      message: e?.message ?? String(e),
    });
  }
});

// Add banner
app.post("/api/banner", async (req, res) => {
  const payload = { ...req.body };
  if (payload.tmdbId) {
    payload.movieKey = await resolveMovieKey(payload.tmdbId, payload.contentType);
  }
  const banner = await Banner.create(payload);
  invalidateHomeDataCache();
  res.json(banner);
});

// Delete banner
app.delete("/api/banner/:id", async (req, res) => {
  await Banner.findByIdAndDelete(req.params.id);
  invalidateHomeDataCache();
  res.json({ ok: true });
});

// Local video ads (admin upload + player preroll)
app.get("/api/local-ads", async (req, res) => {
  if (!mongoose.connection.readyState) {
    res.json([]);
    return;
  }
  const ads = await LocalAd.find().sort({ createdAt: -1 }).lean();
  res.json(ads);
});

app.get("/api/local-ads/next", async (req, res) => {
  if (!mongoose.connection.readyState) {
    res.status(204).end();
    return;
  }
  const ad = await LocalAd.findOneAndUpdate(
    {
      active: { $ne: false },
      $expr: { $lt: ["$playCount", "$maxPlays"] },
    },
    { $inc: { playCount: 1 } },
    {
      sort: { playCount: 1, createdAt: 1 },
      returnDocument: "after",
      lean: true,
    }
  );
  if (!ad?.videoUrl) {
    res.status(204).end();
    return;
  }
  const skip = normalizeLocalAdSkipFields(ad);

  res.json({
    source: "local",
    title: ad.title || "",
    videoUrl: ad.videoUrl,
    clickThroughUrl: ad.clickThroughUrl || "",
    allowSkip: skip.allowSkip,
    skipOffsetSeconds: skip.skipOffsetSeconds,
  });
});

app.post("/api/local-ads", async (req, res) => {
    try {
      if (!mongoose.connection.readyState) {
        res.status(503).json({ error: "Database not connected" });
        return;
      }

      const title = String(req.body?.title || "").trim();
      const maxPlays = Math.max(
        1,
        Math.floor(Number(req.body?.maxPlays) || 100)
      );
      const clickThroughUrl = String(req.body?.clickThroughUrl || "").trim();
      const dataUrl = String(req.body?.videoDataUrl || "");

      const skipMode = String(req.body?.skipMode || "none").toLowerCase();
      const allowSkip = skipMode === "after";
      let skipOffsetSeconds = null;
      if (allowSkip) {
        const raw = Number(
          req.body?.skipOffsetSeconds ?? req.body?.skipAfterSeconds ?? 5
        );
        if (Number.isFinite(raw) && raw >= 0 && raw <= 600) {
          skipOffsetSeconds = Math.floor(raw);
        } else {
          skipOffsetSeconds = 5;
        }
      }

      const match = dataUrl.match(/^data:video\/([\w+.-]+);base64,(.+)$/);
      if (!match) {
        res.status(400).json({ error: "Invalid video file. Use MP4 or WebM." });
        return;
      }

      let ext = match[1].toLowerCase();
      if (ext === "x-m4v") ext = "mp4";
      if (!["mp4", "webm", "mov", "ogv", "m4v"].includes(ext)) ext = "mp4";

      const buffer = Buffer.from(match[2], "base64");
      const maxBytes = 80 * 1024 * 1024;
      if (!buffer.length || buffer.length > maxBytes) {
        res
          .status(400)
          .json({ error: "Video empty or too large (max 80 MB)." });
        return;
      }

      const uploadDir = path.join(__dirname, "uploads", "local-ads");
      await fs.mkdir(uploadDir, { recursive: true });
      const filename = `ad-${Date.now()}-${Math.random().toString(36).slice(2, 9)}.${ext}`;
      await fs.writeFile(path.join(uploadDir, filename), buffer);

      const ad = await LocalAd.create({
        title: title || `Local ad ${filename}`,
        videoUrl: `/uploads/local-ads/${filename}`,
        maxPlays,
        playCount: 0,
        active: true,
        clickThroughUrl,
        allowSkip,
        skipOffsetSeconds,
        createdAt: Date.now(),
      });

      res.json(ad);
    } catch (err) {
      console.error("Local ad create failed:", err);
      res.status(500).json({ error: "Failed to save local ad" });
    }
});

app.patch("/api/local-ads/:id", async (req, res) => {
  if (!mongoose.connection.readyState) {
    res.status(503).json({ error: "Database not connected" });
    return;
  }
  const updates = {};
  if (typeof req.body?.active === "boolean") updates.active = req.body.active;
  if (req.body?.maxPlays != null) {
    updates.maxPlays = Math.max(1, Math.floor(Number(req.body.maxPlays) || 1));
  }
  if ("skipOffsetSeconds" in (req.body || {})) {
    const v = req.body.skipOffsetSeconds;
    if (v === null || v === "" || v === undefined) {
      updates.skipOffsetSeconds = null;
    } else {
      const n = Math.floor(Number(v));
      if (Number.isFinite(n) && n >= 0 && n <= 600) {
        updates.skipOffsetSeconds = n;
      }
    }
  }
  const skipModePatch = String(req.body?.skipMode || "").toLowerCase();
  if (skipModePatch === "none") {
    updates.allowSkip = false;
    updates.skipOffsetSeconds = null;
  } else if (skipModePatch === "after") {
    updates.allowSkip = true;
    const n = Math.floor(
      Number(req.body?.skipOffsetSeconds ?? req.body?.skipAfterSeconds ?? 5)
    );
    updates.skipOffsetSeconds =
      Number.isFinite(n) && n >= 0 && n <= 600 ? n : 5;
  } else if (typeof req.body?.allowSkip === "boolean") {
    updates.allowSkip = req.body.allowSkip;
    if (!req.body.allowSkip) updates.skipOffsetSeconds = null;
  }
  const ad = await LocalAd.findByIdAndUpdate(req.params.id, updates, {
    returnDocument: "after",
  });
  if (!ad) {
    res.status(404).json({ error: "Ad not found" });
    return;
  }
  res.json(ad);
});

app.delete("/api/local-ads/:id", async (req, res) => {
  if (!mongoose.connection.readyState) {
    res.status(503).json({ error: "Database not connected" });
    return;
  }
  const ad = await LocalAd.findByIdAndDelete(req.params.id);
  if (!ad) {
    res.status(404).json({ error: "Ad not found" });
    return;
  }
  const videoPath = String(ad.videoUrl || "");
  if (videoPath.startsWith("/uploads/local-ads/")) {
    const diskPath = path.join(__dirname, videoPath.replace(/^\//, ""));
    try {
      await fs.unlink(diskPath);
    } catch (_) {}
  }
  res.json({ ok: true });
});

app.post("/api/blog/upload-image", async (req, res) => {
  try {
    const dataUrl = String(req.body?.dataUrl || "");
    const match = dataUrl.match(/^data:image\/([\w+.-]+);base64,(.+)$/);
    if (!match) {
      res.status(400).json({ error: "Invalid image data" });
      return;
    }

    let ext = match[1].toLowerCase();
    if (ext === "jpeg") ext = "jpg";
    if (!["jpg", "png", "webp", "gif"].includes(ext)) ext = "jpg";

    const buffer = Buffer.from(match[2], "base64");
    if (!buffer.length) {
      res.status(400).json({ error: "Empty image file" });
      return;
    }

    const uploadDir = path.join(__dirname, "uploads", "blog");
    await fs.mkdir(uploadDir, { recursive: true });
    const filename = `blog-${Date.now()}-${Math.random().toString(36).slice(2, 9)}.${ext}`;
    await fs.writeFile(path.join(uploadDir, filename), buffer);

    res.json({ url: `/uploads/blog/${filename}` });
  } catch (err) {
    console.error("Blog image upload failed:", err);
    res.status(500).json({ error: "Failed to upload image" });
  }
});

app.post("/api/blog", async (req, res) => {
  try {
    const payload = req.body || {};
    if (!payload.tmdbId || !payload.title) {
      res.status(400).json({ error: "tmdbId and title are required" });
      return;
    }

    const now = Date.now();
    const slug = toSlug(payload.title, payload.tmdbId);
    const sections = Array.isArray(payload.sections)
      ? payload.sections.map((section) => ({
          textBefore: String(section?.textBefore || ""),
          imageDataUrl: String(section?.imageDataUrl || section?.imageUrl || ""),
          imageKind: section?.imageKind === "banner" ? "banner" : "photo",
          textAfter: String(section?.textAfter || ""),
        }))
      : [];

    const movieKey = await resolveMovieKey(payload.tmdbId, payload.contentType);

    const blog = await Blog.findOneAndUpdate(
      { slug },
      {
        slug,
        tmdbId: String(payload.tmdbId),
        contentType: String(payload.contentType || "movie"),
        movieKey,
        title: String(payload.title),
        overview: String(payload.overview || ""),
        description: String(payload.description || ""),
        seoKeywords: String(payload.seoKeywords || ""),
        sections,
        posterUrl: String(payload.posterUrl || ""),
        bannerUrl: String(payload.bannerUrl || ""),
        updatedAt: now,
        createdAt: payload.createdAt || now,
      },
      { upsert: true, new: true }
    );
    res.json(blog);
  } catch (err) {
    console.error("Blog save failed:", err);
    res.status(500).json({ error: "Failed to save blog" });
  }
});

app.delete("/api/blog/:id", async (req, res) => {
  await Blog.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
});

const PORT = Number(process.env.PORT) || 3001;

// Open the website when someone visits root.
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/blog", (req, res) => {
  res.sendFile(path.join(__dirname, "blog.html"));
});

app.get("/sitemap.xml", async (req, res) => {
  const urls = [
    { loc: `${SITE_URL}/`, changefreq: "daily", priority: "1.0" },
    { loc: `${SITE_URL}/blog`, changefreq: "daily", priority: "0.9" },
    { loc: `${SITE_URL}/blog.html`, changefreq: "daily", priority: "0.85" },
  ];

  if (mongoose.connection.readyState === 1) {
    const blogs = await Blog.find().select("slug updatedAt").lean();
    blogs.forEach((blog) => {
      urls.push({
        loc: `${SITE_URL}/blog/${encodeURIComponent(blog.slug)}`,
        changefreq: "weekly",
        priority: "0.88",
        lastmod: new Date(blog.updatedAt || Date.now()).toISOString().split("T")[0],
      });
    });
  }

  const body = urls
    .map((entry) => {
      const lastmod = entry.lastmod
        ? `\n    <lastmod>${entry.lastmod}</lastmod>`
        : "";
      return `  <url>
    <loc>${escapeHtml(entry.loc)}</loc>${lastmod}
    <changefreq>${entry.changefreq}</changefreq>
    <priority>${entry.priority}</priority>
  </url>`;
    })
    .join("\n");

  res.type("application/xml");
  res.send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>`
  );
});

app.get("/blog/:slug", async (req, res) => {
  if (mongoose.connection.readyState !== 1) {
    res.sendFile(path.join(__dirname, "blog.html"));
    return;
  }

  const blog = await Blog.findOne({ slug: req.params.slug }).lean();
  if (!blog) {
    res.status(404).sendFile(path.join(__dirname, "blog.html"));
    return;
  }

  const canonical = `${requestSiteOrigin(req)}/blog/${encodeURIComponent(blog.slug)}`;
  const { pageTitle, pageDescription, keywords, image } = buildBlogSeoMeta(blog, req);
  const movieKey =
    blog.movieKey || (await resolveMovieKey(blog.tmdbId, blog.contentType));
  const playHref = movieKey
    ? `/player.html?key=${encodeURIComponent(movieKey)}`
    : "/";
  const sectionsHtml = renderBlogSectionsHtml(blog, req);
  const intro = String(blog.description || "").trim();

  const jsonLd = [
    {
      "@context": "https://schema.org",
      "@type": "BlogPosting",
      headline: blog.title,
      description: pageDescription,
      image: [image],
      keywords,
      datePublished: new Date(blog.createdAt || Date.now()).toISOString(),
      dateModified: new Date(blog.updatedAt || blog.createdAt || Date.now()).toISOString(),
      mainEntityOfPage: canonical,
      author: { "@type": "Organization", name: "ZyroMovies" },
      publisher: {
        "@type": "Organization",
        name: "ZyroMovies",
        url: SITE_URL,
      },
    },
    {
      "@context": "https://schema.org",
      "@type": "Movie",
      name: blog.title,
      description: pageDescription,
      image,
      url: canonical,
      potentialAction: {
        "@type": "WatchAction",
        target: `${SITE_URL}${playHref}`,
      },
    },
  ];

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="robots" content="index, follow, max-image-preview:large" />
  <meta name="theme-color" content="#151515" />
  <title>${escapeHtml(pageTitle)}</title>
  <meta name="description" content="${escapeHtml(pageDescription)}" />
  <meta name="keywords" content="${escapeHtml(keywords)}" />
  <link rel="canonical" href="${escapeHtml(canonical)}" />
  <meta property="og:site_name" content="ZyroMovies" />
  <meta property="og:type" content="article" />
  <meta property="og:title" content="${escapeHtml(pageTitle)}" />
  <meta property="og:description" content="${escapeHtml(pageDescription)}" />
  <meta property="og:url" content="${escapeHtml(canonical)}" />
  <meta property="og:image" content="${escapeHtml(image)}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapeHtml(pageTitle)}" />
  <meta name="twitter:description" content="${escapeHtml(pageDescription)}" />
  <meta name="twitter:image" content="${escapeHtml(image)}" />
  <link rel="stylesheet" href="/style.css" />
  <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
</head>
<body>
  <div class="navbar">
    <div class="navbar-container">
      <div class="logo-container">
        <h1 class="logo"><a href="/index.html" style="color:inherit;text-decoration:none;">ZyroMovies</a></h1>
      </div>
      <div class="blog-nav-links">
        <a href="/index.html" class="site-blog-link">Home</a>
        <a href="/blog.html" class="site-blog-link">BLOG</a>
      </div>
    </div>
  </div>
  <main class="container">
    <article class="content-container blog-seo-article">
      <a href="/blog.html" class="admin-back-link">&larr; All blogs</a>
      <h1 class="movie-list-title">${escapeHtml(blog.title)}</h1>
      <p class="blog-seo-lead">${escapeHtml(pageDescription)}</p>
      <a class="blog-play-btn" href="${escapeHtml(playHref)}">&#9654; Watch ${escapeHtml(blog.title)} Online</a>
      ${intro ? `<div class="blog-detail-intro-wrap"><h2 class="blog-block-label">Intro</h2><p class="blog-detail-description">${escapeHtml(intro)}</p></div>` : ""}
      <div class="blog-detail-sections">${sectionsHtml}</div>
    </article>
  </main>
  <footer class="site-footer-nav">
    <a href="/blog.html" class="site-blog-link">BLOG</a>
  </footer>
  <script src="/api-config.js"></script>
  <script src="/blog.js"></script>
</body>
</html>`;

  res.send(html);
});

app.use(express.static(__dirname));

app.listen(PORT, () => {
  console.log("API running on http://localhost:" + PORT);
});

