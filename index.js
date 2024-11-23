const express = require('express');
const { MongoClient } = require('mongodb');
const cors = require('cors');
const axios = require('axios');
const cron = require('node-cron');
const moment = require('moment');

const app = express();

// MongoDB connection URI
const uri = "mongodb+srv://umerh5049:umerh5049@movie.wi2dn.mongodb.net/?retryWrites=true&w=majority&appName=movie";

// Initialize MongoClient with connection options
const client = new MongoClient(uri, {
  serverSelectionTimeoutMS: 10000,
  socketTimeoutMS: 45000,
});

app.use(express.json());
app.use(cors());

// TMDB API settings
const TMDB_API_KEY = "eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJkY2E4YWM3NTFkMjBiNzM2OTRkOTc4Y2FkODYzODIyOCIsIm5iZiI6MTczMTcwMTU1Ny4wNzM3MzkzLCJzdWIiOiI2NzM3NmM3N2ZmZTM4NzhlOWU5ZmM1ZDIiLCJzY29wZXMiOlsiYXBpX3JlYWQiXSwidmVyc2lvbiI6MX0.hbRU_MpaaDaHCD1RMy4YuzBgxYUJDmT0nSIjTbsWQ9s";
const TMDB_BASE_URL = "https://api.themoviedb.org/3/discover/movie";

// Connect to MongoDB and return the database instance
async function connectToDatabase() {
  try {
    await client.connect();
    console.log("Connected to MongoDB Atlas");
    return client.db('Movie');
  } catch (error) {
    console.error("Error connecting to MongoDB Atlas:", error.message);
    throw error;
  }
}

// Fetch data from TMDB API with pagination
async function fetchTMDBDataForDate(releaseDate) {
  let allMovies = [];
  let currentPage = 1;
  let totalPages = 1;

  try {
    do {
      console.log(`Fetching page ${currentPage} of ${totalPages} for date ${releaseDate}...`);
      const response = await axios.get(TMDB_BASE_URL, {
        headers: {
          Authorization: `Bearer ${TMDB_API_KEY}`,
        },
        params: {
          "primary_release_date.gte": releaseDate,
          "primary_release_date.lte": releaseDate,
          sort_by: "primary_release_date.desc",
          page: currentPage,
        },
      });

      allMovies = [...allMovies, ...response.data.results];
      totalPages = response.data.total_pages;
      currentPage++;
    } while (currentPage <= totalPages);

    console.log(`Fetched ${allMovies.length} movies for date ${releaseDate}`);
    return allMovies;
  } catch (error) {
    console.error("Error fetching data from TMDB:", error.response?.data || error.message);
    throw error;
  }
}

// Save fetched data to MongoDB, avoiding duplicates and excluding movies without poster_path
async function saveToDatabase(collection, data) {
  if (!data || data.length === 0) return;

  const validMovies = data.filter((movie) => movie.poster_path);

  if (validMovies.length === 0) {
    console.log("No valid movies with poster images to save.");
    return;
  }

  const bulkOps = validMovies.map((movie) => ({
    updateOne: {
      filter: { id: movie.id },
      update: { $set: movie },
      upsert: true,
    },
  }));

  try {
    const result = await collection.bulkWrite(bulkOps, { ordered: false });
    console.log(`${result.upsertedCount} new movies inserted, ${result.modifiedCount} movies updated.`);
  } catch (error) {
    console.error("Error saving data to database:", error.message);
  }
}

// Delete movies without poster_path from the database
async function deleteMoviesWithoutPoster(collection) {
  try {
    const result = await collection.deleteMany({
      $or: [{ poster_path: { $exists: false } }, { poster_path: null }, { poster_path: "" }],
    });
    console.log(`Deleted ${result.deletedCount} movies without poster images.`);
  } catch (error) {
    console.error("Error deleting movies without poster images:", error.message);
  }
}

// Fetch and save data for a specific date
async function fetchAndSaveForDate(collection, date) {
  console.log(`Fetching and saving data for date ${date}...`);
  const movies = await fetchTMDBDataForDate(date);
  await saveToDatabase(collection, movies);
}

// Schedule a daily job to fetch and save current day's data
function scheduleDailyJob(collection) {
  cron.schedule("0 3 * * *", async () => {
    console.log("Running daily TMDB data fetch job at 3 AM...");
    const todayDate = moment().format("YYYY-MM-DD");
    await fetchAndSaveForDate(collection, todayDate);
    await deleteMoviesWithoutPoster(collection); // Cleanup after daily fetch
  });
}



// Remove duplicate movies based on the 'id' field
async function removeDuplicateMovies(collection) {
  try {
    const pipeline = [
      {
        $group: {
          _id: "$id", // Group by the 'id' field
          count: { $sum: 1 }, // Count occurrences of each id
          docs: { $push: "$_id" }, // Collect all _id values of documents with the same id
        },
      },
      {
        $match: {
          count: { $gt: 1 }, // Only keep groups with more than one document
        },
      },
    ];

    const duplicates = await collection.aggregate(pipeline).toArray();

    let totalRemoved = 0;
    for (const duplicate of duplicates) {
      const [keep, ...remove] = duplicate.docs; // Keep the first document, remove the rest
      const result = await collection.deleteMany({ _id: { $in: remove } });
      totalRemoved += result.deletedCount;
    }

    console.log(`Removed ${totalRemoved} duplicate movies.`);
  } catch (error) {
    console.error("Error removing duplicate movies:", error.message);
  }
}


async function startServer() {
  try {
    const db = await connectToDatabase();
    const movieCollection = db.collection('movies');

    // Cleanup movies without poster images on startup
    await deleteMoviesWithoutPoster(movieCollection);

    // Remove existing duplicate movies
    await removeDuplicateMovies(movieCollection);

    // Fetch and save data for today's date on startup
    const todayDate = moment().format("YYYY-MM-DD");
    await fetchAndSaveForDate(movieCollection, todayDate);

    // Schedule the daily job
    scheduleDailyJob(movieCollection);

    // API endpoint to fetch movies
    app.get('/movies', async (req, res) => {
      try {
        const { page = 1, limit = 12 } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);

        const today = moment().startOf('day').toISOString();
        const todayMovies = await movieCollection.find({
          release_date: {
            $gte: today,
            $lt: moment().endOf('day').toISOString(),
          },
        }).toArray();

        const otherMovies = await movieCollection.find({
          release_date: { $lt: today },
        })
          .sort({ release_date: -1 })
          .skip(Math.max(0, skip - todayMovies.length))
          .limit(Math.max(0, parseInt(limit) - todayMovies.length))
          .toArray();

        const combinedMovies = [...todayMovies, ...otherMovies].slice(0, limit);
        const totalMovies = await movieCollection.countDocuments();

        res.json({
          data: combinedMovies,
          currentPage: parseInt(page),
          totalPages: Math.ceil(totalMovies / parseInt(limit)),
          totalMovies,
          todayCount: todayMovies.length,
        });
      } catch (error) {
        console.error("Error fetching movies:", error.message);
        res.status(500).json({ error: "Error fetching movies" });
      }
    });

    // API endpoint for manual cleanup
    app.delete('/movies/cleanup', async (req, res) => {
      try {
        await deleteMoviesWithoutPoster(movieCollection);
        await removeDuplicateMovies(movieCollection);
        res.json({ message: "Cleanup completed. Invalid and duplicate movies removed." });
      } catch (error) {
        console.error("Error cleaning up movies:", error.message);
        res.status(500).json({ error: "Error cleaning up movies" });
      }
    });


    // API endpoint to fetch only action movies
app.get('/movies/action', async (req, res) => {
  try {
    const { page = 1, limit = 12 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Filter movies by genre_id 28 (action)
    const actionMovies = await movieCollection.find({
      genre_ids: { $in: [28] }, // Filter for movies that include '28' in their genre_ids
    })
      .sort({ release_date: -1 }) // Sort by release date descending
      .skip(skip)
      .limit(parseInt(limit))
      .toArray();

    const totalActionMovies = await movieCollection.countDocuments({
      genre_ids: { $in: [28] },
    });

    res.json({
      data: actionMovies,
      currentPage: parseInt(page),
      totalPages: Math.ceil(totalActionMovies / parseInt(limit)),
      totalMovies: totalActionMovies,
    });
  } catch (error) {
    console.error("Error fetching action movies:", error.message);
    res.status(500).json({ error: "Error fetching action movies" });
  }
});




    const port = process.env.PORT || 8080;
    app.listen(port, () => {
      console.log(`Server running on port ${port}`);
    });
  } catch (error) {
    console.error("Error starting server:", error.message);
    process.exit(1);
  }
}

// Start the server
startServer();
