const express = require('express');
const router = express.Router();
const mongoose = require('mongoose'); // 🛑 Import mongoose for transaction sessions [2]

const { generateSchedulePDF, getWeekNumber, getWeekRangeString, generatePersonalPDF } = require('../helpers/pdfGenerator'); 
const WeeklySchedule = require('../models/WeeklySchedule');
const User = require('../models/User');
const Role = require('../models/Role');
const Notification = require('../models/Notification');
const nodemailer = require('nodemailer');
const { authenticateToken, requirePermission } = require('../middleware/auth');
const asyncHandler = require('../helpers/asyncHandler'); 

// 🛑 Centralized Date Helpers (Local duplicate functions removed) [3]
const { getMonday, getWeekdayKey } = require('../utils/dateHelper');

// Helper: Calculate scheduled hours for a single day
const calculateDayHours = (day) => {
  if (day.isOff) return 0;
  if (day.isLeave) return day.leaveHours || 0;
  
  let totalMinutes = 0;
  day.shifts.forEach(shift => {
    const [startH, startM] = shift.startTime.split(':').map(Number);
    const [endH, endM] = shift.endTime.split(':').map(Number);
    
    let diffMinutes = (endH * 60 + endM) - (startH * 60 + startM);
    if (diffMinutes < 0) diffMinutes += 24 * 60; // Handle shifts crossing midnight
    
    totalMinutes += (diffMinutes - (shift.breakMinutes || 0));
  });
  
  return parseFloat((totalMinutes / 60).toFixed(2));
};

// Helper: Calculate total weekly hours across all days
const calculateWeeklyHours = (days) => {
  const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  return weekdays.reduce((sum, day) => sum + calculateDayHours(days[day]), 0);
};

// ==========================================
// 1. GET WEEKLY GRID (For Managers/Admins)
// ==========================================
router.get('/grid', authenticateToken, requirePermission('schedules:view'), asyncHandler(async (req, res) => {
  const { weekStartDate } = req.query; // Expects "YYYY-MM-DD" representing a Monday
  if (!weekStartDate) return res.status(400).json({ message: 'weekStartDate parameter is required' });

  // Fetch all active employees
  const employeeRole = await Role.findOne({ name: 'employee' });
  const employees = await User.find({ role: employeeRole._id }).select('name email contractHours');

  const grid = [];
  for (const emp of employees) {
    let schedule = await WeeklySchedule.findOne({ employee: emp._id, weekStartDate: weekStartDate });
    
    // If no schedule exists yet, return a default template
    if (!schedule) {
      schedule = {
        employee: emp,
        weekStartDate: weekStartDate,
        status: 'draft',
        days: {
          monday: { isOff: true, shifts: [] },
          tuesday: { isOff: true, shifts: [] },
          wednesday: { isOff: true, shifts: [] },
          thursday: { isOff: true, shifts: [] },
          friday: { isOff: true, shifts: [] },
          saturday: { isOff: true, shifts: [] },
          sunday: { isOff: true, shifts: [] },
        },
        totalHours: 0
      };
    }
    grid.push({ employee: emp, schedule });
  }

  res.json(grid);
}));

// ==========================================
// 2. CREATE / UPDATE WEEKLY SCHEDULE (Chef/Manager/Admin)
// ==========================================
router.post('/save', authenticateToken, requirePermission('schedules:create'), asyncHandler(async (req, res) => {
  const { employeeId, weekStartDate, days } = req.body;

  const totalHours = calculateWeeklyHours(days);

  const schedule = await WeeklySchedule.findOneAndUpdate(
    { employee: employeeId, weekStartDate: weekStartDate },
    { employee: employeeId, weekStartDate: weekStartDate, days, totalHours },
    { returnDocument: 'after', upsert: true } // Resolved deprecation warning [1]
  );

  req.app.get('io').emit('schedule_updated'); // 🔌 Broadcast updates
  
  res.json({ message: 'Schedule saved successfully', schedule });
}));

// ==========================================
// 3. CLONE WEEK SCHEDULE (With ACID Transaction Protection) [2]
// ==========================================
router.post('/clone', authenticateToken, requirePermission('schedules:create'), asyncHandler(async (req, res) => {
  const { sourceWeekStart, targetWeekStart } = req.body;
  console.log(`Cloning schedules from ${sourceWeekStart} to ${targetWeekStart}`);

  const sourceSchedules = await WeeklySchedule.find({ weekStartDate: sourceWeekStart });
  if (sourceSchedules.length === 0) {
    return res.status(404).json({ message: 'No schedules found in the source week to clone.' });
  }

  // 🛑 START TRANSACTION SESSION FOR BULK CLONING [2]
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    for (const source of sourceSchedules) {
      await WeeklySchedule.findOneAndUpdate(
        { employee: source.employee, weekStartDate: targetWeekStart },
        { 
          employee: source.employee, 
          weekStartDate: targetWeekStart, 
          days: source.days, 
          status: 'draft', // Cloned schedules start as drafts
          totalHours: source.totalHours 
        },
        { returnDocument: 'after', upsert: true, session } // Passed active session [1, 2]
      );
    }

    // 🏆 Commit transaction on success [2]
    await session.commitTransaction();
    session.endSession();

    req.app.get('io').emit('schedule_updated'); // 🔌 Broadcast

    res.json({ message: 'Week successfully cloned as draft.' });
  } catch (error) {
    // 🛑 Abort transaction if any single clone fails to keep DB clean [2]
    await session.abortTransaction();
    session.endSession();
    throw error;
  }
}));

// ==========================================
// 4. PUBLISH SCHEDULE & EMAIL PDF ATTACHMENT (With ACID Transaction Protection) [2]
// ==========================================
router.post('/publish', authenticateToken, requirePermission('schedules:publish'), asyncHandler(async (req, res) => {
  const { weekStartDate } = req.body;
  const targetDate = new Date(weekStartDate);

  // 🛑 START TRANSACTION SESSION FOR BULK PUBLISHING [2]
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // 1. Update statuses inside the session [2]
    const result = await WeeklySchedule.updateMany(
      { weekStartDate: weekStartDate }, 
      { status: 'published' }
    ).session(session);

    if (result.matchedCount === 0) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: 'No schedules found to publish.' });
    }

    const employeeRole = await Role.findOne({ name: 'employee' }).session(session);
    const employees = await User.find({ role: employeeRole._id }).session(session);
    const schedules = await WeeklySchedule.find({ weekStartDate: weekStartDate }).populate('employee').session(session);

    const defaultDays = {
      monday: { isOff: true, shifts: [] }, tuesday: { isOff: true, shifts: [] }, wednesday: { isOff: true, shifts: [] },
      thursday: { isOff: true, shifts: [] }, friday: { isOff: true, shifts: [] }, saturday: { isOff: true, shifts: [] },
      sunday: { isOff: true, shifts: [] }
    };

    const gridData = employees.map(emp => {
      const sched = schedules.find(s => s.employee._id.toString() === emp._id.toString());
      return { employee: emp, schedule: sched || { days: defaultDays } };
    });

    const pdfBuffer = await generateSchedulePDF(gridData, weekStartDate);
    const weekNo = getWeekNumber(targetDate);

    // 2. Save Notifications inside the session [2]
    const userSockets = req.app.get('userSockets');
    const io = req.app.get('io');

    for (const emp of employees) {
      const notification = new Notification({
        recipient: emp._id,
        title: '📅 New Schedule Published!',
        message: `Your work schedule for the week starting on ${weekStartDate} is now active.`,
        type: 'schedule',
        link: '/dashboard/planning'
      });
      await notification.save({ session }); // Saved under transaction lock! [2]
    }

    // 🏆 COMMIT TRANSACTION [2]
    await session.commitTransaction();
    session.endSession();

    // 3. Emit real-time broadcasts now that database has successfully finalized [2]
    io.emit('schedule_published', { weekStartDate });

    for (const emp of employees) {
      const socketId = userSockets.get(emp._id.toString());
      if (socketId) {
        const latestNotif = await Notification.findOne({ recipient: emp._id }).sort({ createdAt: -1 });
        io.to(socketId).emit('notification_received', latestNotif);
      }
    }

    // 4. Configure and send email alerts
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: employees.map(e => e.email).filter(Boolean).join(','),
      subject: `[Pointuse] Votre Planning - Semaine de ${weekNo}`,
      text: `Bonjour, veuillez trouver ci-joint le planning validé pour la Semaine de ${weekNo}.`,
      attachments: [
        { filename: `Planning_Semaine_${weekNo}.pdf`, content: pdfBuffer, contentType: 'application/pdf' }
      ]
    };

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
    });

    await transporter.sendMail(mailOptions);

    res.json({ message: 'Schedules published and PDF emailed successfully.' });

  } catch (error) {
    // 🛑 Abort transaction on failure to keep DB in a safe state [2]
    await session.abortTransaction();
    session.endSession();
    throw error;
  }
}));

// ==========================================
// 6. DOWNLOAD DIRECT PLANNING PDF
// ==========================================
router.get('/download-pdf', authenticateToken, requirePermission('schedules:view'), asyncHandler(async (req, res) => {
  const { weekStartDate } = req.query;
  if (!weekStartDate) return res.status(400).json({ message: 'weekStartDate parameter is required' });

  const targetDate = new Date(weekStartDate);

  // Fetch active grid
  const employeeRole = await Role.findOne({ name: 'employee' });
  const employees = await User.find({ role: employeeRole._id });
  const schedules = await WeeklySchedule.find({ weekStartDate: weekStartDate }).populate('employee');

  const defaultDays = {
    monday: { isOff: true, shifts: [] }, tuesday: { isOff: true, shifts: [] }, wednesday: { isOff: true, shifts: [] },
    thursday: { isOff: true, shifts: [] }, friday: { isOff: true, shifts: [] }, saturday: { isOff: true, shifts: [] },
    sunday: { isOff: true, shifts: [] }
  };
  const gridData = employees.map(emp => {
    const sched = schedules.find(s => s.employee._id.toString() === emp._id.toString());
    return { employee: emp, schedule: sched || { days: defaultDays } };
  });

  // Generate and Stream PDF directly to HTTP Client response
  const pdfBuffer = await generateSchedulePDF(gridData, weekStartDate);
  const weekNo = getWeekNumber(targetDate);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename=Planning_Semaine_${weekNo}.pdf`);
  res.send(pdfBuffer);
}));

// ==========================================
// 7. DOWNLOAD PERSONAL SCHEDULE PDF (Employee Only)
// ==========================================
router.get('/my-schedule-pdf', authenticateToken, asyncHandler(async (req, res) => {
  const { weekStartDate } = req.query; 
  if (!weekStartDate) return res.status(400).json({ message: 'weekStartDate parameter is required' });

  const schedule = await WeeklySchedule.findOne({
    employee: req.user.id,
    weekStartDate: weekStartDate,
    status: 'published'
  }).populate('employee', 'name email');

  if (!schedule) {
    return res.status(404).json({ message: 'No published schedule found for this week.' });
  }

  const pdfBuffer = await generatePersonalPDF(schedule, weekStartDate);
  const weekNo = getWeekNumber(new Date(weekStartDate));

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename=My_Planning_Semaine_${weekNo}.pdf`);
  res.send(pdfBuffer);
}));

// ==========================================
// 5. GET EMPLOYEE OWN PUBLISHED SCHEDULE (Employee Only) [2]
// ==========================================
router.get('/my-schedule', authenticateToken, asyncHandler(async (req, res) => {
  const { weekStartDate, employeeId  } = req.query;
  if (!weekStartDate) {
    return res.status(400).json({ message: 'weekStartDate parameter is required' });
  }

  const targetEmployeeId = employeeId || req.user.id;

  const schedule = await WeeklySchedule.findOne({
    employee: targetEmployeeId, 
    weekStartDate: weekStartDate,
    status: 'published'
  }).populate('employee', 'name email');

  res.json(schedule); 
}));

module.exports = router;