const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Timeclock = require('../models/Timeclock');
const { decrypt } = require('../helpers/cryptoHelper');
const asyncHandler = require('../helpers/asyncHandler');

// Helper: Get YYYY-MM-DD in local timezone safely
const getLocalDateString = () => {
  return new Date().toLocaleDateString('fr-CA'); // "YYYY-MM-DD"
};

// ==========================================
// STEP 1: VERIFY PIN & RETRIEVE IDENTITY [2]
// ==========================================
router.post('/verify', asyncHandler(async (req, res) => {
  const { pinCode, action } = req.body; // action: 'arriver' or 'depart'

  if (!pinCode || !action) {
    return res.status(400).json({ message: 'Le code PIN et l action sont requis.' });
  }

  // 1. Locate the employee by decrypting their stored PIN on the fly
  const users = await User.find({ pinCode: { $ne: null } }).populate('role');
  const employee = users.find(u => decrypt(u.pinCode) === pinCode);

  if (!employee) {
    return res.status(400).json({ message: 'Code PIN incorrect. Veuillez réessayer.' });
  }

  // Ensure only standard employees can use the timeclock
  if (employee.role.name !== 'employee') {
    return res.status(403).json({ message: 'Seuls les employés peuvent utiliser la pointeuse.' });
  }

  const activePunch = await Timeclock.findOne({ employee: employee._id, checkOut: null });

  // 🛑 Block invalid check-in / check-out states [2]
  if (action === 'arriver' && activePunch) {
    return res.status(400).json({ 
      message: `Vous êtes déjà arrivé ! Veuillez cliquer sur "Départ" pour terminer votre travail.` 
    });
  }

  if (action === 'depart' && !activePunch) {
    return res.status(400).json({ 
      message: `Vous n'êtes pas encore arrivé ! Veuillez d'abord cliquer sur "Arriver".` 
    });
  }

  // If validation passes, return employee details for visual verification on the screen [2]
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
router.post('/confirm', asyncHandler(async (req, res) => {
  const { employeeId, action } = req.body;

  if (!employeeId || !action) {
    return res.status(400).json({ message: 'Données de confirmation manquantes.' });
  }

  const employee = await User.findById(employeeId);
  if (!employee) {
    return res.status(404).json({ message: 'Employé introuvable.' });
  }

  const todayStr = getLocalDateString();
  const activePunch = await Timeclock.findOne({ employee: employeeId, checkOut: null });

  // ------------------------------------------
  // RECORD ARRIVAL ('arriver')
  // ------------------------------------------
  if (action === 'arriver') {
    if (activePunch) return res.status(400).json({ message: 'Déjà enregistré.' });

    const newPunch = new Timeclock({
      employee: employeeId,
      date: todayStr,
      checkIn: new Date()
    });
    await newPunch.save();

    req.app.get('io').emit('timeclock_updated'); // Trigger live counter refresh [2]

    return res.json({
      success: true,
      action: 'arriver',
      message: 'Bon service ! 👍',
      employee: { name: employee.name, avatar: employee.avatar },
      time: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
    });
  }

  // ------------------------------------------
  // RECORD DEPARTURE ('depart')
  // ------------------------------------------
  else if (action === 'depart') {
    if (!activePunch) return res.status(400).json({ message: 'Non enregistré.' });

    const checkOutTime = new Date();
    const diffMs = checkOutTime - activePunch.checkIn;
    const totalMinutes = Math.floor(diffMs / 60000);

    activePunch.checkOut = checkOutTime;
    activePunch.totalMinutes = totalMinutes;
    await activePunch.save();

    req.app.get('io').emit('timeclock_updated'); // Trigger live counter refresh [2]

    return res.json({
      success: true,
      action: 'depart',
      message: 'Bonne soirée ! 👋',
      employee: { name: employee.name, avatar: employee.avatar },
      time: checkOutTime.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
    });
  }
}));

module.exports = router;