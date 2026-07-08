const express = require('express');
const router = express.Router();
const LeaveRequest = require('../models/LeaveRequest');
const WeeklySchedule = require('../models/WeeklySchedule');
const User = require('../models/User');
const Notification = require('../models/Notification');
const { authenticateToken, requirePermission } = require('../middleware/auth');
const asyncHandler = require('../helpers/asyncHandler');
const { getMonday, getWeekdayKey } = require('../utils/dateHelper');
const { default: mongoose } = require('mongoose');



// Helper: Calculate scheduled hours for a single day
const calculateDayHours = (day) => {
  if (day.isOff) return 0;
  if (day.isLeave) return day.leaveHours || 0;
  let mins = 0;
  day.shifts?.forEach(s => {
    const [sh, sm] = s.startTime.split(':').map(Number);
    const [eh, em] = s.endTime.split(':').map(Number);
    let diff = (eh * 60 + em) - (sh * 60 + sm);
    if (diff < 0) diff += 24 * 60;
    mins += (diff - (s.breakMinutes || 0));
  });
  return parseFloat((mins / 60).toFixed(2));
};

// Helper: Calculate total weekly hours across all days
const calculateWeeklyHours = (days) => {
  const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  return weekdays.reduce((sum, day) => sum + calculateDayHours(days[day]), 0);
};

// ==========================================
// 1. SUBMIT LEAVE REQUEST (Employees) [2]
// ==========================================
// Inside backend routes/leaveRoutes.js -> POST / (Submit Request):

router.post('/', authenticateToken, asyncHandler(async (req, res) => {
  const { startDate, endDate, reason, note } = req.body; // 🛑 No leaveHours sent from frontend!

  if (!startDate || !endDate || !reason) {
    return res.status(400).json({ message: 'La date de début, de fin et le motif sont requis.' });
  }

  // 🛑 AUTOMATE LEAVE HOURS: Fetch employee's contract hours dynamically [2, 3]
  const employee = await User.findById(req.user.id);
  const contract = employee.contractHours || 35; // Default fallback to 35h
  const calculatedLeaveHours = parseFloat((contract / 5).toFixed(2)); // e.g., 35/5 = 7h, 39/5 = 7.8h

  const newRequest = new LeaveRequest({
    employee: req.user.id,
    startDate,
    endDate,
    leaveHours: calculatedLeaveHours, // Saved automatically [2]
    reason,
    note: note || '' // Saved automatically [2]
  });
  await newRequest.save();

  // 🔌 Emit private real-time notification to Admins & Managers
  const userSockets = req.app.get('userSockets');
  const io = req.app.get('io');

  const managers = await User.find().populate('role');
  const activeAdmins = managers.filter(m => ['admin', 'manager'].includes(m.role?.name));

  for (const admin of activeAdmins) {
    const notification = new Notification({
      recipient: admin._id,
      title: '📅 New Leave Request',
      message: `${req.user.name} has requested leave from ${startDate} to ${endDate}.`,
      link: '/dashboard/leaves'
    });
    await notification.save();

    const socketId = userSockets.get(admin._id.toString());
    if (socketId) {
      io.to(socketId).emit('notification_received', notification);
    }
  }

  res.status(201).json({ message: 'Demande de congé envoyée avec succès.', request: newRequest });
}));

// ==========================================
// 2. GET OWN LEAVE HISTORY (Employees)
// ==========================================
router.get('/my-requests', authenticateToken, asyncHandler(async (req, res) => {
  const requests = await LeaveRequest.find({ employee: req.user.id }).sort({ createdAt: -1 });
  res.json(requests);
}));

// ==========================================
// 3. GET ALL PENDING REQUESTS (Managers & Admins) [3]
// ==========================================
router.get('/admin/list', authenticateToken, requirePermission('employees:view'), asyncHandler(async (req, res) => {
  const requests = await LeaveRequest.find()
    .populate('employee', 'name avatar')
    .sort({ createdAt: -1 });
  res.json(requests);
}));




// =========================================================================
// 4. APPROVE / REJECT LEAVE REQUEST (With Transactional Auto-Fill) [1, 2]
// =========================================================================
router.put('/admin/:id/status', authenticateToken, requirePermission('employees:edit'), asyncHandler(async (req, res) => {
  const { status } = req.body; // 'approved' or 'rejected'
  
  const request = await LeaveRequest.findById(req.params.id);
  if (!request) return res.status(404).json({ message: 'Demande introuvable.' });

  if (request.status !== 'pending') {
    return res.status(400).json({ message: 'Cette demande a déjà été traitée.' });
  }

  const userSockets = req.app.get('userSockets');
  const io = req.app.get('io');

  // If rejected, simply update the request status (no schedule edits needed)
  if (status === 'rejected') {
    request.status = 'rejected';
    request.approvedBy = req.user.id;
    await request.save();

    const notification = new Notification({
      recipient: request.employee,
      title: '❌ Leave Request Rejected',
      message: `Your leave request for ${request.startDate} to ${request.endDate} has been rejected.`
    });
    await notification.save();

    const recipientSocketId = userSockets.get(request.employee.toString());
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('notification_received', notification);
    }

    return res.json({ message: 'Demande rejetée.', request });
  }

  // -------------------------------------------------------------------------
  // 🛑 START TRANSACTION SESSION FOR APPROVAL (Auto-fills multiple weeks safely) [2]
  // -------------------------------------------------------------------------
  const session = await mongoose.startSession();
  session.startTransaction(); // Opens the transactional session lock [2]

  try {
    // 1. Update request status inside the session [2]
    request.status = 'approved';
    request.approvedBy = req.user.id;
    await request.save({ session });

    const start = new Date(`${request.startDate}T00:00:00`);
    const end = new Date(`${request.endDate}T00:00:00`);

    let current = new Date(start);
    while (current <= end) {
      const currentDateStr = current.toLocaleDateString('fr-CA'); // "YYYY-MM-DD"
      const weekStartDate = getMonday(currentDateStr);
      const dayName = getWeekdayKey(currentDateStr);

      // Find or create the WeeklySchedule document inside the session [2]
      let schedule = await WeeklySchedule.findOne({ employee: request.employee, weekStartDate }).session(session);
      if (!schedule) {
        schedule = new WeeklySchedule({
          employee: request.employee,
          weekStartDate,
          days: {
            monday: { isOff: true, shifts: [] }, tuesday: { isOff: true, shifts: [] }, wednesday: { isOff: true, shifts: [] },
            thursday: { isOff: true, shifts: [] }, friday: { isOff: true, shifts: [] }, saturday: { isOff: true, shifts: [] },
            sunday: { isOff: true, shifts: [] }
          }
        });
      }

      // Mark the specific day as Leave/Congé
      schedule.days[dayName] = {
        isOff: false,
        isLeave: true,
        leaveHours: request.leaveHours,
        shifts: []
      };

      // Recalculate total hours and save inside the session [2]
      schedule.totalHours = calculateWeeklyHours(schedule.days);
      await schedule.save({ session });

      current.setDate(current.getDate() + 1); // Move to next day
    }

    // 2. Create the notification inside the session [2]
    const notification = new Notification({
      recipient: request.employee,
      title: '✅ Leave Approved!',
      message: `Your leave request for ${request.startDate} to ${request.endDate} has been approved.`
    });
    await notification.save({ session });

    // 🏆 3. COMMIT ALL CHANGES SIMULTANEOUSLY [2]
    await session.commitTransaction(); 
    session.endSession(); // Close session safely

    // Emit live schedule refresh to planning boards now that transaction succeeded
    io.emit('schedule_updated');

    const recipientSocketId = userSockets.get(request.employee.toString());
    if (recipientSocketId) {
      const latestNotif = await Notification.findOne({ recipient: request.employee }).sort({ createdAt: -1 });
      io.to(recipientSocketId).emit('notification_received', latestNotif);
    }

    res.json({ message: 'Demande approuvée et calendriers mis à jour.', request });

  } catch (error) {
    // 🛑 4. ROLLBACK ON FAILURE: Undoes any written days and clears status updates [2]
    await session.abortTransaction(); 
    session.endSession();
    throw new Error(error.message); // Passed to central handler [2]
  }
}));

module.exports = router;