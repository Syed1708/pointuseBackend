const express = require("express");
const router = express.Router();
const User = require("../models/User");
const Timeclock = require("../models/Timeclock");
const { decrypt } = require("../helpers/cryptoHelper");
const { authenticateToken, requirePermission } = require("../middleware/auth");
const asyncHandler = require("../helpers/asyncHandler");
const WeeklySchedule = require("../models/WeeklySchedule");
const Role = require("../models/Role");
const Settings = require("../models/Settings");
const { pinVerifyLimiter } = require('../middleware/rateLimiter');
const { getDistanceInMeters } = require("../utils/geoHelper");

// Helper: Get YYYY-MM-DD in local timezone safely
const getLocalDateString = () => {
  return new Date().toLocaleDateString("fr-CA");
};

// Helper: Find Monday of any YYYY-MM-DD string
const getMonday = (dateStr) => {
  const date = new Date(dateStr + "T00:00:00");
  const day = date.getDay();
  const diff = date.getDate() - day + (day === 0 ? -6 : 1);
  const targetDate = new Date(date.setDate(diff));
  const year = targetDate.getFullYear();
  const month = String(targetDate.getMonth() + 1).padStart(2, "0");
  const dayStr = String(targetDate.getDate()).padStart(2, "0");
  return `${year}-${month}-${dayStr}`;
};

// Helper: Get weekday name from any YYYY-MM-DD string
const getWeekdayKey = (dateStr) => {
  const date = new Date(dateStr + "T00:00:00");
  const weekdays = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ];
  return weekdays[date.getDay()];
};


// Helper: Convert "10:00" to minutes past midnight
const getMinutesFromTimeStr = (timeStr) => {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
};

// ==========================================
// 1. GET ALL TIMESHEETS (With On-the-Fly Schedule Comparisons) [2, 3]
// ==========================================
router.get(
  "/admin/list",
  authenticateToken,
  requirePermission("pointage:view"),
  asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 2;
    const search = req.query.search || "";
    const filterApproved = req.query.filter || ""; // 'true' or 'false'

    let query = {};

    // If search query is provided, find matching employee IDs first [2]
    if (search) {
      const matchingEmployees = await User.find({
        name: { $regex: search, $options: "i" },
      }).select("_id");
      query.employee = { $in: matchingEmployees.map((e) => e._id) };
    }

    // Filter by approval status
    if (filterApproved) {
      query.isApproved = filterApproved === "true";
    }

    const totalDocs = await Timeclock.countDocuments(query);
    const totalPages = Math.ceil(totalDocs / limit);
    const skip = (page - 1) * limit;

    // Fetch timesheets
    const timesheets = await Timeclock.find(query)
      .populate("employee", "name avatar contractHours")
      .populate("approvedBy", "name")
      .sort({ date: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit);

    // 🛑 DYNAMICALLY LOOKUP AND MERGE PLANNED SHIFT FOR EACH TIMESHEET [2]
    const enrichedTimesheets = [];
    for (const ts of timesheets) {
      const tsObj = ts.toObject();

      // 1. Calculate the Monday and Day Key of this timesheet's date
      const weekStartStr = getMonday(ts.date);
      const dayName = getWeekdayKey(ts.date);

      // 2. Fetch the matching weekly schedule for this employee
      const schedule = await WeeklySchedule.findOne({
        employee: ts.employee._id,
        weekStartDate: weekStartStr,
      });

      let plannedShiftText = "No Plan"; // Default fallback

      // 3. Extract the planned shift configuration for this day
      if (schedule) {
        const dayData = schedule.days[dayName];
        if (dayData) {
          if (dayData.isOff) {
            plannedShiftText = "Repos";
          } else if (dayData.isLeave) {
            plannedShiftText = `Congé (${dayData.leaveHours}h)`;
          } else if (dayData.shifts && dayData.shifts.length > 0) {
            plannedShiftText = dayData.shifts
              .map((s) => `${s.startTime}-${s.endTime}`)
              .join(" / ");
          }
        }
      }

      tsObj.plannedShiftText = plannedShiftText; // Attach the planned shift text [2]
      enrichedTimesheets.push(tsObj);
    }

    res.json({
      docs: enrichedTimesheets,
      totalPages,
      totalDocs,
      page,
    });
  }),
);

// ==========================================
// 5. GET WEEKLY SUMMARY FOR ALL EMPLOYEES (Admins & Managers) [2]
// ==========================================
router.get(
  "/admin/weekly-summary",
  authenticateToken,
  requirePermission("pointage:view"),
  asyncHandler(async (req, res) => {
    const { weekStartDate } = req.query; // Expects "YYYY-MM-DD" representing a Monday
    if (!weekStartDate)
      return res
        .status(400)
        .json({ message: "weekStartDate parameter is required." });

    const employeeRole = await Role.findOne({ name: "employee" });
    const employees = await User.find({ role: employeeRole._id }).select(
      "name email contractHours avatar",
    );

    // Calculate the 7 dates of this week [3]
    const dates = [];
    const startDate = new Date(weekStartDate);
    for (let i = 0; i < 7; i++) {
      const d = new Date(startDate);
      d.setDate(startDate.getDate() + i);
      dates.push(d.toLocaleDateString("fr-CA")); // Formats safely to YYYY-MM-DD [3]
    }

    const summaries = [];
    for (const emp of employees) {
      // Fetch all timesheets for this employee during this week's 7 dates
      const punches = await Timeclock.find({
        employee: emp._id,
        date: { $in: dates },
      });

      let totalMinutes = 0;
      let pendingCount = 0;
      let completedCount = 0;

      punches.forEach((p) => {
        if (p.checkOut) {
          totalMinutes += p.totalMinutes || 0;
          completedCount++;
          if (!p.isApproved) pendingCount++;
        } else {
          // Active/Running session: calculate running minutes [2]
          const diffMs = new Date() - new Date(p.checkIn);
          totalMinutes += Math.max(0, Math.floor(diffMs / 60000));
          pendingCount++;
        }
      });

      const actualHours = parseFloat((totalMinutes / 60).toFixed(2));
      const contractHours = emp.contractHours || 35;
      const extraHours =
        actualHours > contractHours
          ? parseFloat((actualHours - contractHours).toFixed(2))
          : 0;

      // A week is fully approved if there are completed records and zero pending approvals left [2]
      const isFullyApproved = completedCount > 0 && pendingCount === 0;

      summaries.push({
        employee: emp,
        contractHours,
        actualHours,
        extraHours,
        isFullyApproved,
        pendingCount,
        completedCount,
      });
    }

    res.json(summaries);
  }),
);

// ==========================================
// 3. APPROVE / LOCK A TIMESHEET [2]
// ==========================================
router.put(
  "/admin/:id/approve",
  authenticateToken,
  requirePermission("employees:edit"),
  asyncHandler(async (req, res) => {
    const timesheet = await Timeclock.findById(req.params.id);
    if (!timesheet)
      return res.status(404).json({ message: "Fiche de temps introuvable." });

    if (!timesheet.checkOut) {
      return res
        .status(400)
        .json({ message: "Impossible d approuver une session encore active." });
    }

    timesheet.isApproved = true;
    timesheet.approvedBy = req.user.id; // Record who approved this [2]
    await timesheet.save();

    // Trigger real-time dashboard updates [2]
    req.app.get("io").emit("timeclock_updated");

    res.json({ message: "Fiche approuvée et verrouillée.", timesheet });
  }),
);

// ==========================================
// PUNCH CLOCK-IN / OUT (Pointeuse Logic remains the same)
// ==========================================
router.post(
  "/punch",
  asyncHandler(async (req, res) => {
    const { pinCode, action } = req.body;

    if (!pinCode || !action) {
      return res
        .status(400)
        .json({ message: "Le code PIN et l action sont requis." });
    }

    const users = await User.find({ pinCode: { $ne: null } }).populate("role");
    const employee = users.find((u) => decrypt(u.pinCode) === pinCode);

    if (!employee) {
      return res
        .status(400)
        .json({ message: "Code PIN incorrect. Veuillez réessayer." });
    }

    if (employee.role.name !== "employee") {
      return res
        .status(403)
        .json({ message: "Seuls les employés peuvent utiliser la pointeuse." });
    }

    const todayStr = getLocalDateString();
    const activePunch = await Timeclock.findOne({
      employee: employee._id,
      checkOut: null,
    });

    if (action === "arriver") {
      if (activePunch) {
        return res.status(400).json({
          message: `Vous êtes déjà arrivé ! Veuillez cliquer sur "Départ" pour terminer votre travail.`,
        });
      }

      const newPunch = new Timeclock({
        employee: employee._id,
        date: todayStr,
        checkIn: new Date(),
      });
      await newPunch.save();

      req.app.get("io").emit("timeclock_updated");

      return res.json({
        success: true,
        action: "arriver",
        message: "Bon service ! 👍",
        employee: { name: employee.name, avatar: employee.avatar },
        time: new Date().toLocaleTimeString("fr-FR", {
          hour: "2-digit",
          minute: "2-digit",
        }),
      });
    } else if (action === "depart") {
      if (!activePunch) {
        return res.status(400).json({
          message: `Vous n'êtes pas encore arrivé ! Veuillez d'abord cliquer sur "Arriver".`,
        });
      }

      const checkOutTime = new Date();
      const diffMs = checkOutTime - activePunch.checkIn;
      const totalMinutes = Math.floor(diffMs / 60000);

      activePunch.checkOut = checkOutTime;
      activePunch.totalMinutes = totalMinutes;
      await activePunch.save();

      req.app.get("io").emit("timeclock_updated");

      return res.json({
        success: true,
        action: "depart",
        message: "Bonne soirée ! 👋",
        employee: { name: employee.name, avatar: employee.avatar },
        time: checkOutTime.toLocaleTimeString("fr-FR", {
          hour: "2-digit",
          minute: "2-digit",
        }),
      });
    }
  }),
);


// ==========================================
// 1. STEP 1: VERIFY PIN, GPS, AND SCHEDULE ALIGNMENT [2]
// ==========================================
router.post('/verify', asyncHandler(async (req, res) => {
  const { pinCode, action, latitude, longitude } = req.body; // coordinates passed from client

  if (!pinCode || !action) {
    return res.status(400).json({ message: 'Le code PIN et l action sont requis.' });
  }

  // 1. Locate the employee by decrypting their stored PIN on the fly
  const users = await User.find({ pinCode: { $ne: null } }).populate('role');
  const employee = users.find(u => decrypt(u.pinCode) === pinCode);

  if (!employee) {
    return res.status(400).json({ message: 'Code PIN incorrect. Veuillez réessayer.' });
  }

  if (employee.role.name !== 'employee') {
    return res.status(403).json({ message: 'Seuls les employés peuvent utiliser la pointeuse.' });
  }

  // 🛑 2. GEOFENCING CHECK: Verify exact work location proximity [2]
  // We check if coordinates are passed (always sent by phones, optional for locked terminal tablet)
  if (latitude && longitude) {
    const settings = await Settings.findOne({ key: 'restaurant_config' });
    const targetLat = settings?.latitude;
    const targetLon = settings?.longitude;
    const maxRadius = settings?.allowedRadiusMeters || 100;

    // 🛑 If coordinates are blank/null in database, safely bypass geofencing completely! [2]
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
  // 🛑 3. SCHEDULE-ALIGNED EARLY PUNCH SAFEGUARDS (On 'arriver' only) [2]
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

    // Check if they are trying to clock in more than 3 minutes before their shift starts [2]
 
    // 🛑 1. TIMEZONE-IMMUNE CURRENT TIME: Force calculation in Europe/Paris timezone [1.1.4]
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

      if (diff >= -120 && diff < minDiff) { // Allow clocking in if up to 2 hours late, but check early clock-ins
        minDiff = diff;
        closestShiftStart = shift.startTime;
      }
    });

    // If the closest shift starts in more than 3 minutes, block them!
    if (minDiff > 3 && minDiff !== Infinity) {
      // 🛑 2. TIMEZONE-IMMUNE ALLOWED TIME CALCULATION: Pure integer math
      // Subtract 3 minutes from the shift start minutes and format directly (e.g. 180 - 3 = 177 mins = 02:57)
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
  // 🛑 4. CHECK FOUR-STEP WORKTIME LIFECYCLE LIMITS [2]
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

// ==========================================
// STEP 2: OFFICIALLY CONFIRM AND COMMIT PUNCH [2]
// ==========================================
router.post('/confirm', authenticateToken, asyncHandler(async (req, res) => {
  const { employeeId, action } = req.body;

  if (!employeeId || !action) {
    return res.status(400).json({ message: 'Données de confirmation manquantes.' });
  }

  const employee = await User.findById(employeeId);
  if (!employee) return res.status(404).json({ message: 'Employé introuvable.' });

  const todayStr = getLocalDateString();
  const activePunch = await Timeclock.findOne({ employee: employeeId, checkOut: null });

  // ------------------------------------------
  // 1. ARRIVAL ('arriver')
  // ------------------------------------------
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

  // ------------------------------------------
  // 2. START BREAK ('pause_start') [2]
  // ------------------------------------------
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

  // ------------------------------------------
  // 3. END BREAK ('pause_end') [2]
  // ------------------------------------------
  if (action === 'pause_end') {
    if (!activePunch || !activePunch.breakStart || activePunch.breakEnd) return res.status(400).json({ message: 'Action invalide.' });

    const endBreakTime = new Date();
    const breakDiffMs = endBreakTime - activePunch.breakStart;
    const actualBreakMinutes = Math.floor(breakDiffMs / 60000);

    activePunch.breakEnd = endBreakTime;
    activePunch.actualBreakMinutes = actualBreakMinutes;
    await activePunch.save();

    return res.json({
      success: true,
      action: 'pause_end',
      message: `Fin de pause ! Travail repris. (Durée: ${actualBreakMinutes} min)`,
      employee: { name: employee.name, avatar: employee.avatar },
      time: endBreakTime.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
    });
  }

  // ------------------------------------------
  // 4. DEPARTURE ('depart') [2]
  // ------------------------------------------
  if (action === 'depart') {
    if (!activePunch) return res.status(400).json({ message: 'Non enregistré.' });

    const checkOutTime = new Date();
    const diffMs = checkOutTime - activePunch.checkIn;
    const elapsedMinutes = Math.floor(diffMs / 60000);

    // 🛑 Subtract actual break minutes from total elapsed worked minutes [2]
    const finalMinutesWorked = Math.max(0, elapsedMinutes - activePunch.actualBreakMinutes);

    activePunch.checkOut = checkOutTime;
    activePunch.totalMinutes = finalMinutesWorked;
    await activePunch.save();

    req.app.get('io').emit('timeclock_updated'); // Update Admin dynamic dashboards [2]

    return res.json({
      success: true,
      action: 'depart',
      message: 'Bonne soirée ! 👋',
      employee: { name: employee.name, avatar: employee.avatar },
      time: checkOutTime.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
    });
  }
}));


// ==========================================
// . MANUALLY CREATE A TIMESHEET (With Break Subtraction) [2]
// ==========================================
router.post(
  "/admin/create",
  authenticateToken,
  requirePermission("employees:edit"),
  asyncHandler(async (req, res) => {
    const {
      employeeId,
      date,
      checkInTime,
      checkOutTime,
      breakMinutes,
      shiftType,
    } = req.body;

    if (!employeeId || !date || !shiftType) {
      return res
        .status(400)
        .json({
          message: "L employé, la date et le type de shift sont requis.",
        });
    }

    const employee = await User.findById(employeeId);
    if (!employee)
      return res.status(404).json({ message: "Employé introuvable." });

    let checkInDate = null;
    let checkOutDate = null;
    let totalMinutes = 0;

    // 🛑 Calculation Logic based on Shift Type [2]
    if (shiftType === "conge") {
      totalMinutes = 420; // Automatically credit 7 hours (420 mins) for Paid Leave
    } else if (shiftType === "repos") {
      totalMinutes = 0; // 0 hours for Day Off
    } else {
      // Standard Work Shift (Midi, Soir, or Double)
      if (!checkInTime || !checkOutTime) {
        return res
          .status(400)
          .json({
            message:
              "Les heures d arrivée et de départ sont requises pour un shift de travail.",
          });
      }

      checkInDate = new Date(`${date}T${checkInTime}:00`);
      checkOutDate = new Date(`${date}T${checkOutTime}:00`);

      if (checkOutDate <= checkInDate) {
        return res
          .status(400)
          .json({
            message: "L heure de départ doit être après l heure d arrivée.",
          });
      }

      const diffMinutes = Math.floor((checkOutDate - checkInDate) / 60000);
      // Subtract break minutes from total [2]
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
      isApproved: false,
    });

    await newTimesheet.save();
    req.app.get("io").emit("timeclock_updated");

    res
      .status(201)
      .json({
        message: "Fiche de temps créée manuellement.",
        timesheet: newTimesheet,
      });
  }),
);

router.put(
  "/admin/approve-all",
  authenticateToken,
  requirePermission("employees:edit"),
  asyncHandler(async (req, res) => {
    const { weekStartDate } = req.body;
    let query = { checkOut: { $ne: null }, isApproved: false };

    if (weekStartDate) {
      const dates = [];
      const startDate = new Date(weekStartDate);
      for (let i = 0; i < 7; i++) {
        const d = new Date(startDate);
        d.setDate(startDate.getDate() + i);
        dates.push(d.toLocaleDateString("fr-CA"));
      }
      query.date = { $in: dates };
    }

    const result = await Timeclock.updateMany(query, {
      isApproved: true,
      approvedBy: req.user.id,
    });

    req.app.get("io").emit("timeclock_updated");

    res.json({
      message: `${result.modifiedCount} fiches de temps ont été approuvées et verrouillées avec succès.`,
      modifiedCount: result.modifiedCount,
    });
  }),
);

// ==========================================
//MANUALLY EDIT/CORRECT A TIMESHEET (With Break Subtraction) [2]
// ==========================================
router.put(
  "/admin/:id",
  authenticateToken,
  requirePermission("employees:edit"),
  asyncHandler(async (req, res) => {
    const { checkInTime, checkOutTime, date, breakMinutes, shiftType } =
      req.body;

    const timesheet = await Timeclock.findById(req.params.id);
    if (!timesheet)
      return res.status(404).json({ message: "Fiche de temps introuvable." });

    if (timesheet.isApproved) {
      return res
        .status(400)
        .json({
          message: "Cette fiche est verrouillée et ne peut plus être modifiée.",
        });
    }

    const targetDateStr = date || timesheet.date;
    const targetShiftType = shiftType || timesheet.shiftType;

    let checkInDate = null;
    let checkOutDate = null;
    let totalMinutes = 0;

    // 🛑 Calculation Logic based on Shift Type [2]
    if (targetShiftType === "conge") {
      totalMinutes = 420; // 7 hours
    } else if (targetShiftType === "repos") {
      totalMinutes = 0;
    } else {
      // Standard Work Shift
      const activeCheckInTime =
        checkInTime ||
        (timesheet.checkIn
          ? new Date(timesheet.checkIn).toLocaleTimeString("fr-FR", {
              hour: "2-digit",
              minute: "2-digit",
            })
          : null);
      const activeCheckOutTime =
        checkOutTime ||
        (timesheet.checkOut
          ? new Date(timesheet.checkOut).toLocaleTimeString("fr-FR", {
              hour: "2-digit",
              minute: "2-digit",
            })
          : null);

      if (!activeCheckInTime || !activeCheckOutTime) {
        return res
          .status(400)
          .json({
            message: "Les heures d arrivée et de départ sont requises.",
          });
      }

      checkInDate = new Date(`${targetDateStr}T${activeCheckInTime}:00`);
      checkOutDate = new Date(`${targetDateStr}T${activeCheckOutTime}:00`);

      if (checkOutDate <= checkInDate) {
        return res
          .status(400)
          .json({
            message: "L heure de départ doit être après l heure d arrivée.",
          });
      }

      const diffMinutes = Math.floor((checkOutDate - checkInDate) / 60000);
      const activeBreak =
        breakMinutes !== undefined
          ? parseInt(breakMinutes)
          : timesheet.breakMinutes;
      totalMinutes = Math.max(0, diffMinutes - activeBreak);
    }

    // Save corrections
    timesheet.date = targetDateStr;
    timesheet.shiftType = targetShiftType;
    timesheet.checkIn = checkInDate;
    timesheet.checkOut = checkOutDate;
    timesheet.totalMinutes = totalMinutes;
    timesheet.breakMinutes =
      breakMinutes !== undefined
        ? parseInt(breakMinutes)
        : timesheet.breakMinutes;
    await timesheet.save();

    req.app.get("io").emit("timeclock_updated");

    res.json({ message: "Fiche de temps corrigée avec succès.", timesheet });
  }),
);

// ==========================================
// 2. UNLOCK A LOCKED TIMESHEET [1]
// ==========================================
router.put(
  "/admin/:id/unlock",
  authenticateToken,
  requirePermission("employees:edit"),
  asyncHandler(async (req, res) => {
    const timesheet = await Timeclock.findById(req.params.id);
    if (!timesheet)
      return res.status(404).json({ message: "Fiche introuvable." });

    timesheet.isApproved = false;
    timesheet.approvedBy = null; // Clear approval track
    await timesheet.save();

    req.app.get("io").emit("timeclock_updated"); // Trigger real-time dashboard updates [2]

    res.json({ message: "Fiche de temps déverrouillée.", timesheet });
  }),
);

// ==========================================
// 3. DELETE A TIMESHEET [1]
// ==========================================
router.delete(
  "/admin/:id",
  authenticateToken,
  requirePermission("employees:delete"),
  asyncHandler(async (req, res) => {
    const timesheet = await Timeclock.findById(req.params.id);
    if (!timesheet)
      return res.status(404).json({ message: "Fiche introuvable." });

    // Safety block: Prevent deleting approved payroll records [1]
    if (timesheet.isApproved) {
      return res
        .status(400)
        .json({ message: "Impossible de supprimer une fiche verrouillée." });
    }

    await Timeclock.findByIdAndDelete(req.params.id);
    req.app.get("io").emit("timeclock_updated"); // Trigger real-time dashboard updates [2]

    res.json({ message: "Fiche de temps supprimée avec succès." });
  }),
);

module.exports = router;
