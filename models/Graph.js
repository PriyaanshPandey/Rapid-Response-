const mongoose = require('mongoose');

const GraphSchema = new mongoose.Schema({
  name: { type: String, default: 'current' },
  nodePositions: { type: Object, required: true },
  nodeAdjacency: { type: Object, required: true },
  meetingPoints: { type: Array, default: [] },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Graph', GraphSchema);
