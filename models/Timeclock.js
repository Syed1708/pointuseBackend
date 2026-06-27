const mongoose = require('mongoose');

const timeclockSchema = new mongoose.Schema({
  employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  date: { type: String, required: true },            // Format: "YYYY-MM-DD"
  checkIn: { type: Date, required: true },
  checkOut: { type: Date, default: null },
  totalMinutes: { type: Number, default: 0 }          // Calculated upon checkout
}, { timestamps: true });

module.exports = mongoose.model('Timeclock', timeclockSchema);