require('dotenv').config();

const connectDB = require('./config/db');
// 🛑 1. Import the wrapped "server" from app.js instead of the raw "app"
const server = require('./app'); 

const PORT = process.env.PORT || 5001;

// Connect to MongoDB first, then boot the server [1]
connectDB().then(() => {
    // 🛑 2. Listen to the wrapped "server" object (which hosts Socket.io) [1]
    server.listen(PORT, () => console.log(`✅ Server running on port http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error('❌ Failed to start server:', err);
    process.exit(1);
  });