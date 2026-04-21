import "dotenv/config";
import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import dns from "dns";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Serve the front-end files from the same folder as server.js
app.use(express.static(__dirname));

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

const movieSchema = new mongoose.Schema({
  key: String,
  tmdbId: String,
  type: String,
  title: String,
  overview: String,
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
  imageDataUrl: String,
  createdAt: Number,
});

const Movie = mongoose.model("Movie", movieSchema);
const List = mongoose.model("List", listSchema);
const Banner = mongoose.model("Banner", bannerSchema);

// ---- API ----

// All data for front-end (movies by key, lists by name, banners array)
app.get("/api/data", async (req, res) => {
  if (mongoose.connection.readyState !== 1) {
    res.json({ movies: {}, lists: {}, listOrder: [], banners: [] });
    return;
  }

  const [movies, listsFromDb, banners] = await Promise.all([
    Movie.find().lean(),
    List.find().lean(),
    Banner.find().lean(),
  ]);

  let lists = listsFromDb;

  const moviesByKey = {};
  movies.forEach((m) => {
    moviesByKey[m.key] = m;
  });

  const listsByName = {};
  lists.forEach((l) => {
    listsByName[l.name] = l.movieKeys || [];
  });

  // Backfill sortOrder for legacy documents (once per doc).
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
    lists = await List.find().lean();
  }

  lists.sort(
    (a, b) =>
      (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0) ||
      String(a.name).localeCompare(String(b.name))
  );
  const listOrder = lists.map((l) => l.name);

  res.json({ movies: moviesByKey, lists: listsByName, listOrder, banners });
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

    const r = await fetch(tag, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ZyroMoviesVastProxy",
      },
    });
    if (!r.ok) {
      res
        .status(502)
        .json({ error: "failed to fetch VAST tag", status: r.status });
      return;
    }

    const xml = await r.text();

    // Duration: prefer HH:MM:SS; fallback to MM:SS.
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

    // Skip offset (VAST Linear skipoffset="HH:MM:SS" or "MM:SS" or "15%" or "15").
    // We'll expose seconds when determinable; otherwise null.
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
      // HH:MM:SS or MM:SS
      const hms = raw.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
      if (hms) {
        return Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3]);
      }
      const ms = raw.match(/^(\d{1,2}):(\d{2})$/);
      if (ms) {
        return Number(ms[1]) * 60 + Number(ms[2]);
      }
      // plain seconds
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

    // ClickThrough URL (open in new tab on user click)
    const clickThroughUrl = (() => {
      const m = xml.match(
        /<ClickThrough[^>]*>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/ClickThrough>/i
      );
      const url = String((m && m[1]) || "").trim();
      return url || null;
    })();

    // Trackers (we'll ping these server-side to avoid CORS issues)
    const impressionUrls = extractCdataUrls(/<Impression[^>]*>[\s\S]*?<\/Impression>/gi);
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

    const escType = (t) => t.replace(/\//g, "\\/");

    // VAST MediaFile URLs usually live inside CDATA. Regex match can be fragile
    // across VAST variants, so we extract all <MediaFile> blocks for a given type
    // then pick the first progressive (delivery="progressive") else fallback first.
    const extractMediaFile = (wantedType) => {
      const typeEsc = escType(wantedType);

      const reMediaFile = new RegExp(
        `<MediaFile[^>]*type="${typeEsc}"[^>]*>[\\s\\S]*?<\\/MediaFile>`,
        "gi"
      );

      const progressiveFirst = [];
      const any = [];

      const blocks = xml.match(reMediaFile) || [];
      for (const block of blocks) {
        // Extract CDATA content if present
        const cdataMatch = block.match(
          /<!\[CDATA\[([\s\S]*?)\]\]>/i
        );
        const url = (cdataMatch ? cdataMatch[1] : "")
          .replace(/^\s+|\s+$/g, "");
        if (!url) continue;

        const isProgressive = /delivery="progressive"/i.test(block);
        const item = { type: wantedType, url };
        if (isProgressive) progressiveFirst.push(item);
        else any.push(item);
      }

      if (progressiveFirst.length) return progressiveFirst[0];
      if (any.length) return any[0];
      return null;
    };

    let media = extractMediaFile("video/mp4");
    if (!media) media = extractMediaFile("video/webm");

    const out = {
      durationSeconds,
      skipOffsetSeconds,
      clickThroughUrl,
      impressionUrls,
      clickTrackingUrls,
      trackingEvents,
      media,
    };
    res.json(out);
    _cacheSet(cacheKey, out);
  } catch (e) {
    res.status(500).json({
      error: "VAST parsing failed",
      message: e?.message ?? String(e),
    });
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
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ZyroMoviesVastProxy",
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

    const r = await fetch(tag, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ZyroMoviesVastProxy",
        accept: "application/xml,text/xml,*/*",
      },
      redirect: "follow",
    });
    const ct = r.headers.get("content-type") || "";
    const body = await r.text();
    const out = {
      ok: r.ok,
      status: r.status,
      contentType: ct,
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
  const movie = await Movie.findOneAndUpdate(
    { key: req.body.key },
    req.body,
    { upsert: true, new: true }
  );
  res.json(movie);
});

// Delete movie
app.delete("/api/movie/:key", async (req, res) => {
  const key = req.params.key;
  await Movie.deleteOne({ key });
  await List.updateMany({}, { $pull: { movieKeys: key } });
  res.json({ ok: true });
});

// Create list (if not exists)
app.post("/api/list", async (req, res) => {
  const { name } = req.body;
  const existing = await List.findOne({ name });
  if (existing) {
    res.json(existing);
    return;
  }
  const maxAgg = await List.aggregate([
    { $group: { _id: null, m: { $max: "$sortOrder" } } },
  ]);
  const nextOrder = (maxAgg[0]?.m ?? 0) + 1;
  const list = await List.create({
    name,
    movieKeys: [],
    sortOrder: nextOrder,
  });
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
  res.json({ ok: true });
});

// Assign movie to list
app.post("/api/list/assign", async (req, res) => {
  const { name, key } = req.body;
  const list = await List.findOneAndUpdate(
    { name },
    { $addToSet: { movieKeys: key } },
    { upsert: true, new: true }
  );
  res.json(list);
});

// Add banner
app.post("/api/banner", async (req, res) => {
  const banner = await Banner.create(req.body);
  res.json(banner);
});

// Delete banner
app.delete("/api/banner/:id", async (req, res) => {
  await Banner.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
});

const PORT = Number(process.env.PORT) || 3001;

// Open the website when someone visits root.
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log("API running on http://localhost:" + PORT);
});

