const mongoose = require('mongoose');

const shiftPartSchema = new mongoose.Schema({
  startTime: { type: String, required: true },       // e.g. "10:00"
  endTime: { type: String, required: true },         // e.g. "14:50"
  breakMinutes: { type: Number, default: 0 },         // e.g. 20
  task: { type: String, default: 'General' }         // e.g. "Decoupe Poisson" or "Maki"
});

const dayScheduleSchema = new mongoose.Schema({
  isOff: { type: Boolean, default: false },          // "Repos" / Day Off
  isLeave: { type: Boolean, default: false },        // "Congé" / Leave
  leaveHours: { type: Number, default: 0 },          // e.g. 7 hours
  shifts: [shiftPartSchema]                          // Allows multiple (split) shifts per day
});

const weeklyScheduleSchema = new mongoose.Schema({
  employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  weekStartDate: { type: String, required: true },
  
  status: { type: String, enum: ['draft', 'published'], default: 'draft' },
  days: {
    monday: { type: dayScheduleSchema, default: () => ({ isOff: true }) },
    tuesday: { type: dayScheduleSchema, default: () => ({ isOff: true }) },
    wednesday: { type: dayScheduleSchema, default: () => ({ isOff: true }) },
    thursday: { type: dayScheduleSchema, default: () => ({ isOff: true }) },
    friday: { type: dayScheduleSchema, default: () => ({ isOff: true }) },
    saturday: { type: dayScheduleSchema, default: () => ({ isOff: true }) },
    sunday: { type: dayScheduleSchema, default: () => ({ isOff: true }) },
  },
  totalHours: { type: Number, default: 0 }           // Auto-computed scheduled hours for the week
}, { timestamps: true });

// Compound index to ensure an employee only has one schedule document per week
weeklyScheduleSchema.index({ employee: 1, weekStartDate: 1 }, { unique: true });

module.exports = mongoose.model('WeeklySchedule', weeklyScheduleSchema);