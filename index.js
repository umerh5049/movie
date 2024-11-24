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
// app.use(cors());
// Add CORS configuration here
const allowedOrigins = ['https://www.mlwbd.movie', 'http://localhost:5173'];
app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));

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



// API endpoint to fetch only drama movies
app.get('/movies/drama', async (req, res) => {
  try {
    const { page = 1, limit = 12 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Filter movies by genre_id 18 (Drama)
    const dramaMovies = await movieCollection.find({
      genre_ids: { $in: [18] }, // Filter for movies with '18' in genre_ids
    })
      .sort({ release_date: -1 }) // Sort by release date descending
      .skip(skip)
      .limit(parseInt(limit))
      .toArray();

    const totalDramaMovies = await movieCollection.countDocuments({
      genre_ids: { $in: [18] },
    });

    res.json({
      data: dramaMovies,
      currentPage: parseInt(page),
      totalPages: Math.ceil(totalDramaMovies / parseInt(limit)),
      totalMovies: totalDramaMovies,
    });
  } catch (error) {
    console.error("Error fetching drama movies:", error.message);
    res.status(500).json({ error: "Error fetching drama movies" });
  }
});





// API endpoint to fetch only family movies
app.get('/movies/family', async (req, res) => {
  try {
    const { page = 1, limit = 12 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Filter movies by genre_id 10751 (Family)
    const familyMovies = await movieCollection.find({
      genre_ids: { $in: [10751] }, // Filter for movies with '10751' in genre_ids
    })
      .sort({ release_date: -1 }) // Sort by release date descending
      .skip(skip)
      .limit(parseInt(limit))
      .toArray();

    const totalFamilyMovies = await movieCollection.countDocuments({
      genre_ids: { $in: [10751] },
    });

    res.json({
      data: familyMovies,
      currentPage: parseInt(page),
      totalPages: Math.ceil(totalFamilyMovies / parseInt(limit)),
      totalMovies: totalFamilyMovies,
    });
  } catch (error) {
    console.error("Error fetching family movies:", error.message);
    res.status(500).json({ error: "Error fetching family movies" });
  }
});


// API endpoint to fetch only horror movies
app.get('/movies/horror', async (req, res) => {
  try {
    const { page = 1, limit = 12 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Filter movies by genre_id 27 (Horror)
    const horrorMovies = await movieCollection.find({
      genre_ids: { $in: [27] }, // Filter for movies with '27' in genre_ids
    })
      .sort({ release_date: -1 }) // Sort by release date descending
      .skip(skip)
      .limit(parseInt(limit))
      .toArray();

    const totalHorrorMovies = await movieCollection.countDocuments({
      genre_ids: { $in: [27] },
    });

    res.json({
      data: horrorMovies,
      currentPage: parseInt(page),
      totalPages: Math.ceil(totalHorrorMovies / parseInt(limit)),
      totalMovies: totalHorrorMovies,
    });
  } catch (error) {
    console.error("Error fetching horror movies:", error.message);
    res.status(500).json({ error: "Error fetching horror movies" });
  }
});



// API endpoint to fetch only thriller movies
app.get('/movies/thriller', async (req, res) => {
  try {
    const { page = 1, limit = 12 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Filter movies by genre_id 53 (Thriller)
    const thrillerMovies = await movieCollection.find({
      genre_ids: { $in: [53] }, // Filter for movies with '53' in genre_ids
    })
      .sort({ release_date: -1 }) // Sort by release date descending
      .skip(skip)
      .limit(parseInt(limit))
      .toArray();

    const totalThrillerMovies = await movieCollection.countDocuments({
      genre_ids: { $in: [53] },
    });

    res.json({
      data: thrillerMovies,
      currentPage: parseInt(page),
      totalPages: Math.ceil(totalThrillerMovies / parseInt(limit)),
      totalMovies: totalThrillerMovies,
    });
  } catch (error) {
    console.error("Error fetching thriller movies:", error.message);
    res.status(500).json({ error: "Error fetching thriller movies" });
  }
});


// API endpoint to fetch only comedy movies
app.get('/movies/comedy', async (req, res) => {
  try {
    const { page = 1, limit = 12 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Filter movies by genre_id 35 (Comedy)
    const comedyMovies = await movieCollection.find({
      genre_ids: { $in: [35] }, // Filter for movies with '35' in genre_ids
    })
      .sort({ release_date: -1 }) // Sort by release date descending
      .skip(skip)
      .limit(parseInt(limit))
      .toArray();

    const totalComedyMovies = await movieCollection.countDocuments({
      genre_ids: { $in: [35] },
    });

    res.json({
      data: comedyMovies,
      currentPage: parseInt(page),
      totalPages: Math.ceil(totalComedyMovies / parseInt(limit)),
      totalMovies: totalComedyMovies,
    });
  } catch (error) {
    console.error("Error fetching comedy movies:", error.message);
    res.status(500).json({ error: "Error fetching comedy movies" });
  }
});



// API endpoint to fetch only romance movies
app.get('/movies/romance', async (req, res) => {
  try {
    const { page = 1, limit = 12 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Filter movies by genre_id 10749 (Romance)
    const romanceMovies = await movieCollection.find({
      genre_ids: { $in: [10749] }, // Filter for movies with '10749' in genre_ids
    })
      .sort({ release_date: -1 }) // Sort by release date descending
      .skip(skip)
      .limit(parseInt(limit))
      .toArray();

    const totalRomanceMovies = await movieCollection.countDocuments({
      genre_ids: { $in: [10749] },
    });

    res.json({
      data: romanceMovies,
      currentPage: parseInt(page),
      totalPages: Math.ceil(totalRomanceMovies / parseInt(limit)),
      totalMovies: totalRomanceMovies,
    });
  } catch (error) {
    console.error("Error fetching romance movies:", error.message);
    res.status(500).json({ error: "Error fetching romance movies" });
  }
});


// API endpoint to fetch only adventure movies
app.get('/movies/adventure', async (req, res) => {
  try {
    const { page = 1, limit = 12 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Filter movies by genre_id 12 (Adventure)
    const adventureMovies = await movieCollection.find({
      genre_ids: { $in: [12] }, // Filter for movies with '12' in genre_ids
    })
      .sort({ release_date: -1 }) // Sort by release date descending
      .skip(skip)
      .limit(parseInt(limit))
      .toArray();

    const totalAdventureMovies = await movieCollection.countDocuments({
      genre_ids: { $in: [12] },
    });

    res.json({
      data: adventureMovies,
      currentPage: parseInt(page),
      totalPages: Math.ceil(totalAdventureMovies / parseInt(limit)),
      totalMovies: totalAdventureMovies,
    });
  } catch (error) {
    console.error("Error fetching adventure movies:", error.message);
    res.status(500).json({ error: "Error fetching adventure movies" });
  }
});

// API endpoint to fetch only Hindi movies
app.get('/movies/hindi', async (req, res) => {
  try {
    const { page = 1, limit = 12 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Filter movies by original_language "hi" (Hindi)
    const hindiMovies = await movieCollection.find({
      original_language: "hi",
    })
      .sort({ release_date: -1 }) // Sort by release date descending
      .skip(skip)
      .limit(parseInt(limit))
      .toArray();

    const totalHindiMovies = await movieCollection.countDocuments({
      original_language: "hi",
    });

    res.json({
      data: hindiMovies,
      currentPage: parseInt(page),
      totalPages: Math.ceil(totalHindiMovies / parseInt(limit)),
      totalMovies: totalHindiMovies,
    });
  } catch (error) {
    console.error("Error fetching Hindi movies:", error.message);
    res.status(500).json({ error: "Error fetching Hindi movies" });
  }
});



// API endpoint to fetch only Tamil movies
app.get('/movies/tamil', async (req, res) => {
  try {
    const { page = 1, limit = 12 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Filter movies by original_language "ta" (Tamil)
    const tamilMovies = await movieCollection.find({
      original_language: "ta",
    })
      .sort({ release_date: -1 }) // Sort by release date descending
      .skip(skip)
      .limit(parseInt(limit))
      .toArray();

    const totalTamilMovies = await movieCollection.countDocuments({
      original_language: "ta",
    });

    res.json({
      data: tamilMovies,
      currentPage: parseInt(page),
      totalPages: Math.ceil(totalTamilMovies / parseInt(limit)),
      totalMovies: totalTamilMovies,
    });
  } catch (error) {
    console.error("Error fetching Tamil movies:", error.message);
    res.status(500).json({ error: "Error fetching Tamil movies" });
  }
});



// API endpoint to fetch only Telugu movies
app.get('/movies/telugu', async (req, res) => {
  try {
    const { page = 1, limit = 12 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Filter movies by original_language "te" (Telugu)
    const teluguMovies = await movieCollection.find({
      original_language: "te",
    })
      .sort({ release_date: -1 }) // Sort by release date descending
      .skip(skip)
      .limit(parseInt(limit))
      .toArray();

    const totalTeluguMovies = await movieCollection.countDocuments({
      original_language: "te",
    });

    res.json({
      data: teluguMovies,
      currentPage: parseInt(page),
      totalPages: Math.ceil(totalTeluguMovies / parseInt(limit)),
      totalMovies: totalTeluguMovies,
    });
  } catch (error) {
    console.error("Error fetching Telugu movies:", error.message);
    res.status(500).json({ error: "Error fetching Telugu movies" });
  }
});




// API endpoint to fetch only English movies
app.get('/movies/english', async (req, res) => {
  try {
    const { page = 1, limit = 12 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Filter movies by original_language "en" (English)
    const englishMovies = await movieCollection.find({
      original_language: "en",
    })
      .sort({ release_date: -1 }) // Sort by release date descending
      .skip(skip)
      .limit(parseInt(limit))
      .toArray();

    const totalEnglishMovies = await movieCollection.countDocuments({
      original_language: "en",
    });

    res.json({
      data: englishMovies,
      currentPage: parseInt(page),
      totalPages: Math.ceil(totalEnglishMovies / parseInt(limit)),
      totalMovies: totalEnglishMovies,
    });
  } catch (error) {
    console.error("Error fetching English movies:", error.message);
    res.status(500).json({ error: "Error fetching English movies" });
  }
});


// API endpoint to fetch only Fantasy movies
app.get('/movies/fantasy', async (req, res) => {
  try {
    const { page = 1, limit = 12 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Filter movies by genre ID 14 (Fantasy)
    const fantasyMovies = await movieCollection.find({
      genre_ids: { $in: [14] },
    })
      .sort({ release_date: -1 }) // Sort by release date descending
      .skip(skip)
      .limit(parseInt(limit))
      .toArray();

    const totalFantasyMovies = await movieCollection.countDocuments({
      genre_ids: { $in: [14] },
    });

    res.json({
      data: fantasyMovies,
      currentPage: parseInt(page),
      totalPages: Math.ceil(totalFantasyMovies / parseInt(limit)),
      totalMovies: totalFantasyMovies,
    });
  } catch (error) {
    console.error("Error fetching Fantasy movies:", error.message);
    res.status(500).json({ error: "Error fetching Fantasy movies" });
  }
});



// API endpoint to fetch only Science Fiction movies
app.get('/movies/science-fiction', async (req, res) => {
  try {
    const { page = 1, limit = 12 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Filter movies by genre ID 878 (Science Fiction)
    const sciFiMovies = await movieCollection.find({
      genre_ids: { $in: [878] },
    })
      .sort({ release_date: -1 }) // Sort by release date descending
      .skip(skip)
      .limit(parseInt(limit))
      .toArray();

    const totalSciFiMovies = await movieCollection.countDocuments({
      genre_ids: { $in: [878] },
    });

    res.json({
      data: sciFiMovies,
      currentPage: parseInt(page),
      totalPages: Math.ceil(totalSciFiMovies / parseInt(limit)),
      totalMovies: totalSciFiMovies,
    });
  } catch (error) {
    console.error("Error fetching Science Fiction movies:", error.message);
    res.status(500).json({ error: "Error fetching Science Fiction movies" });
  }
});



// Endpoint for Horror Movies
app.get('/movies/horror', async (req, res) => {
  try {
    const { page = 1, limit = 12 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Filter by Horror genre (genre_id: 27)
    const horrorMovies = await movieCollection.find({
      genre_ids: { $in: [27] },
    })
      .sort({ release_date: -1 }) // Sort by newest release date
      .skip(skip)
      .limit(parseInt(limit))
      .toArray();

    const totalHorrorMovies = await movieCollection.countDocuments({
      genre_ids: { $in: [27] },
    });

    res.json({
      data: horrorMovies,
      currentPage: parseInt(page),
      totalPages: Math.ceil(totalHorrorMovies / parseInt(limit)),
      totalMovies: totalHorrorMovies,
    });
  } catch (error) {
    console.error("Error fetching horror movies:", error.message);
    res.status(500).json({ error: "Error fetching horror movies" });
  }
});






// API endpoint to fetch new releases grouped by language
app.get('/movies/new-releases', async (req, res) => {
  try {
    const languages = ["en", "te", "ta", "hi", "ml", "kn", "mr"]; // List of languages
    const limit = parseInt(req.query.limit) || 12; // Limit per language
    const response = {};

    for (const lang of languages) {
      const movies = await movieCollection
        .find({ original_language: lang })
        .sort({ release_date: -1 }) // Sort by release date descending
        .limit(limit)
        .toArray();
      response[lang] = movies;
    }

    res.json(response); // Return grouped movies by language
  } catch (error) {
    console.error("Error fetching new releases:", error.message);
    res.status(500).json({ error: "Error fetching new releases" });
  }
});



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


// API endpoint to fetch details of a specific movie by ID
app.get('/movies/:id', async (req, res) => {
  try {
    const { id } = req.params; // Extract the movie ID from the request params

    // Query the database for the movie by its ID
    const movie = await movieCollection.findOne({ id: parseInt(id) });

    if (!movie) {
      // Return 404 if the movie is not found
      return res.status(404).json({ error: "Movie not found." });
    }

    // Add the TMDB base URL to image paths
    const BASE_IMAGE_URL = "https://image.tmdb.org/t/p/w500";

    // Enhance the response with full image URLs
    const response = {
      ...movie,
      poster_url: movie.poster_path ? `${BASE_IMAGE_URL}${movie.poster_path}` : null,
      backdrop_urls: movie.backdrop_path
        ? [`${BASE_IMAGE_URL}${movie.backdrop_path}`]
        : [],
    };

    // Send the movie details as a JSON response
    res.json(response);
  } catch (error) {
    console.error("Error fetching movie details:", error.message);
    // Return 500 on any unexpected errors
    res.status(500).json({ error: "Error fetching movie details." });
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
