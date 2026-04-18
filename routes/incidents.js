'use strict';

const { Router } = require('express');
const User = require('../models/User');
const Incident = require('../models/Incident');
const Message = require('../models/Message');
const Log = require('../models/Log');
const ai = require('../services/ai');
const whatsapp = require('../services/whatsapp');

const router = Router();

// POST /api/fire — trigger fire incident, notify all users
router.post('/fire', async (req, res, next) => {
  try {
    const { node } = req.body;

    if (!node) {
      return res.status(400).json({ error: '`node` is required' });
    }

    // 1. Create incident
    const incident = await Incident.create({
      type: 'fire',
      node,
      blockedNodes: [node],
      status: 'active',
      simulationRunning: true,
      meetingPoint: req.body.meetingPoint || null
    });

    // 2. Log the event
    await Log.create({ message: `Fire detected at node ${node}` });

    // 3. Fetch all users
    const users = await User.find().lean();

    // 4. Notify each user: AI stub → WhatsApp stub → save Message
    const notifications = users.map(async (user) => {
      try {
        await ai.analyze({ user, incident });
        await whatsapp.send({ user, incident });

        await Message.create({
          userId: user._id,
          status: 'sent',
          response: null,
        });
      } catch (notifyErr) {
        // Per-user failure must not abort the whole request
        console.error(`[RAPID RESPONSE] Notification failed for user ${user._id}:`, notifyErr.message);
      }
    });

    await Promise.allSettled(notifications);

    res.status(201).json({ incident });
  } catch (err) {
    next(err);
  }
});

// GET /api/fire — return active incident state
router.get('/fire', async (req, res, next) => {
  try {
    const incident = await Incident.findOne({ status: 'active' }).lean();
    res.json(incident || { status: 'none', simulationRunning: false });
  } catch (err) {
    next(err);
  }
});

// GET /api/logs — return all logs sorted by timestamp ascending
router.get('/logs', async (_req, res, next) => {
  try {
    const logs = await Log.find().sort({ timestamp: 1 }).lean();
    res.json(logs);
  } catch (err) {
    next(err);
  }
});

// POST /api/fire-update — update blockedNodes on active incident
router.post('/fire-update', async (req, res, next) => {
  try {
    const { blockedNodes } = req.body;

    if (!Array.isArray(blockedNodes) || blockedNodes.length === 0) {
      return res.status(400).json({ error: '`blockedNodes` must be a non-empty array' });
    }

    const incident = await Incident.findOneAndUpdate(
      { status: 'active' },
      { 
        $set: {
          blockedNodes: req.body.blockedNodes,
          simulationRunning: req.body.simulationRunning,
          meetingPoint: req.body.meetingPoint
        }
      },
      { new: true }
    );

    if (!incident) {
      return res.status(404).json({ error: 'No active incident found' });
    }

    await Log.create({ message: 'Fire spread updated' });

    res.json({ incident });
  } catch (err) {
    next(err);
  }
});

module.exports = router;