require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const connectDB = require('./config/db');
const path = require('path');

const http = require('http');
const { Server } = require('socket.io');

// routes
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/usersRoutes');
const roleRoutes = require('./routes/roleRoutes');
const employeeRoutes = require('./routes/employeeRoutes');
const scheduleRoutes = require('./routes/scheduleRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const timeclockRoutes = require('./routes/timeclockRoutes');
const leaveRoutes = require('./routes/leaveRoutes');
const errorHandler = require('./middleware/errorHandler');

const app = express();
const server = http.createServer(app);

/* =========================
   ✅ SAFE CORS CONFIG
========================= */

const allowedOrigins = [
  'http://localhost:5173',
  process.env.CLIENT_URL
];

const corsOptions = {
  origin: function (origin, callback) {
    // allow server-to-server or postman
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    // ❌ NEVER throw error (prevents crash)
    return callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
};

app.use(cors(corsOptions));
// app.options('/*', cors(corsOptions));

app.use(express.json());
app.use(cookieParser());

/* =========================
   SOCKET.IO (SAFE CORS)
========================= */

// const io = new Server(server, {
//   cors: corsOptions
// });

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    credentials: true
  }
});

const userSockets = new Map();

app.set('io', io);
app.set('userSockets', userSockets);

/* =========================
   STATIC FILES
========================= */

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

/* =========================
   ROUTES
========================= */

app.get('/', (req, res) => {
  res.send('Pointuse backend API is running!');
});

app.use('/api/dashboard', dashboardRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/roles', roleRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/schedules', scheduleRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/timeclock', timeclockRoutes);
app.use('/api/leaves', leaveRoutes);
app.use('/api/swaps', require('./routes/swapRoutes')); 
app.use('/api/settings', require('./routes/settingsRoutes'));
/* =========================
   SOCKET EVENTS
========================= */

io.on('connection', (socket) => {
  console.log(`🔌 Connected: ${socket.id}`);

  socket.on('register_user', (userId) => {
    if (userId) {
      userSockets.set(userId.toString(), socket.id);
    }
  });

  socket.on('disconnect', () => {
    for (const [userId, socketId] of userSockets.entries()) {
      if (socketId === socket.id) {
        userSockets.delete(userId);
        break;
      }
    }
  });
});

/* =========================
   ERROR HANDLER
========================= */

app.use(errorHandler);

module.exports = server;