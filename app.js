require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const connectDB = require('./config/db');
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/usersRoutes');
const roleRoutes = require('./routes/roleRoutes');
const employeeRoutes = require('./routes/employeeRoutes');
const scheduleRoutes = require('./routes/scheduleRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes'); 
const notificationRoutes = require('./routes/notificationRoutes'); 
const errorHandler = require('./middleware/errorHandler');
const path = require('path'); 

// 1. IMPORT NATIVE HTTP & SOCKET.IO
const http = require('http');
const { Server } = require('socket.io');

const app = express();

// 2. CREATE THE HTTP SERVER (Wraps Express)
const server = http.createServer(app);

// 3. INITIALIZE SOCKET.IO WITH CORS [2]
const io = new Server(server, {
  cors: {
    origin: 'http://localhost:5173', // Your Vite React Frontend URL [3]
    credentials: true
  }
});

// 🛑 UPDATE A: CREATE THE IN-MEMORY USER SOCKET MAP [2]
// This is the registry map that links MongoDB User IDs with Socket IDs [2]
const userSockets = new Map();

// Save both "io" and "userSockets" on the Express app [2]
// This makes them accessible inside all your route files (like scheduleRoutes.js) [2]
app.set('io', io);
app.set('userSockets', userSockets); // 🛑 Saved here!

// Serves files inside the "uploads" folder on the route "/uploads"
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Middleware
app.use(cors({
  origin: 'http://localhost:5173', 
  credentials: true
}));
app.use(express.json());
app.use(cookieParser());

// Root test route
app.get('/', (req, res) => {
  res.send('Pointuse backend API is running!');
});

// Routes
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/roles', roleRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/schedules', scheduleRoutes);
app.use('/api/notifications', notificationRoutes);

// 5. LISTEN FOR SOCKET CONNECTIONS
io.on('connection', (socket) => {
  console.log(`🔌 Real-time client connected: ${socket.id}`);
  
  // 🛑 UPDATE B: LISTEN FOR REGISTER USER EVENTS [2]
  // The client will send their User ID immediately upon connecting
  socket.on('register_user', (userId) => {
    if (userId) {
      userSockets.set(userId.toString(), socket.id); // Save the association [2]
      console.log(`👤 User [${userId}] registered to Socket [${socket.id}]`);
    }
  });

  // 🛑 UPDATE C: CLEAN UP ON DISCONNECT [2]
  // Removes the user from the registry map when they close their browser or log out [2]
  socket.on('disconnect', () => {
    for (const [userId, socketId] of userSockets.entries()) {
      if (socketId === socket.id) {
        userSockets.delete(userId); // Removes association [2]
        console.log(`👤 User [${userId}] unregistered (disconnected).`);
        break;
      }
    }
    console.log('🔌 Client disconnected.');
  });
});

// Error handling middleware (Must be last)
app.use(errorHandler);

// 🛑 6. EXPORT THE WRAPPED SERVER INSTEAD OF "app" [1]
module.exports = server;