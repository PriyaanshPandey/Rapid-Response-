'use strict';

const { Schema, model } = require('mongoose');

const LogSchema = new Schema({
  message: {
    type: String,
    required: true,
  },
  timestamp: {
    type: Date,
    default: Date.now,
  },
});

module.exports = model('Log', LogSchema);