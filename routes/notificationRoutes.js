const express = require('express');
const router = express.Router();
const Notification = require('../models/Notification');
const { authenticateToken } = require('../middleware/auth');
const asyncHandler = require('../helpers/asyncHandler');

// 1. GET USER NOTIFICATIONS (Fetch last 10 sorted by newest) [2]
router.get('/', authenticateToken, asyncHandler(async (req, res) => {
  const notifications = await Notification.find({ recipient: req.user.id })
    .sort({ createdAt: -1 })
    .limit(10);
  res.json(notifications);
}));

// 2. MARK SPECIFIC NOTIFICATION AS READ [2]
router.put('/:id/read', authenticateToken, asyncHandler(async (req, res) => {
  const notification = await Notification.findOneAndUpdate(
    { _id: req.params.id, recipient: req.user.id },
    { isRead: true },
    { returnDocument: 'after' }
  );
  if (!notification) return res.status(404).json({ message: 'Notification not found.' });
  res.json(notification);
}));

// 3. MARK ALL AS READ [2]
router.put('/read-all', authenticateToken, asyncHandler(async (req, res) => {
  await Notification.updateMany({ recipient: req.user.id }, { isRead: true });
  res.json({ message: 'All notifications marked as read.' });
}));

module.exports = router;