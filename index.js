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

// Single database connection
let db;

// Connect to MongoDB and return the database instance
async function connectToDatabase() {
  if (!db) {
    try {
      await client.connect();
      console.log("Connected to MongoDB Atlas");
      db = client.db('Movie');
    } catch (error) {
      console.error("Error connecting to MongoDB Atlas:", error.message);
      throw error;
    }
  }
  return db;
}

// Remove duplicates from the database
async function removeDuplicates(collection) {
  try {
    const pipeline = [
      {
        $group: {
          _id: "$id", // Group by the `id` field
          count: { $sum: 1 },
          docs: { $push: "$_id" }, // Collect all `_id`s for duplicates
        },
      },
      { $match: { count: { $gt: 1 } } }, // Only consider duplicates
    ];

    const duplicates = await collection.aggregate(pipeline).toArray();
    for (const doc of duplicates) {
      const [keep, ...remove] = doc.docs; // Keep the first one
      await collection.deleteMany({ _id: { $in: remove } }); // Remove the rest
    }

    console.log("Duplicate entries removed.");
  } catch (error) {
    console.error("Error removing duplicates:", error.message);
    throw error;
  }
}

// Fetch data from TMDB API
async function fetchTMDBData(startDate, endDate) {
  try {
    const response = await axios.get(TMDB_BASE_URL, {
      headers: {
        'Authorization': `Bearer ${TMDB_API_KEY}`
      },
      params: {
        primary_release_date_gte: startDate,
        primary_release_date_lte: endDate,
        sort_by: "release_date.desc",
      },
    });
    return response.data.results;
  } catch (error) {
    console.error("Error fetching data from TMDB:", error.response?.data || error.message);
    throw error;
  }
}

// Save fetched data to MongoDB with upsert to prevent duplicates
async function saveToDatabase(collection, data) {
  try {
    const bulkOps = data.map(item => ({
      updateOne: {
        filter: { id: item.id }, // Use TMDB's `id` field as a unique identifier
        update: { $set: item },
        upsert: true, // Insert the document if it doesn't exist
      }
    }));

    if (bulkOps.length > 0) {
      const bulkResult = await collection.bulkWrite(bulkOps, { ordered: false });
      console.log(`${bulkResult.upsertedCount} new documents inserted. ${bulkResult.modifiedCount} documents updated.`);
    }
  } catch (error) {
    console.error("Error saving data to database:", error.message);
  }
}

// Fetch and save data for the last 10 days
async function fetchAndSaveLast10DaysData(loginCollection) {
  const endDate = moment().format("YYYY-MM-DD");
  const startDate = moment().subtract(10, "days").format("YYYY-MM-DD");

  console.log(`Fetching TMDB data from ${startDate} to ${endDate}...`);

  const tmdbData = await fetchTMDBData(startDate, endDate);
  if (tmdbData && tmdbData.length > 0) {
    await saveToDatabase(loginCollection, tmdbData);
  } else {
    console.log("No data available for the specified date range.");
  }
}

// Schedule a daily job to fetch current day's data at 3 AM
function scheduleDailyJob(loginCollection) {
  cron.schedule("0 3 * * *", async () => {
    console.log("Running daily TMDB data fetch job at 3 AM...");
    const todayDate = moment().format("YYYY-MM-DD");
    const tmdbData = await fetchTMDBData(todayDate, todayDate);
    if (tmdbData && tmdbData.length > 0) {
      await saveToDatabase(loginCollection, tmdbData);
    } else {
      console.log("No data available for today's date.");
    }
  });
}

// New route to fetch all data from the 'logins' collection
app.get('/data', async (req, res) => {
  try {
    const db = await connectToDatabase();
    const loginCollection = db.collection('logins');

    // Fetch all documents from the collection
    const allData = await loginCollection.find({}).toArray();

    // Check if data exists
    if (allData.length > 0) {
      res.json(allData); // Return the data as JSON
    } else {
      res.status(404).json({ message: "No data found." }); // If no data is found, return a 404 status
    }
  } catch (error) {
    console.error("Error fetching data from database:", error.message);
    res.status(500).json({ message: "Error fetching data from database.", error: error.message });
  }
});

// Start the Express server
async function startServer() {
  try {
    const db = await connectToDatabase();
    const loginCollection = db.collection('logins');

    // Remove duplicates before creating a unique index
    await removeDuplicates(loginCollection);

    // Ensure unique index on `id` field
    await loginCollection.createIndex({ id: 1 }, { unique: true });

    // Fetch and save data for the last 10 days on startup
    await fetchAndSaveLast10DaysData(loginCollection);

    // Schedule the daily job
    scheduleDailyJob(loginCollection);

    // Test route
    app.get('/', async (req, res) => {
      res.send('TMDB data fetching and saving service is running.');
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
