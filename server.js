require('dotenv').config();


const connectDB  = require('./config/db');
const app = require('./app');

// Connect to MongoDB
// connectDB();

const PORT = process.env.PORT || 5001;

connectDB().then(() => {
    app.listen(PORT, () => console.log(`✅ Server running on port http://localhost:${PORT}`));
    
  })
  .catch((err) => {
    console.error('❌ Failed to start server:', err);
    process.exit(1);
  }); 



