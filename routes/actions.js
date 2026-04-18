'use strict';

const { Router } = require('express');
const User = require('../models/User');
const Log  = require('../models/Log');
const Graph = require('../models/Graph');

const router = Router();

// POST /api/user-status
router.post('/user-status', async (req, res, next) => {
  try {
    const { userId, status, node } = req.body;

    const VALID_STATUSES = ['safe', 'help', 'idle', 'moving'];

    if (!userId) {
      return res.status(400).json({ error: '`userId` is required' });
    }
    if (!status || !VALID_STATUSES.includes(status)) {
      return res.status(400).json({
        error: `\`status\` must be one of: ${VALID_STATUSES.join(', ')}`,
      });
    }

    // Build update — include node if provided (needed for map animation)
    const update = { status };
    if (node !== undefined) update.node = node;

    const user = await User.findByIdAndUpdate(
      userId,
      update,
      { new: true, runValidators: true }
    ).lean();

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    await Log.create({
      message: `User ${user.name} status → "${status}"${node ? ` at node ${node}` : ''}`,
    });

    res.json({ user });
  } catch (err) {
    next(err);
  }
});

// POST /api/log  — used by frontend logAction()
router.post('/log', async (req, res, next) => {
  try {
    const { message, timestamp } = req.body;
    if (!message) return res.status(400).json({ error: '`message` is required' });
    const log = await Log.create({ message, timestamp: timestamp || new Date() });
    res.json({ success: true, log });
  } catch (err) {
    next(err);
  }
});


router.post('/logs/clear', async (req, res) => {
  await Log.deleteMany({});
  res.json({ ok: true });
});

// POST /api/clear-logs — used by Stop Simulation
router.post('/clear-logs', async (req, res, next) => {
  try {
    await Log.deleteMany({});
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/stop-simulation
router.post('/stop-simulation', async (req, res, next) => {
  try {
    await Log.deleteMany({});
    await User.updateMany({}, { $set: { status: 'idle' } });
    res.json({ success: true, message: 'Simulation stopped' });
  } catch (err) {
    next(err);
  }
});

// ── GRAPH PERSISTENCE ──

router.post('/graph', async (req, res, next) => {
  try {
    const { nodePositions, nodeAdjacency, meetingPoints } = req.body;
    if (!nodePositions || !nodeAdjacency) {
      return res.status(400).json({ error: 'Missing graph data' });
    }
    await Graph.findOneAndUpdate(
      { name: 'current' },
      { nodePositions, nodeAdjacency, meetingPoints, updatedAt: new Date() },
      { upsert: true, new: true }
    );
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.get('/graph', async (req, res, next) => {
  try {
    const graph = await Graph.findOne({ name: 'current' }).lean();
    if (!graph) return res.status(404).json({ error: 'No graph found' });
    res.json(graph);
  } catch (err) {
    next(err);
  }
});

module.exports = router;