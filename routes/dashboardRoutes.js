const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Role = require('../models/Role');
const WeeklySchedule = require('../models/WeeklySchedule');
const Timeclock = require('../models/Timeclock');
const { authenticateToken } = require('../middleware/auth');
const asyncHandler = require('../helpers/asyncHandler'); // 🛑 Import the centralized async wrapper [2]

// Helper: Find Monday date of current week
const getMonday = (d) => {
  const date = new Date(d);
  const day = date.getDay();
  const diff = date.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(date.setDate(diff)).toISOString().split('T')[0];
};

// ==========================================
// GET LIVE DASHBOARD STATISTICS (Clean & Compact)
// ==========================================
router.get('/stats', authenticateToken, asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id).populate('role');
  const isManagerOrAdmin = ['admin', 'manager'].includes(user?.role?.name);

  const today = new Date();
  const currentWeekStart = getMonday(today);

  // ------------------------------------------
  // CASE A: STATS FOR MANAGERS & ADMINS [2]
  // ------------------------------------------
  if (isManagerOrAdmin) {
    const employeeRole = await Role.findOne({ name: 'employee' });
    
    // 1. Total Employees Count
    const totalEmployees = await User.countDocuments({ role: employeeRole._id });

    // 2. Active Shifts Today Count
    const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const todayName = weekdays[today.getDay()]; // e.g. "saturday"

    const weeklySchedules = await WeeklySchedule.find({ weekStartDate: currentWeekStart });
    let activeShiftsToday = 0;
    
    weeklySchedules.forEach((schedule) => {
      const dayData = schedule.days[todayName];
      if (dayData && !dayData.isOff && !dayData.isLeave && dayData.shifts?.length > 0) {
        activeShiftsToday++;
      }
    });

    // 3. Unapproved/Open Timesheets (Employees currently clocked in/active)
    const unapprovedTimesheets = await Timeclock.countDocuments({ checkOut: null });

    return res.json({
      totalEmployees,
      activeShiftsToday,
      unapprovedTimesheets
    });
  }

  // ------------------------------------------
  // CASE B: STATS FOR REGULAR EMPLOYEES [2]
  // ------------------------------------------
  else {
    // 1. Fetch employee's published weekly schedule
    const schedule = await WeeklySchedule.findOne({
      employee: user._id,
      weekStartDate: currentWeekStart,
      status: 'published'
    });

    const myScheduledHours = schedule ? schedule.totalHours : 0;

    // 2. Count Rest Days (Repos) in their schedule
    let restDays = 0;
    if (schedule) {
      const weekdaysKeys = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
      weekdaysKeys.forEach(dayKey => {
        if (schedule.days[dayKey]?.isOff) restDays++;
      });
    } else {
      restDays = 7; // Default fallback if no schedule is published yet
    }

    // 3. Calculate actual worked hours from Timeclocks this week [2]
    const timeclocks = await Timeclock.find({
      employee: user._id,
      date: { $gte: currentWeekStart } // Fetches all days starting from Monday
    });

    const totalMinutes = timeclocks.reduce((sum, tc) => sum + (tc.totalMinutes || 0), 0);
    const myWorkedHours = parseFloat((totalMinutes / 60).toFixed(2));

    return res.json({
      myScheduledHours,
      myWorkedHours,
      restDays
    });
  }
}));

module.exports = router;