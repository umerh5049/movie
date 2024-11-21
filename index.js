const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const cors = require('cors');

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

// Connect to MongoDB and return the database instance
async function connectToDatabase() {
  try {
    await client.connect();
    console.log("Connected to MongoDB Atlas");
    return client.db('flexfitdb'); // Change 'flexfitdb' to your actual database name if needed
  } catch (error) {
    console.error("Error connecting to MongoDB Atlas:", error.message);
    throw error;
  }
}

// Start the Express server
async function startServer() {
  try {
    const db = await connectToDatabase();
    const loginCollection = db.collection('logins'); // Ensure the collection exists in your database

    // Test route
    app.get('/', async (req, res) => {
      try {
        const document = await loginCollection.findOne();
        if (document) {
          res.send('Database connection and collection are successfully connected!');
        } else {
          res.send('Database connection is successful, but the collection does not exist or is empty.');
        }
      } catch (error) {
        console.error("Error testing database connection:", error.message);
        res.status(500).send("Error testing database connection: " + error.message);
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
