
const mongoose = require('mongoose');

const leaveRequestSchema = new mongoose.Schema({
  employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  startDate: { type: String, required: true },       // Format: "YYYY-MM-DD"
  endDate: { type: String, required: true },         // Format: "YYYY-MM-DD"
  leaveHours: { type: Number, default: 7 },          // Automatically calculated on the backend! [2]
  reason: { type: String, required: true },          // Dropdown value (e.g. "vacances", "maladie")
  
  // 🛑 ADD THIS FIELD:
  note: { type: String, default: '' },               // Optional note details [2]
  
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
}, { timestamps: true });

module.exports = mongoose.model('LeaveRequest', leaveRequestSchema);