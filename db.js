'use strict';

require('dotenv').config();
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGO_URI || process.env.MONGO_URL || 'mongodb://localhost:27017/rapidresponse';

async function connectDB() {
  const isLocal = MONGO_URI.includes('localhost') || MONGO_URI.includes('127.0.0.1');
  const isCloud = process.env.NODE_ENV === 'production' || !!process.env.RENDER;

  if (isLocal && isCloud) {
    console.error(' [CRITICAL] MONGO_URI is pointing to localhost but app is running in the Cloud (Render/Vercel).');
    console.error(' Please set the MONGO_URI environment variable in your Render dashboard.');
    process.exit(1);
  }

  try {
    await mongoose.connect(MONGO_URI);
    console.log(' [RAPID RESPONSE] MongoDB Connection Established');
  } catch (err) {
    console.error(' [RAPID RESPONSE ERROR] MongoDB connection failed:');
    console.error(`   URI: ${MONGO_URI.split('@').pop()}`); // Log only the host part for security
    console.error(`   Error: ${err.message}`);
    process.exit(1);
  }
}

module.exports = connectDB;