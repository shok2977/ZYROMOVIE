import "dotenv/config";
import mongoose from "mongoose";

const MONGO_URI =
  process.env.MONGODB_URI ||
  process.env.MONGO_URI ||
  "mongodb+srv://Aditya:Aditya@cap.nwkww.mongodb.net/cap?retryWrites=true&w=majority";

const movieSchema = new mongoose.Schema({}, { strict: false });
const listSchema = new mongoose.Schema({}, { strict: false });

async function main() {
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 20000 });
  const Movie = mongoose.model("Movie", movieSchema, "movies");
  const List = mongoose.model("List", listSchema, "lists");

  const scream = await Movie.find({
    $or: [
      { title: /scream/i },
      { key: /scream/i },
    ],
  }).lean();

  const horrorLists = await List.find({
    name: /horror/i,
  }).lean();

  const allLists = await List.find().select("name movieKeys").lean();
  const movieCount = await Movie.countDocuments();

  console.log("=== MongoDB debug ===");
  console.log("Total movies:", movieCount);
  console.log("Total lists:", allLists.length);
  console.log("\n--- Horror lists ---");
  console.log(JSON.stringify(horrorLists, null, 2));
  console.log("\n--- Scream matches ---");
  scream.forEach((m) => {
    console.log({
      _id: m._id,
      key: m.key,
      title: m.title,
      tmdbId: m.tmdbId,
      type: m.type,
    });
  });

  const listsWithScream = allLists.filter((l) =>
    (l.movieKeys || []).some((k) => {
      const s = String(k).toLowerCase();
      return s.includes("scream") || scream.some((m) => m.key === k);
    })
  );
  console.log("\n--- Lists referencing scream keys ---");
  console.log(JSON.stringify(listsWithScream, null, 2));

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
