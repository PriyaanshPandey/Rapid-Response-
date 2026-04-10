'use strict';

const { Schema, model } = require('mongoose');

const IncidentSchema = new Schema(
  {
    type: {
      type: String,
      enum: ['fire'],
      required: true,
      default: 'fire',
    },
    node: {
      type: String,
      required: true,
    },
    blockedNodes: {
      type: [String],
      default: [],
    },
    status: {
      type: String,
      enum: ['active', 'resolved'],
      default: 'active',
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: false }
);

module.exports = model('Incident', IncidentSchema);