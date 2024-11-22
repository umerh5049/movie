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
  serverSelectionTimeoutMS: 10000, // Timeout after 10 seconds if MongoDB is unreachable
  socketTimeoutMS: 45000, // Close sockets after 45 seconds of inactivity
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

// Save fetched data to MongoDB, avoiding duplicates
async function saveToDatabase(collection, data) {
  if (!data || data.length === 0) return;

  const bulkOps = data.map((movie) => ({
    updateOne: {
      filter: { id: movie.id },
      update: { $set: movie },
      upsert: true, // Insert if not exists
    },
  }));

  try {
    const result = await collection.bulkWrite(bulkOps, { ordered: false });
    console.log(`${result.upsertedCount} new movies inserted, ${result.modifiedCount} movies updated.`);
  } catch (error) {
    console.error("Error saving data to database:", error.message);
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
  });
}

// Start the Express server
async function startServer() {
  try {
    const db = await connectToDatabase();
    const movieCollection = db.collection('movies'); // Ensure the collection exists in your database

    // Fetch and save data for today's date on startup
    const todayDate = moment().format("YYYY-MM-DD");
    await fetchAndSaveForDate(movieCollection, todayDate);

    // Schedule the daily job
    scheduleDailyJob(movieCollection);

    // API endpoint to fetch movies from the database
    // app.get('/movies', async (req, res) => {
    //   try {
    //     const movies = await movieCollection
    //       .find()
    //       .sort({ primary_release_date: -1 })
    //       .toArray();
    //     res.json(movies);
    //   } catch (error) {
    //     console.error("Error fetching movies:", error.message);
    //     res.status(500).send("Error fetching movies");
    //   }
    // });


    app.get('/movies', async (req, res) => {
      try {
        const { page = 1, limit = 12 } = req.query; // Defaults
        const today = moment().format("YYYY-MM-DD"); // Current date
        const skip = (page - 1) * limit; // Pagination logic
    
        const movieCollection = client.db('Movie').collection('movies');
    
        // Fetch today's movies first
        const todaysMovies = await movieCollection
          .find({ primary_release_date: today }) // Filter by today's date
          .toArray();
    
        // Exclude today's movies from the rest of the query
        const otherMovies = await movieCollection
          .find({ primary_release_date: { $ne: today } }) // Movies not from today
          .sort({ primary_release_date: -1 }) // Descending by release date
          .skip(skip - todaysMovies.length) // Adjust skip for today's movies
          .limit(limit - todaysMovies.length) // Adjust limit for today's movies
          .toArray();
    
        // Combine today's movies and other movies
        const combinedMovies = [...todaysMovies, ...otherMovies].slice(0, limit);
    
        // Total count for pagination
        const totalMovies = await movieCollection.countDocuments();
    
        res.json({
          data: combinedMovies,
          currentPage: parseInt(page),
          totalPages: Math.ceil(totalMovies / limit),
          totalMovies,
        });
      } catch (error) {
        console.error("Error fetching movies:", error.message);
        res.status(500).send("Error fetching movies");
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

// Search endpoint
app.get('/search', async (req, res) => {
  const { query } = req.query;

  if (!query || query.trim() === '') {
    return res.status(400).json({ error: 'Query parameter is required.' });
  }

  try {
    const movieCollection = client.db('Movie').collection('movies');
    
    // Search movies with a case-insensitive regex query
    const searchResults = await movieCollection
      .find({ title: { $regex: query, $options: 'i' } })
      .limit(10) // Limit results for performance
      .toArray();

    res.json({ results: searchResults });
  } catch (error) {
    console.error("Error searching movies:", error.message);
    res.status(500).send({ error: 'Error searching movies.' });
  }
});

// Graceful shutdown for MongoDB connection
process.on('SIGINT', async () => {
  console.log('Shutting down server...');
  try {
    await client.close();
    console.log('MongoDB connection closed');
    process.exit(0);
  } catch (error) {
    console.error('Error closing MongoDB connection:', error.message);
    process.exit(1);
  }
});

// Start the server
startServer();
