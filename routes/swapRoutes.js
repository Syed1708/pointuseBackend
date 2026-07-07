const express = require('express');
const router = express.Router();
const SwapRequest = require('../models/SwapRequest');
const WeeklySchedule = require('../models/WeeklySchedule');
const User = require('../models/User');
const Notification = require('../models/Notification');
const { authenticateToken, requirePermission } = require('../middleware/auth');
const { getMonday, getWeekdayKey } = require('../utils/dateHelper');
const asyncHandler = require('../helpers/asyncHandler');

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

const calculateWeeklyHours = (days) => {
  const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  return weekdays.reduce((sum, day) => sum + calculateDayHours(days[day]), 0);
};

// 1. INITIATE A SWAP REQUEST (Employee A) [2]
router.post('/', authenticateToken, asyncHandler(async (req, res) => {
  const { receiverId, senderDate, senderShiftIndex, receiverDate, receiverShiftIndex } = req.body;

  const newRequest = new SwapRequest({
    sender: req.user.id,
    receiver: receiverId,
    senderDate,
    senderShiftIndex,
    receiverDate,
    receiverShiftIndex,
    status: 'pending_receiver'
  });
  await newRequest.save();

  // Notify Employee B privately
  const userSockets = req.app.get('userSockets');
  const io = req.app.get('io');

  const notification = new Notification({
    recipient: receiverId,
    title: '🔄 Shift Swap Request',
    message: `${req.user.name} wants to swap a shift with you. Check your Inbox!`,
    link: '/dashboard/leaves' // Swaps and leaves managed under requests tab
  });
  await notification.save();

  const recipientSocketId = userSockets.get(receiverId.toString());
  if (recipientSocketId) {
    io.to(recipientSocketId).emit('notification_received', notification);
  }

  res.status(201).json({ message: 'Demande d échange envoyée à votre collègue.', request: newRequest });
}));

// 2. PEER RESPOND TO SWAP (Employee B Accepts or Declines) [2]
router.put('/:id/respond', authenticateToken, asyncHandler(async (req, res) => {
  const { accept } = req.body; // true or false
  const request = await SwapRequest.findById(req.params.id).populate('sender');

  if (!request || request.receiver.toString() !== req.user.id) {
    return res.status(404).json({ message: 'Demande introuvable.' });
  }

  if (request.status !== 'pending_receiver') {
    return res.status(400).json({ message: 'Cette demande a déjà été traitée.' });
  }

  const userSockets = req.app.get('userSockets');
  const io = req.app.get('io');

  if (!accept) {
    request.status = 'rejected';
    await request.save();

    // Notify Employee A of rejection
    const notification = new Notification({
      recipient: request.sender._id,
      title: '❌ Shift Swap Declined',
      message: `${req.user.name} declined your shift swap request.`
    });
    await notification.save();

    const socketId = userSockets.get(request.sender._id.toString());
    if (socketId) io.to(socketId).emit('notification_received', notification);

    return res.json({ message: 'Échange refusé.', request });
  }

  // If Employee B accepts, escalate to Manager approval [2]
  request.status = 'pending_manager';
  await request.save();

  // Notify Managers
  const managers = await User.find().populate('role');
  const activeAdmins = managers.filter(m => ['admin', 'manager'].includes(m.role?.name));

  for (const admin of activeAdmins) {
    const notification = new Notification({
      recipient: admin._id,
      title: '🔄 Swap Pending Manager Approval',
      message: `${request.sender.name} and ${req.user.name} have agreed to swap shifts and require your approval.`,
      link: '/dashboard/leaves'
    });
    await notification.save();

    const socketId = userSockets.get(admin._id.toString());
    if (socketId) io.to(socketId).emit('notification_received', notification);
  }

  res.json({ message: 'Échange accepté par le collègue. En attente du manager.', request });
}));

// 3. GET LIST OF ACTIVE SWAPS
router.get('/my-swaps', authenticateToken, asyncHandler(async (req, res) => {
  const requests = await SwapRequest.find({
    $or: [{ sender: req.user.id }, { receiver: req.user.id }]
  })
    .populate('sender', 'name')
    .populate('receiver', 'name')
    .sort({ createdAt: -1 });
  res.json(requests);
}));

// 4. GET ALL MANAGER INBOX SWAPS (Admins/Managers) [3]
router.get('/admin/list', authenticateToken, requirePermission('employees:view'), asyncHandler(async (req, res) => {
  const requests = await SwapRequest.find({ status: 'pending_manager' })
    .populate('sender', 'name avatar')
    .populate('receiver', 'name avatar')
    .sort({ createdAt: -1 });
  res.json(requests);
}));

// ==========================================
// 5. MANAGER FINALIZE SWAP (The Auto-Swap Logic) [1, 2]
// ==========================================
router.put('/admin/:id/status', authenticateToken, requirePermission('employees:edit'), asyncHandler(async (req, res) => {
  const { status } = req.body; // 'approved' or 'rejected'
  
  const request = await SwapRequest.findById(req.params.id)
    .populate('sender')
    .populate('receiver');

  if (!request || request.status !== 'pending_manager') {
    return res.status(404).json({ message: 'Demande introuvable.' });
  }

  const userSockets = req.app.get('userSockets');
  const io = req.app.get('io');

  if (status === 'rejected') {
    request.status = 'rejected';
    await request.save();

    // Notify both employees
    const notifyUsers = [request.sender, request.receiver];
    for (const emp of notifyUsers) {
      const notification = new Notification({
        recipient: emp._id,
        title: '❌ Swap Request Rejected',
        message: `The manager rejected the shift swap from ${request.senderDate} to ${request.receiverDate}.`
      });
      await notification.save();
      const socketId = userSockets.get(emp._id.toString());
      if (socketId) io.to(socketId).emit('notification_received', notification);
    }

    return res.json({ message: 'Échange rejeté.', request });
  }

  // --------------------------------------------------
  // 🛑 TRANSACTIONAL SCHEDULE SHIFT SWAP OPERATIONS [2]
  // --------------------------------------------------
  const senderMon = getMonday(request.senderDate);
  const senderDayName = getWeekdayKey(request.senderDate);

  const receiverMon = getMonday(request.receiverDate);
  const receiverDayName = getWeekdayKey(request.receiverDate);

  // Load both schedules
  const senderSchedule = await WeeklySchedule.findOne({ employee: request.sender._id, weekStartDate: senderMon });
  const receiverSchedule = await WeeklySchedule.findOne({ employee: request.receiver._id, weekStartDate: receiverMon });

  if (!senderSchedule || !receiverSchedule) {
    return res.status(400).json({ message: 'Impossible de permuter : Calendriers introuvables.' });
  }

  // Extract shift references
  const senderShifts = senderSchedule.days[senderDayName].shifts;
  const receiverShifts = receiverSchedule.days[receiverDayName].shifts;

  const senderShiftObj = senderShifts[request.senderShiftIndex];
  const receiverShiftObj = receiverShifts[request.receiverShiftIndex];

  // Swap the objects in their arrays securely [2]
 senderShifts[request.senderShiftIndex] = receiverShiftObj;
  receiverShifts[request.receiverShiftIndex] = senderShiftObj;

  // Recalculate totals and save
  senderSchedule.totalHours = calculateWeeklyHours(senderSchedule.days);
  receiverSchedule.totalHours = calculateWeeklyHours(receiverSchedule.days);

  await senderSchedule.save();
  await receiverSchedule.save();

  // Save request completion
  request.status = 'approved';
  request.approvedBy = req.user.id;
  await request.save();

  // Live reload planning grids [2, 3]
  io.emit('schedule_updated');

  // Notify both employees
  const notifyUsers = [request.sender, request.receiver];
  for (const emp of notifyUsers) {
    const notification = new Notification({
      recipient: emp._id,
      title: '✅ Shift Swap Approved!',
      message: `Your shift swap from ${request.senderDate} to ${request.receiverDate} has been approved and applied.`
    });
    await notification.save();
    const socketId = userSockets.get(emp._id.toString());
    if (socketId) io.to(socketId).emit('notification_received', notification);
  }

  res.json({ message: 'Planning modifié et validé avec succès.', request });
}));

module.exports = router;