const errorHandler = (err, req, res, next) => {
  console.error('❌ Server Error:', err.stack || err.message);

  if (err.name === 'CastError') {
    return res.status(400).json({ message: 'Resource not found', error: err.message });
  }

  if (err.code === 11000) {
    const field = Object.keys(err.keyValue)[0];
    return res.status(400).json({ message: `This ${field} is already registered.` });
  }

  res.status(err.status || 500).json({
    message: err.message || 'Internal Server Error',
    error: process.env.NODE_ENV === 'production' ? null : err.message
  });
};

module.exports = errorHandler;