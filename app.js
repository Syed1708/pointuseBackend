require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const connectDB = require('./config/db');
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/usersRoutes');
const roleRoutes = require('./routes/roleRoutes');

const app = express();

// Connect to MongoDB
// connectDB();


// Middleware
app.use(cors({
  origin: 'http://localhost:3000', // Adjust to match your web frontend origin later
  credentials: true
}));
app.use(express.json());
app.use(cookieParser());

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/roles', roleRoutes);

app.get('/', (req, res) => res.send('Pointuse backend API is running!'));

module.exports = app;


