// backend/middleware/rateLimiter.js
const rateLimit = require('express-rate-limit');

// Protects the shared public terminal against PIN brute-forcing [1.1.2]
const pinVerifyLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes window [1.1.2]
  max: 5, // Limit each IP address to 5 requests per windowMs [1.1.2]
  
  // Custom JSON response returned when the limit is exceeded [1.1.2]
  message: {
    message: 'Trop de tentatives de code PIN. Veuillez réessayer dans 5 minutes.'
  },
  
  standardHeaders: true, // Returns rate limit info in the standard `RateLimit-*` headers
  legacyHeaders: false, // Disables legacy `X-RateLimit-*` headers
});

module.exports = { pinVerifyLimiter };