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

// ── Start ─────────────────────────────────────────────────────────────────────
const startServer = async () => {
  try {
    await connectDB();
    const port = process.env.PORT || PORT;
    app.listen(port, () => {
      console.log(`[RAPID RESPONSE] Server running on port ${port}`);
    });
  } catch (err) {
    console.error('[RAPID RESPONSE STARTUP ERROR]', err);
    process.exit(1);
  }
};

startServer();

module.exports = app;