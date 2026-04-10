'use strict';

const { Schema, model, Types } = require('mongoose');

const MessageSchema = new Schema(
  {
    userId: {
      type: Types.ObjectId,
      ref: 'User',
      required: true,
    },
    status: {
      type: String,
      enum: ['sent', 'delivered'],
      default: 'sent',
    },
    response: {
      type: String,
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = model('Message', MessageSchema);