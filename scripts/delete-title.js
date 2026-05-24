/**
 * Delete a title from MongoDB by title name (case-insensitive).
 * Usage: node scripts/delete-title.js "Scream 7"
 *
 * Server must be stopped OR use Atlas UI if connection fails from script.
 * Easier: Admin → Overview → Delete on "Scream 7" (after restarting node server.js).
 */
import "dotenv/config";
import mongoose from "mongoose";

const titleArg = process.argv.slice(2).join(" ").trim();
if (!titleArg) {
  console.error('Usage: node scripts/delete-title.js "Movie Title"');
  process.exit(1);
}

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

  const docs = await Movie.find({
    title: { $regex: new RegExp(`^${titleArg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") },
  }).lean();

  if (!docs.length) {
    console.log(`No movie found with title "${titleArg}".`);
    await mongoose.disconnect();
    return;
  }

  for (const doc of docs) {
    const key = doc.key || "";
    console.log("Deleting:", { _id: doc._id, key, title: doc.title, tmdbId: doc.tmdbId, type: doc.type });
    await Movie.deleteOne({ _id: doc._id });
    if (key) {
      await List.updateMany({}, { $pull: { movieKeys: key } });
    }
  }

  console.log(`Done. Removed ${docs.length} document(s).`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
