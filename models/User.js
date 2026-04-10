'use strict';

const { Schema, model } = require('mongoose');

const UserSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    phone: {
      type: String,
      required: true,
      trim: true,
    },
    type: {
      type: String,
      enum: ['guest', 'staff'],
      required: true,
    },
    role: {
      type: String,
      enum: ['rescue', 'evac'],
      default: 'rescue',
    },
    node: {
      type: String,
      default: null,
    },
    status: {
      type: String,
      enum: ['safe', 'help', 'idle', 'moving'],
      default: 'idle',
    },
    assignedTo: {
      type: String,
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = model('User', UserSchema);