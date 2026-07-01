const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Role = require('../models/Role');
const WeeklySchedule = require('../models/WeeklySchedule');
const Timeclock = require('../models/Timeclock');
const { authenticateToken } = require('../middleware/auth');
const asyncHandler = require('../helpers/asyncHandler');

const getMonday = (d) => {
  const date = new Date(d);
  const day = date.getDay();
  const diff = date.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(date.setDate(diff)).toISOString().split('T')[0];
};

// ==========================================
// GET LIVE DASHBOARD STATISTICS & REPORTS (With 7-Day Activity Matrix) [2]
// ==========================================
router.get('/stats', authenticateToken, asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id).populate('role');
  const isManagerOrAdmin = ['admin', 'manager'].includes(user?.role?.name);

  const today = new Date();
  const currentWeekStart = getMonday(today);

  // ------------------------------------------
  // CASE A: STATS & REPORT FOR MANAGERS & ADMINS [2]
  // ------------------------------------------
  if (isManagerOrAdmin) {
    const employeeRole = await Role.findOne({ name: 'employee' });
    const employees = await User.find({ role: employeeRole._id }).select('name avatar contractHours');

    const totalEmployees = employees.length;
    const unapprovedTimesheets = await Timeclock.countDocuments({ checkOut: null });

    const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const todayName = weekdays[today.getDay()];

    const weeklySchedules = await WeeklySchedule.find({ weekStartDate: currentWeekStart });
    let activeShiftsToday = 0;
    
    weeklySchedules.forEach((schedule) => {
      const dayData = schedule.days[todayName];
      if (dayData && !dayData.isOff && !dayData.isLeave && dayData.shifts?.length > 0) {
        activeShiftsToday++;
      }
    });

    const weeklyReportList = [];
    const todayStr = today.toLocaleDateString('fr-CA');

    for (const emp of employees) {
      const timeclocks = await Timeclock.find({
        employee: emp._id,
        date: { $gte: currentWeekStart }
      });

      const todaysPunch = await Timeclock.findOne({ employee: emp._id, date: todayStr });

      let totalWorkedMinutes = 0;
      timeclocks.forEach(tc => {
        if (tc.checkOut) {
          totalWorkedMinutes += (tc.totalMinutes || 0);
        } else {
          const diffMs = new Date() - new Date(tc.checkIn);
          totalWorkedMinutes += Math.max(0, Math.floor(diffMs / 60000));
        }
      });

      const actualHours = parseFloat((totalWorkedMinutes / 60).toFixed(2));
      const contractHours = emp.contractHours || 35;
      const extraHours = actualHours > contractHours ? parseFloat((actualHours - contractHours).toFixed(2)) : 0;

      weeklyReportList.push({
        id: emp._id,
        name: emp.name,
        avatar: emp.avatar,
        contractHours,
        actualHours,
        extraHours,
        isCurrentlyClockedIn: todaysPunch && !todaysPunch.checkOut,
        todayPunch: todaysPunch ? {
          checkIn: todaysPunch.checkIn ? new Date(todaysPunch.checkIn).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : null,
          checkOut: todaysPunch.checkOut ? new Date(todaysPunch.checkOut).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : null
        } : null
      });
    }

    return res.json({
      totalEmployees,
      activeShiftsToday,
      unapprovedTimesheets,
      weeklyReportList
    });
  }

  // ------------------------------------------
  // CASE B: STATS & REPORT FOR REGULAR EMPLOYEES [2]
  // ------------------------------------------
  else {
    const schedule = await WeeklySchedule.findOne({
      employee: user._id,
      weekStartDate: currentWeekStart,
      status: 'published'
    });

    const myScheduledHours = schedule ? schedule.totalHours : 0;

    let restDays = 0;
    if (schedule) {
      const weekdaysKeys = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
      weekdaysKeys.forEach(dayKey => {
        if (schedule.days[dayKey]?.isOff) restDays++;
      });
    } else {
      restDays = 7;
    }

    const activePunch = await Timeclock.findOne({ employee: user._id, checkOut: null });
    let runningMinutes = 0;
    let activeSession = null;

    if (activePunch) {
      const checkInTime = new Date(activePunch.checkIn);
      const diffMs = new Date() - checkInTime;
      runningMinutes = Math.floor(diffMs / 60000);

      activeSession = {
        checkInTime: checkInTime.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
        runningHours: parseFloat((runningMinutes / 60).toFixed(2))
      };
    }

    const timeclocks = await Timeclock.find({
      employee: user._id,
      date: { $gte: currentWeekStart } 
    });

    const completedMinutes = timeclocks.reduce((sum, tc) => sum + (tc.totalMinutes || 0), 0);
    const totalMinutes = completedMinutes + runningMinutes;
    const myWorkedHours = parseFloat((totalMinutes / 60).toFixed(2));

    // 🛑 UPGRADED: Build the Employee's 7-Day Activity Matrix (Schedule vs. Actual Clock-ins) [2]
    const weekdaysKeys = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    const weekdaysLabels = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

    const myDetailedWeeklyDays = weekdaysKeys.map((dayKey, idx) => {
      const date = new Date(currentWeekStart);
      date.setDate(date.getDate() + idx);
      const dateStr = date.toLocaleDateString('fr-CA'); // "YYYY-MM-DD"

      // Find the clock-in/out record for this specific day
      const punch = timeclocks.find(tc => tc.date === dateStr);
      const daySchedule = schedule?.days[dayKey] || { isOff: true, shifts: [] };

      let scheduleText = 'Repos';
      if (daySchedule.isLeave) {
        scheduleText = `Congé (${daySchedule.leaveHours}h)`;
      } else if (!daySchedule.isOff && daySchedule.shifts?.length > 0) {
        scheduleText = daySchedule.shifts.map(s => `${s.startTime}-${s.endTime}`).join(' / ');
      }

      let punchText = 'No Punch';
      let workedHours = 0;

      if (punch) {
        const inTime = new Date(punch.checkIn).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
        if (punch.checkOut) {
          const outTime = new Date(punch.checkOut).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
          punchText = `${inTime} - ${outTime}`;
          workedHours = parseFloat((punch.totalMinutes / 60).toFixed(2));
        } else {
          punchText = `${inTime} - Active`;
          // If active, calculate running hours on the fly [2]
          const runningDiffMs = new Date() - new Date(punch.checkIn);
          const runningMinutesTotal = Math.floor(runningDiffMs / 60000);
          workedHours = parseFloat((runningMinutesTotal / 60).toFixed(2));
        }
      }

      return {
        dayName: weekdaysLabels[idx],
        date: date.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }),
        scheduleText,
        punchText,
        workedHours
      };
    });

    return res.json({
      myScheduledHours,
      myWorkedHours,
      restDays,
      activeSession,
      myDetailedWeeklyDays // Sent successfully to the React frontend [2]
    });
  }
}));

module.exports = router;