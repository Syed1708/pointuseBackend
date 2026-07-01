const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, // Who receives it
  title: { type: String, required: true },
  message: { type: String, required: true },
  isRead: { type: Boolean, default: false },
  type: { type: String, default: 'general' },      // e.g., 'schedule', 'general'
  link: { type: String, default: null }             // Optional redirection path
}, { timestamps: true });

module.exports = mongoose.model('Notification', notificationSchema);