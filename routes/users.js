'use strict';

const { Router } = require('express');
const User = require('../models/User');
const Log  = require('../models/Log');

const router = Router();

// GET /api/users — return all users
router.get('/users', async (_req, res, next) => {
  try {
    const users = await User.find().lean();
    res.json(users);
  } catch (err) {
    next(err);
  }
});

// POST /api/users — create a new user (guest or staff)
router.post('/users', async (req, res, next) => {
  try {
    const { name, phone, type, role, node, status, assignedTo } = req.body;

    if (!name || !phone || !type) {
      return res.status(400).json({ error: '`name`, `phone`, and `type` are required' });
    }

    const user = await User.create({ name, phone, type, role, node, status, assignedTo });
    await Log.create({ message: `New ${type} registered: ${name}` });

    res.status(201).json({ user });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/users/:id — remove a user
router.delete('/users/:id', async (req, res, next) => {
  try {
    const user = await User.findByIdAndDelete(req.params.id).lean();
    if (!user) return res.status(404).json({ error: 'User not found' });

    await Log.create({ message: `User removed: ${user.name}` });
    res.json({ message: 'User deleted', user });
  } catch (err) {
    next(err);
  }
});

module.exports = router;