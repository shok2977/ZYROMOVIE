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

// WARNING: rotate this password in Atlas, never keep real creds in code for production.
const MONGO_URI =
  "mongodb+srv://Aditya:Aditya@cap.nwkww.mongodb.net/cap?retryWrites=true&w=majority";

// Some networks (or Node DNS) may fail SRV lookups unless we force the resolver.
// In your machine this matches nslookup's DNS server (127.0.2.2).
dns.setServers(["127.0.2.2"]);

await mongoose.connect(MONGO_URI);

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
  const [movies, lists, banners] = await Promise.all([
    Movie.find().lean(),
    List.find().lean(),
    Banner.find().lean(),
  ]);

  const moviesByKey = {};
  movies.forEach((m) => {
    moviesByKey[m.key] = m;
  });

  const listsByName = {};
  lists.forEach((l) => {
    listsByName[l.name] = l.movieKeys || [];
  });

  res.json({ movies: moviesByKey, lists: listsByName, banners });
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
  const list = await List.findOneAndUpdate(
    { name },
    { $setOnInsert: { movieKeys: [] } },
    { upsert: true, new: true }
  );
  res.json(list);
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

const PORT = 3001;

// Open the website when someone visits root.
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log("API running on http://localhost:" + PORT);
});

