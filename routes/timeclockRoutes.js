const express = require("express");
const router = express.Router();
const User = require("../models/User");
const Timeclock = require("../models/Timeclock");
const WeeklySchedule = require("../models/WeeklySchedule");
const Role = require("../models/Role");
const Settings = require("../models/Settings");
const mongoose = require("mongoose"); // 🛑 Import mongoose for transaction sessions [2]

const { authenticateToken, requirePermission } = require("../middleware/auth");
const { decrypt } = require("../helpers/cryptoHelper");
const { getDistanceInMeters } = require("../utils/geoHelper");
const { pinVerifyLimiter } = require('../middleware/rateLimiter');
const asyncHandler = require("../helpers/asyncHandler"); // 🛑 Centralized async wrapper [2]

// 🛑 Centralized Date Helpers (Duplicate local helpers deleted) [3]
const { getMonday, getWeekdayKey, getLocalDateString } = require("../utils/dateHelper");

// Helper: Convert "10:00" to minutes past midnight
const getMinutesFromTimeStr = (timeStr) => {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
};

// =========================================================================
// 🛑 POINTEUSE PUBLIC ENDPOINTS (Placed first for fast routing)
// =========================================================================

// 1. STEP 1: VERIFY PIN, GPS, AND SCHEDULE ALIGNMENT (With Geofencing & early safeguards) [2]
router.post('/verify', pinVerifyLimiter, asyncHandler(async (req, res) => {
  const { pinCode, action, latitude, longitude } = req.body; // coordinates passed from client

  if (!pinCode || !action) {
    return res.status(400).json({ message: 'Le code PIN et l action sont requis.' });
  }

  // Locate the employee by decrypting their stored PIN on the fly
  const users = await User.find({ pinCode: { $ne: null } }).populate('role');
  const employee = users.find(u => decrypt(u.pinCode) === pinCode);

  if (!employee) {
    return res.status(400).json({ message: 'Code PIN incorrect. Veuillez réessayer.' });
  }

  if (employee.role.name !== 'employee') {
    return res.status(403).json({ message: 'Seuls les employés peuvent utiliser la pointeuse.' });
  }

  // 🛑 GEOFENCING CHECK: Dynamic database settings lookup [2]
  if (latitude && longitude) {
    const settings = await Settings.findOne({ key: 'restaurant_config' });
    const targetLat = settings?.latitude;
    const targetLon = settings?.longitude;
    const maxRadius = settings?.allowedRadiusMeters || 100;

    // If coordinates are blank/null in database, safely bypass geofencing completely! [2]
    if (targetLat !== null && targetLon !== null && !isNaN(targetLat) && !isNaN(targetLon)) {
      const distance = getDistanceInMeters(latitude, longitude, targetLat, targetLon);

      console.log(`📍 Live Database Geofence Check:
        - Employee: [${latitude}, ${longitude}]
        - Restaurant: [${targetLat}, ${targetLon}]
        - Calculated Distance: ${Math.round(distance)}m
        - Allowed Radius: ${maxRadius}m
      `);

      if (distance > maxRadius) {
        return res.status(403).json({ 
          message: `Accès refusé : Vous devez être présent sur le lieu de travail pour pointer. (Distance actuelle: ${Math.round(distance)}m)` 
        });
      }
    } else {
      console.log("📍 Geofencing bypassed because restaurant coordinates are set to blank in database.");
    }
  }

  const todayStr = getLocalDateString();
  const dayName = getWeekdayKey(todayStr); // e.g. "monday"
  const weekStartStr = getMonday(todayStr);

  const activePunch = await Timeclock.findOne({ employee: employee._id, checkOut: null });

  // ------------------------------------------
  // SCHEDULE-ALIGNED EARLY PUNCH SAFEGUARDS (On 'arriver' only) [2]
  // ------------------------------------------
  if (action === 'arriver') {
    if (activePunch) {
      return res.status(400).json({ message: 'Vous êtes déjà arrivé ! Veuillez d abord cliquer sur "Départ en Pause" ou "Départ".' });
    }

    // Fetch this employee's published schedule for the current week [2]
    const schedule = await WeeklySchedule.findOne({ employee: employee._id, weekStartDate: weekStartStr, status: 'published' });
    if (!schedule) {
      return res.status(400).json({ message: 'Aucun planning publié pour vous cette semaine. Impossible de pointer.' });
    }

    const daySchedule = schedule.days[dayName];
    if (!daySchedule || daySchedule.isOff) {
      return res.status(400).json({ message: 'Vous n êtes pas planifié aujourd hui (Repos).' });
    }
    if (daySchedule.isLeave) {
      return res.status(400).json({ message: 'Vous êtes en congé payé aujourd hui.' });
    }

    // Timezone-immune current time calculation (Forced to France Europe/Paris timezone)
    const timeStrInFrance = new Date().toLocaleTimeString('fr-FR', {
      timeZone: 'Europe/Paris',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    const [localH, localM] = timeStrInFrance.split(':').map(Number);
    const currentMinutes = localH * 60 + localM; // Current minutes past midnight in France

    let closestShiftStart = null;
    let minDiff = Infinity;

    daySchedule.shifts.forEach(shift => {
      const shiftStartMinutes = getMinutesFromTimeStr(shift.startTime);
      const diff = shiftStartMinutes - currentMinutes; // Minutes before shift starts

      // Allow clocking in if they are up to 2 hours late (diff >= -120), but check early clock-ins
      if (diff >= -120 && diff < minDiff) {
        minDiff = diff;
        closestShiftStart = shift.startTime;
      }
    });

    // If the closest shift starts in more than 3 minutes, block them! [2]
    if (minDiff > 3 && minDiff !== Infinity) {
      const shiftStartMinutes = getMinutesFromTimeStr(closestShiftStart);
      const allowedMinutes = shiftStartMinutes - 3;
      const allowedH = Math.floor(allowedMinutes / 60);
      const allowedM = allowedMinutes % 60;
      const allowedTime = `${String(allowedH).padStart(2, '0')}:${String(allowedM).padStart(2, '0')}`;

      return res.status(400).json({ 
        message: `Trop tôt ! Votre shift commence à ${closestShiftStart}. Vous pourrez pointer à partir de ${allowedTime}.` 
      });
    }
  }

  // ------------------------------------------
  // CHECK FOUR-STEP WORKTIME LIFECYCLE LIMITS [2]
  // ------------------------------------------
  if (action === 'pause_start') {
    if (!activePunch) return res.status(400).json({ message: 'Vous devez d abord pointer à l arrivée.' });
    if (activePunch.breakStart) return res.status(400).json({ message: 'Vous êtes déjà en pause.' });
  }

  if (action === 'pause_end') {
    if (!activePunch || !activePunch.breakStart) return res.status(400).json({ message: 'Aucun départ en pause enregistré.' });
    if (activePunch.breakEnd) return res.status(400).json({ message: 'Vous êtes déjà revenu de pause.' });
  }

  if (action === 'depart') {
    if (!activePunch) return res.status(400).json({ message: 'Aucun enregistrement d arrivée actif.' });
    // If they started a break but never finished it, force them to close the break first [2]
    if (activePunch.breakStart && !activePunch.breakEnd) {
      return res.status(400).json({ message: 'Veuillez d abord enregistrer votre "Retour de Pause" avant de partir.' });
    }
  }

  // Verification passed -> return identity [2]
  res.json({
    employee: {
      id: employee._id,
      name: employee.name,
      avatar: employee.avatar
    },
    action
  });
}));

// 2. STEP 2: CONFIRM AND COMMIT PUNCH [2]
router.post('/confirm', authenticateToken, asyncHandler(async (req, res) => {
  const { employeeId, action } = req.body;

  if (!employeeId || !action) {
    return res.status(400).json({ message: 'Données de confirmation manquantes.' });
  }

  const employee = await User.findById(employeeId);
  if (!employee) return res.status(404).json({ message: 'Employé introuvable.' });

  const todayStr = getLocalDateString();
  const activePunch = await Timeclock.findOne({ employee: employeeId, checkOut: null });

  // Arrival ('arriver')
  if (action === 'arriver') {
    if (activePunch) return res.status(400).json({ message: 'Déjà enregistré.' });

    const newPunch = new Timeclock({
      employee: employeeId,
      date: todayStr,
      checkIn: new Date()
    });
    await newPunch.save();

    req.app.get('io').emit('timeclock_updated');

    return res.json({
      success: true,
      action: 'arriver',
      message: 'Bon service ! 👍',
      employee: { name: employee.name, avatar: employee.avatar },
      time: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
    });
  }

  // Start Break ('pause_start') [2]
  if (action === 'pause_start') {
    if (!activePunch || activePunch.breakStart) return res.status(400).json({ message: 'Action invalide.' });

    activePunch.breakStart = new Date();
    await activePunch.save();

    return res.json({
      success: true,
      action: 'pause_start',
      message: 'Bonne pause ! ☕',
      employee: { name: employee.name, avatar: employee.avatar },
      time: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
    });
  }

  // End Break ('pause_end') [2]
  if (action === 'pause_end') {
    if (!activePunch || !activePunch.breakStart || activePunch.breakEnd) return res.status(400).json({ message: 'Action invalide.' });

    const endBreakTime = new Date();
    const breakDiffMs = endBreakTime - activePunch.breakStart;
    const actualBreakMinutes = Math.floor(breakDiffMs / 60000);

    activePunch.checkOut = null; // Remains active until main checkout
    activePunch.breakEnd = endBreakTime;
    activePunch.actualBreakMinutes = (activePunch.actualBreakMinutes || 0) + actualBreakMinutes;
    await activePunch.save();

    return res.json({
      success: true,
      action: 'pause_end',
      message: `Fin de pause ! Travail repris. (Durée: ${actualBreakMinutes} min)`,
      employee: { name: employee.name, avatar: employee.avatar },
      time: endBreakTime.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
    });
  }

  // Departure ('depart') [2]
  if (action === 'depart') {
    if (!activePunch) return res.status(400).json({ message: 'Non enregistré.' });

    const checkOutTime = new Date();
    const diffMs = checkOutTime - activePunch.checkIn;
    const elapsedMinutes = Math.floor(diffMs / 60000);

    // Subtract actual break minutes from total elapsed worked minutes [2]
    const finalMinutesWorked = Math.max(0, elapsedMinutes - (activePunch.actualBreakMinutes || 0));

    activePunch.checkOut = checkOutTime;
    activePunch.totalMinutes = finalMinutesWorked;
    await activePunch.save();

    req.app.get('io').emit('timeclock_updated'); // Update Admin dashboards in real-time [2, 3]

    return res.json({
      success: true,
      action: 'depart',
      message: 'Bonne soirée ! 👋',
      employee: { name: employee.name, avatar: employee.avatar },
      time: checkOutTime.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
    });
  }
}));

// 3. PUNCH FALLBACK (Kept for backwards compatibility)
router.post('/punch', asyncHandler(async (req, res) => {
  const { pinCode, action } = req.body;
  if (!pinCode || !action) return res.status(400).json({ message: 'Code PIN et action requis.' });

  const users = await User.find({ pinCode: { $ne: null } }).populate('role');
  const employee = users.find((u) => decrypt(u.pinCode) === pinCode);

  if (!employee) return res.status(400).json({ message: 'Code PIN incorrect.' });
  if (employee.role.name !== 'employee') return res.status(403).json({ message: 'Accès refusé.' });

  const todayStr = getLocalDateString();
  const activePunch = await Timeclock.findOne({ employee: employee._id, checkOut: null });

  if (action === 'arriver') {
    if (activePunch) return res.status(400).json({ message: 'Déjà enregistré.' });
    const newPunch = new Timeclock({ employee: employee._id, date: todayStr, checkIn: new Date() });
    await newPunch.save();
    req.app.get('io').emit('timeclock_updated');
    return res.json({ success: true, action: 'arriver', employee: { name: employee.name } });
  } else if (action === 'depart') {
    if (!activePunch) return res.status(400).json({ message: 'Non enregistré.' });
    const checkOutTime = new Date();
    activePunch.checkOut = checkOutTime;
    activePunch.totalMinutes = Math.floor((checkOutTime - activePunch.checkIn) / 60000);
    await activePunch.save();
    req.app.get('io').emit('timeclock_updated');
    return res.json({ success: true, action: 'depart', employee: { name: employee.name } });
  }
}));

// =========================================================================
// 🛑 ADMIN STATIC ROUTES (Placed above wildcard ID endpoints) [1]
// =========================================================================

// 4. GET ALL TIMESHEETS (Admins & Managers) [3]
router.get('/admin/list', authenticateToken, requirePermission('pointage:view'), asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const search = req.query.search || '';
  const filterApproved = req.query.filter || ''; 

  let query = {};
  if (search) {
    const matchingEmployees = await User.find({ name: { $regex: search, $options: 'i' } }).select('_id');
    query.employee = { $in: matchingEmployees.map(e => e._id) };
  }

  if (filterApproved) {
    query.isApproved = filterApproved === 'true';
  }

  const totalDocs = await Timeclock.countDocuments(query);
  const totalPages = Math.ceil(totalDocs / limit);
  const skip = (page - 1) * limit;

  const timesheets = await Timeclock.find(query)
    .populate('employee', 'name avatar contractHours')
    .populate('approvedBy', 'name')
    .sort({ date: -1, createdAt: -1 })
    .skip(skip)
    .limit(limit);

  const enrichedTimesheets = [];
  for (const ts of timesheets) {
    const tsObj = ts.toObject();
    const weekStartStr = getMonday(ts.date);
    const dayName = getWeekdayKey(ts.date);

    const schedule = await WeeklySchedule.findOne({ employee: ts.employee._id, weekStartDate: weekStartStr });
    let plannedShiftText = 'No Plan';

    if (schedule) {
      const dayData = schedule.days[dayName];
      if (dayData) {
        if (dayData.isOff) plannedShiftText = 'Repos';
        else if (dayData.isLeave) plannedShiftText = `Congé (${dayData.leaveHours}h)`;
        else if (dayData.shifts && dayData.shifts.length > 0) {
          plannedShiftText = dayData.shifts.map(s => `${s.startTime}-${s.endTime}`).join(' / ');
        }
      }
    }
    tsObj.plannedShiftText = plannedShiftText;
    enrichedTimesheets.push(tsObj);
  }

  res.json({ docs: enrichedTimesheets, totalPages, totalDocs, page });
}));

// 5. GET WEEKLY SUMMARY REPORT FOR ALL EMPLOYEES (Admins & Managers) [2]
router.get('/admin/weekly-summary', authenticateToken, requirePermission('pointage:view'), asyncHandler(async (req, res) => {
  const { weekStartDate } = req.query; 
  if (!weekStartDate) return res.status(400).json({ message: 'weekStartDate parameter is required.' });

  const employeeRole = await Role.findOne({ name: 'employee' });
  const employees = await User.find({ role: employeeRole._id }).select('name email contractHours avatar');

  const dates = [];
  const startDate = new Date(weekStartDate.replace(/-/g, '/')); // Force slash parsing [1.1.4]
  for (let i = 0; i < 7; i++) {
    const d = new Date(startDate);
    d.setDate(startDate.getDate() + i);
    dates.push(d.toLocaleDateString('fr-CA')); 
  }

  const summaries = [];
  for (const emp of employees) {
    const punches = await Timeclock.find({ employee: emp._id, date: { $in: dates } });

    let totalMinutes = 0;
    let pendingCount = 0;
    let completedCount = 0;

    punches.forEach(p => {
      if (p.checkOut) {
        totalMinutes += (p.totalMinutes || 0);
        completedCount++;
        if (!p.isApproved) pendingCount++;
      } else {
        const diffMs = new Date() - new Date(p.checkIn);
        totalMinutes += Math.max(0, Math.floor(diffMs / 60000));
        pendingCount++;
      }
    });

    const actualHours = parseFloat((totalMinutes / 60).toFixed(2));
    const contractHours = emp.contractHours || 35;
    const extraHours = actualHours > contractHours ? parseFloat((actualHours - contractHours).toFixed(2)) : 0;

    const isFullyApproved = completedCount > 0 && pendingCount === 0;

    summaries.push({
      employee: emp,
      contractHours,
      actualHours,
      extraHours,
      isFullyApproved,
      pendingCount,
      completedCount
    });
  }

  res.json(summaries);
}));

// 6. BULK APPROVE / LOCK ALL TIMESHEETS FOR A WEEK (With Date Range limits) [2]
router.put('/admin/approve-all', authenticateToken, requirePermission('employees:edit'), asyncHandler(async (req, res) => {
  const { weekStartDate } = req.body; 
  let query = { checkOut: { $ne: null }, isApproved: false };

  if (weekStartDate) {
    const dates = [];
    const startDate = new Date(weekStartDate.replace(/-/g, '/')); // Force slash parsing [1.1.4]
    for (let i = 0; i < 7; i++) {
      const d = new Date(startDate);
      d.setDate(startDate.getDate() + i);
      dates.push(d.toLocaleDateString('fr-CA'));
    }
    query.date = { $in: dates };
  }

  const result = await Timeclock.updateMany(query, {
    isApproved: true,
    approvedBy: req.user.id
  });

  req.app.get('io').emit('timeclock_updated');

  res.json({
    message: `${result.modifiedCount} fiches de temps ont été approuvées et verrouillées avec succès.`,
    modifiedCount: result.modifiedCount
  });
}));

// 7. MANUALLY CREATE A TIMESHEET (With Mongoose ACID Transaction session protection) [1, 2]
router.post('/admin/create', authenticateToken, requirePermission('employees:edit'), asyncHandler(async (req, res) => {
  const { employeeId, date, checkInTime, checkOutTime, breakMinutes, shiftType, checkInTime2, checkOutTime2, breakMinutes2 } = req.body;

  if (!employeeId || !date || !shiftType) {
    return res.status(400).json({ message: 'L employé, la date et le type de shift sont requis.' });
  }

  const employee = await User.findById(employeeId);
  if (!employee) return res.status(404).json({ message: 'Employé introuvable.' });

  // 🛑 START TRANSACTION SESSION [2]
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // ------------------------------------------
    // DYNAMIC DOUBLE SHIFT SPLITTING PATH [2]
    // ------------------------------------------
    if (shiftType === 'double') {
      if (!checkInTime || !checkOutTime || !checkInTime2 || !checkOutTime2) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ message: 'Les heures pour les deux shifts sont requises.' });
      }

      // Compile Shift 1 (Midi)
      const checkInDate1 = new Date(`${date}T${checkInTime}:00`);
      const checkOutDate1 = new Date(`${date}T${checkOutTime}:00`);
      if (checkOutDate1 <= checkInDate1) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ message: 'L heure de départ du Shift 1 doit être après l heure d arrivée.' });
      }
      const mins1 = Math.floor((checkOutDate1 - checkInDate1) / 60000);
      const totalMinutes1 = Math.max(0, mins1 - parseInt(breakMinutes || 0));

      // Compile Shift 2 (Soir)
      const checkInDate2 = new Date(`${date}T${checkInTime2}:00`);
      const checkOutDate2 = new Date(`${date}T${checkOutTime2}:00`);
      if (checkOutDate2 <= checkInDate2) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ message: 'L heure de départ du Shift 2 doit être après l heure d arrivée.' });
      }
      const mins2 = Math.floor((checkOutDate2 - checkInDate2) / 60000);
      const totalMinutes2 = Math.max(0, mins2 - parseInt(breakMinutes2 || 0));

      // Build both documents [2]
      const timesheetMidi = new Timeclock({
        employee: employeeId,
        date,
        checkIn: checkInDate1,
        checkOut: checkOutDate1,
        totalMinutes: totalMinutes1,
        breakMinutes: parseInt(breakMinutes || 0),
        shiftType: 'midi',
        isApproved: false
      });

      const timesheetSoir = new Timeclock({
        employee: employeeId,
        date,
        checkIn: checkInDate2,
        checkOut: checkOutDate2,
        totalMinutes: totalMinutes2,
        breakMinutes: parseInt(breakMinutes2 || 0),
        shiftType: 'soir',
        isApproved: false
      });

      // Save both INSIDE the transaction session [2]
      await timesheetMidi.save({ session });
      await timesheetSoir.save({ session });

      await session.commitTransaction();
      session.endSession();

      req.app.get('io').emit('timeclock_updated');
      return res.status(201).json({ message: 'Double shift créé et séparé avec succès.' });
    }

    // ------------------------------------------
    // STANDARD SINGLE SHIFT PATH (Midi, Soir, Repos, Conge) [2]
    // ------------------------------------------
    let checkInDate = null;
    let checkOutDate = null;
    let totalMinutes = 0;

    if (shiftType === 'conge') {
      totalMinutes = 420; // 7 hours
    } else if (shiftType === 'repos') {
      totalMinutes = 0;
    } else {
      if (!checkInTime || !checkOutTime) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ message: 'Les heures d arrivée et de départ sont requises.' });
      }

      checkInDate = new Date(`${date}T${checkInTime}:00`);
      checkOutDate = new Date(`${date}T${checkOutTime}:00`);

      if (checkOutDate <= checkInDate) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ message: 'L heure de départ doit être après l heure d arrivée.' });
      }

      const diffMinutes = Math.floor((checkOutDate - checkInDate) / 60000);
      totalMinutes = Math.max(0, diffMinutes - parseInt(breakMinutes || 0));
    }

    const newTimesheet = new Timeclock({
      employee: employeeId,
      date,
      checkIn: checkInDate,
      checkOut: checkOutDate,
      totalMinutes,
      breakMinutes: parseInt(breakMinutes || 0),
      shiftType,
      isApproved: false
    });

    // Save inside the session [2]
    await newTimesheet.save({ session });

    await session.commitTransaction();
    session.endSession();

    req.app.get('io').emit('timeclock_updated');

    res.status(201).json({ message: 'Fiche de temps créée manuellement.', timesheet: newTimesheet });

  } catch (error) {
    // Roll back if any part of the double save fails, preventing orphan records [2]
    await session.abortTransaction();
    session.endSession();
    throw new Error(error.message);
  }
}));

// =========================================================================
// 🛑 WILDCARD DYNAMIC ROUTES (Placed below static entries) [1]
// =========================================================================

// 8. APPROVE / LOCK A SINGLE TIMESHEET
router.put('/:id/approve', authenticateToken, requirePermission('employees:edit'), asyncHandler(async (req, res) => {
  const timesheet = await Timeclock.findById(req.params.id);
  if (!timesheet) return res.status(404).json({ message: 'Fiche de temps introuvable.' });

  if (!timesheet.checkOut) {
    return res.status(400).json({ message: 'Impossible d approuver une session encore active.' });
  }

  timesheet.isApproved = true;
  timesheet.approvedBy = req.user.id;
  await timesheet.save();

  req.app.get('io').emit('timeclock_updated');

  res.json({ message: 'Fiche approuvée et verrouillée.', timesheet });
}));

// 9. UNLOCK A LOCKED TIMESHEET [1]
router.put('/:id/unlock', authenticateToken, requirePermission('employees:edit'), asyncHandler(async (req, res) => {
  const timesheet = await Timeclock.findById(req.params.id);
  if (!timesheet) return res.status(404).json({ message: 'Fiche introuvable.' });

  timesheet.isApproved = false;
  timesheet.approvedBy = null; 
  await timesheet.save();

  req.app.get('io').emit('timeclock_updated'); 

  res.json({ message: 'Fiche de temps déverrouillée.', timesheet });
}));

// 10. MANUALLY EDIT/CORRECT A TIMESHEET (With Break Subtraction) [2]
router.put('/:id', authenticateToken, requirePermission('employees:edit'), asyncHandler(async (req, res) => {
  const { checkInTime, checkOutTime, date, breakMinutes, shiftType } = req.body;

  const timesheet = await Timeclock.findById(req.params.id);
  if (!timesheet) return res.status(404).json({ message: 'Fiche de temps introuvable.' });

  if (timesheet.isApproved) {
    return res.status(400).json({ message: 'Cette fiche est verrouillée et ne peut plus être modifiée.' });
  }

  const targetDateStr = date || timesheet.date;
  const targetShiftType = shiftType || timesheet.shiftType;

  let checkInDate = null;
  let checkOutDate = null;
  let totalMinutes = 0;

  if (targetShiftType === 'conge') {
    totalMinutes = 420; // 7 hours
  } else if (targetShiftType === 'repos') {
    totalMinutes = 0;
  } else {
    const activeCheckInTime = checkInTime || (timesheet.checkIn ? new Date(timesheet.checkIn).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : null);
    const activeCheckOutTime = checkOutTime || (timesheet.checkOut ? new Date(timesheet.checkOut).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : null);

    if (!activeCheckInTime || !activeCheckOutTime) {
      return res.status(400).json({ message: 'Les heures d arrivée et de départ sont requises.' });
    }

    checkInDate = new Date(`${targetDateStr}T${activeCheckInTime}:00`);
    checkOutDate = new Date(`${targetDateStr}T${activeCheckOutTime}:00`);

    if (checkOutDate <= checkInDate) {
      return res.status(400).json({ message: 'L heure de départ doit être après l heure d arrivée.' });
    }

    const diffMinutes = Math.floor((checkOutDate - checkInDate) / 60000);
    const activeBreak = breakMinutes !== undefined ? parseInt(breakMinutes) : timesheet.breakMinutes;
    totalMinutes = Math.max(0, diffMinutes - activeBreak);
  }

  timesheet.date = targetDateStr;
  timesheet.shiftType = targetShiftType;
  timesheet.checkIn = checkInDate;
  timesheet.checkOut = checkOutDate;
  timesheet.totalMinutes = totalMinutes;
  timesheet.breakMinutes = breakMinutes !== undefined ? parseInt(breakMinutes) : timesheet.breakMinutes;
  await timesheet.save();

  req.app.get('io').emit('timeclock_updated');

  res.json({ message: 'Fiche de temps corrigée avec succès.', timesheet });
}));

// 11. DELETE A TIMESHEET [1]
router.delete('/:id', authenticateToken, requirePermission('employees:delete'), asyncHandler(async (req, res) => {
  const timesheet = await Timeclock.findById(req.params.id);
  if (!timesheet) return res.status(404).json({ message: 'Fiche introuvable.' });

  if (timesheet.isApproved) {
    return res.status(400).json({ message: 'Impossible de supprimer une fiche verrouillée.' });
  }

  await Timeclock.findByIdAndDelete(req.params.id);
  req.app.get('io').emit('timeclock_updated'); 

  res.json({ message: 'Fiche de temps supprimée avec succès.' });
}));

module.exports = router;