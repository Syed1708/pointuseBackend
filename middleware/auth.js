const jwt = require('jsonwebtoken');
const User = require('../models/User');

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // "Bearer TOKEN"

  if (!token) {
    return res.status(401).json({ message: 'Access token required' });
  }

  jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, decodedUser) => {
    if (err) {
      return res.status(403).json({ message: 'Token is invalid or expired' });
    }
    req.user = decodedUser; // Contains id and role
    next();
  });
};

const requireRole = (allowedRoles) => {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ message: 'Access denied: Insufficient permissions' });
    }
    next();
  };

  
};


// Check permissions dynamically from the database
const requirePermission = (requiredPermission) => {

  return async (req, res, next) => {
    try {
      // Find user and populate their assigned role document
      const user = await User.findById(req.user.id).populate('role');
      
      if (!user || !user.role) {
        return res.status(403).json({ message: 'Access denied: User has no valid role' });
      }

      // Special case: "admin" role always has full bypass access
      if (user.role.name === 'admin') {
        return next();
      }

      // Check if current role has the requested privilege
      const hasPrivilege = user.role.permissions.includes(requiredPermission);
      if (!hasPrivilege) {
        return res.status(403).json({ 
          message: `Access denied: You do not have permission to ${requiredPermission.replace(':', ' ')}` 
        });
      }

      next();
    } catch (err) {
      res.status(500).json({ message: 'Authorization error', error: err.message });
    }
  };
};

module.exports = { authenticateToken, requireRole, requirePermission };