const mongoose = require('mongoose');

const timeclockSchema = new mongoose.Schema({
  employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  date: { type: String, required: true },            // Format: "YYYY-MM-DD"
  checkIn: { type: Date, default: null },
  
  // 🛑 NEW BREAK TRACKING WORKFLOW FIELDS:
  breakStart: { type: Date, default: null },         // Timestamp of starting break
  breakEnd: { type: Date, default: null },           // Timestamp of ending break
  actualBreakMinutes: { type: Number, default: 0 },  // Calculated as: breakEnd - breakStart
  
  checkOut: { type: Date, default: null },
  totalMinutes: { type: Number, default: 0 },        // Auto-calculated: (checkOut - checkIn) - actualBreakMinutes
  isApproved: { type: Boolean, default: false },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  breakMinutes: { type: Number, default: 0 },        // Scheduled break from timesheet edit
  shiftType: { 
    type: String, 
    enum: ['midi', 'soir', 'double', 'repos', 'conge'], 
    default: 'midi' 
  }
}, { timestamps: true });

module.exports = mongoose.model('Timeclock', timeclockSchema);