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

// Fetch data from TMDB API
async function fetchTMDBData(startDate, endDate) {
  try {
    const response = await axios.get(TMDB_BASE_URL, {
      params: {
        api_key: TMDB_API_KEY , // Use your actual API key, not the bearer token
      },
      headers: {
        'Authorization': `Bearer ${TMDB_API_KEY}` // Keep bearer token in headers if needed
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

// Save fetched data to MongoDB
async function saveToDatabase(collection, data) {
  try {
    const insertResult = await collection.insertMany(data, { ordered: false });
    console.log(`${insertResult.insertedCount} documents inserted successfully.`);
  } catch (error) {
    if (error.code === 11000) {
      console.log("Duplicate records found, skipping insertion.");
    } else {
      console.error("Error saving data to database:", error.message);
    }
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

// Start the Express server
async function startServer() {
  try {
    const db = await connectToDatabase();
    const loginCollection = db.collection('logins'); // Ensure the collection exists in your database

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
