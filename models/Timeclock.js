
const mongoose = require('mongoose');

const timeclockSchema = new mongoose.Schema({
  employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  date: { type: String, required: true },            // Format: "YYYY-MM-DD"
  checkIn: { type: Date, default: null },            // Made optional to support Repos/Conge
  checkOut: { type: Date, default: null },
  totalMinutes: { type: Number, default: 0 },
  isApproved: { type: Boolean, default: false },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  // 🛑 NEW FIELDS FOR PLANNING ALIGNMENT [2]:
  breakMinutes: { type: Number, default: 0 },
  shiftType: { 
    type: String, 
    enum: ['midi', 'soir', 'double', 'repos', 'conge'], 
    default: 'midi' 
  }
}, { timestamps: true });

module.exports = mongoose.model('Timeclock', timeclockSchema);