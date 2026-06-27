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
const dashboardRoutes = require('./routes/dashboardRoutes'); // Import the dashboard routes
const path = require('path'); // 🛑 Import path at the top

const app = express();

// Connect to MongoDB
// connectDB();



// 🛑 ADD THIS LINE (Before your API routes):
// Serves files inside the "uploads" folder on the route "/uploads"
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Middleware
app.use(cors({
  origin: 'http://localhost:5173', // Adjust to match your web frontend origin later
  credentials: true
}));
app.use(express.json());
app.use(cookieParser());

// Routes
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/roles', roleRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/schedules', scheduleRoutes);

app.get('/', (req, res) => res.send('Pointuse backend API is running!'));

module.exports = app;


