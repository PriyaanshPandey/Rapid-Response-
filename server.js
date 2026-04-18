'use strict';
require('dotenv').config();

const express = require('express');
const connectDB = require('./db');

const usersRouter = require('./routes/users');
const incidentsRouter = require('./routes/incidents');
const actionsRouter = require('./routes/actions');

const app = express();
const PORT = process.env.PORT || 5000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());

// ── Database ──────────────────────────────────────────────────────────────────
// connectDB() is now called in the startServer() block below

// Allow frontend to call the API
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/ping', (_req, res) => res.send('alive'));

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api', usersRouter);
app.use('/api', incidentsRouter);
app.use('/api', actionsRouter);

app.get('/', (_req, res) => {
  res.send(`
    <html>
      <head>
        <title>RAPID RESPONSE API</title>
        <style>
          body {
            font-family: Arial;
            background: #0f172a;
            color: #e2e8f0;
            padding: 40px;
          }
          h1 { color: #38bdf8; }
          .box {
            background: #1e293b;
            padding: 20px;
            border-radius: 10px;
            margin-bottom: 20px;
          }
          code {
            color: #22c55e;
          }
        </style>
      </head>
      <body>
        <h1>🚨 RAPID RESPONSE Backend</h1>

        <div class="box">
          <h3>Status: ✅ Running</h3>
          <p>Real-time Emergency Response API</p>
        </div>

        <div class="box">
          <h3>Endpoints</h3>
          <p><code>POST /api/fire</code> → simulate fire</p>
          <p><code>GET /api/users</code></p>
          <p><code>POST /api/user-status</code></p>
          <p><code>GET /api/logs</code></p>
          <p><code>POST /api/fire-update</code></p>
        </div>

        <div class="box">
          <h3>Flow</h3>
          <p>Fire → Backend stores → Frontend computes → UI updates</p>
        </div>
      </body>
    </html>
  `);
});

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ── Global Error Handler ──────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[RAPID RESPONSE ERROR]', err);
  const status = err.status || 500;
  res.status(status).json({ error: err.message || 'Internal server error' });
});

// ── Simulation Engine ─────────────────────────────────────────────────────────
const User = require('./models/User');
const Incident = require('./models/Incident');
const Graph = require('./models/Graph');
const Log = require('./models/Log');

async function calculatePath(start, end, blockedNodes, adjacency) {
  if (!start || !end || !adjacency) return null;
  if (start === end) return [start];
  const queue = [[start]];
  const visited = new Set([start]);
  const blocked = new Set(blockedNodes || []);

  let iterations = 0;
  const MAX_ITERATIONS = 1000;

  while (queue.length > 0 && iterations < MAX_ITERATIONS) {
    iterations++;
    const path = queue.shift();
    const node = path[path.length - 1];
    const neighbors = adjacency[node] || [];

    for (const neighbor of neighbors) {
      if (!visited.has(neighbor) && !blocked.has(neighbor)) {
        if (neighbor === end) return [...path, neighbor];
        visited.add(neighbor);
        queue.push([...path, neighbor]);
      }
    }
  }
  return null;
}

let isTicking = false;
async function runSimulationTick() {
  if (isTicking) return; // Prevent overlapping ticks
  isTicking = true;
  try {
    const incident = await Incident.findOne({ status: 'active' }).lean();
    if (!incident || !incident.simulationRunning) return;

    const graph = await Graph.findOne({ name: 'current' }).lean();
    if (!graph) return;

    const users = await User.find({ 
      status: { $in: ['moving', 'help', 'idle'] },
      type: { $in: ['guest', 'staff'] }
    });
    if (users.length === 0) return;

    const updates = users.map(async (user) => {
      let target = null;
      if (user.type === 'staff') {
        if (user.role === 'rescue') {
          // Rescue staff target: nearest assigned guest requiring rescue
          const myGuest = await User.findOne({ assignedTo: user._id, status: 'help' });
          if (myGuest) {
            if (myGuest.node === user.node) {
              // 🚨 PICKUP: Guest is now moving
              myGuest.status = 'moving';
              await myGuest.save();
              await Log.create({ message: `✅ Rescue Leader picked up ${myGuest.name} at Node ${user.node}` });
              target = incident.meetingPoint;
            } else {
              target = myGuest.node;
            }
          } else {
            target = incident.meetingPoint;
          }
        } else {
          // Evacuation staff target: assigned moving guest or meeting point
          const myEvacGuest = await User.findOne({ assignedTo: user._id, status: 'moving' });
          target = myEvacGuest ? incident.meetingPoint : incident.meetingPoint;
        }
      } else {
        // Guest target: only move if NOT stuck waiting for help
        if (user.status === 'help') return; 
        target = incident.meetingPoint;
      }

      if (!target || user.node === target) {
        if (user.type === 'guest' && user.node === incident.meetingPoint) {
          user.status = 'safe';
          await user.save();
        }
        return;
      }

      const path = await calculatePath(user.node, target, incident.blockedNodes, graph.nodeAdjacency);
      if (path && path.length > 1) {
        user.node = path[1]; 
        user.status = 'moving';
        await user.save();
      }
    });

    await Promise.allSettled(updates);
  } catch (err) {
    console.error('[SIMULATION HEARTBEAT ERROR]', err);
  } finally {
    isTicking = false;
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────
const startServer = async () => {
  try {
    await connectDB();
    const port = process.env.PORT || PORT;
    app.listen(port, () => {
      console.log(`[RAPID RESPONSE] Server running on port ${port}`);
      
      // Start Simulation Heartbeat (Tick every 2.5s)
      setInterval(runSimulationTick, 2500);
    });
  } catch (err) {
    console.error('[RAPID RESPONSE STARTUP ERROR]', err);
    process.exit(1);
  }
};

startServer();

module.exports = app;