const express = require("express");
const router = express.Router();
const User = require("../models/User");
const Timeclock = require("../models/Timeclock");
const { decrypt } = require("../helpers/cryptoHelper");
const { authenticateToken, requirePermission } = require("../middleware/auth");
const asyncHandler = require("../helpers/asyncHandler");
const WeeklySchedule = require("../models/WeeklySchedule");
const Role = require("../models/Role");
const { pinVerifyLimiter } = require('../middleware/rateLimiter');

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
// STEP 1: VERIFY PIN & RETRIEVE IDENTITY
// ==========================================
router.post(
  "/verify",
    pinVerifyLimiter,
  authenticateToken,
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

    const activePunch = await Timeclock.findOne({
      employee: employee._id,
      checkOut: null,
    });

    if (action === "arriver" && activePunch) {
      return res.status(400).json({
        message: `Vous êtes déjà arrivé ! Veuillez cliquer sur "Départ" pour terminer votre travail.`,
      });
    }

    if (action === "depart" && !activePunch) {
      return res.status(400).json({
        message: `Vous n'êtes pas encore arrivé ! Veuillez d'abord cliquer sur "Arriver".`,
      });
    }

    res.json({
      employee: {
        id: employee._id,
        name: employee.name,
        avatar: employee.avatar,
      },
      action,
    });
  }),
);

// ==========================================
// STEP 2: OFFICIALLY CONFIRM AND COMMIT PUNCH
// ==========================================
router.post(
  "/confirm",
  asyncHandler(async (req, res) => {
    const { employeeId, action } = req.body;

    if (!employeeId || !action) {
      return res
        .status(400)
        .json({ message: "Données de confirmation manquantes." });
    }

    const employee = await User.findById(employeeId);
    if (!employee) {
      return res.status(404).json({ message: "Employé introuvable." });
    }

    const todayStr = getLocalDateString();
    const activePunch = await Timeclock.findOne({
      employee: employeeId,
      checkOut: null,
    });

    if (action === "arriver") {
      if (activePunch)
        return res.status(400).json({ message: "Déjà enregistré." });

      const newPunch = new Timeclock({
        employee: employeeId,
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
      if (!activePunch)
        return res.status(400).json({ message: "Non enregistré." });

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
