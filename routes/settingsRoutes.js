const express = require('express');
const router = express.Router();
const Settings = require('../models/Settings');
const { authenticateToken, requirePermission } = require('../middleware/auth');
const asyncHandler = require('../helpers/asyncHandler');
const multer = require('multer');
const path = require('path');
const fs = require('fs');


// 🛑 Safe helper to parse coordinates, handling null, empty strings, and NaN [2]
const parseCoordinate = (val) => {
  if (val === undefined || val === null || val === '') return null;
  const parsed = parseFloat(val);
  return isNaN(parsed) ? null : parsed;
};

// Helper: Ensure default settings document exists
const getOrCreateSettings = async () => {
  let settings = await Settings.findOne({ key: 'restaurant_config' });
  if (!settings) {
    settings = new Settings({ key: 'restaurant_config' });
    await settings.save();
  }
  return settings;
};

// 1. GET CURRENT SETTINGS (Accessible to any logged-in user to show logo/name in layout)
router.get('/', authenticateToken, asyncHandler(async (req, res) => {
  const settings = await getOrCreateSettings();
  res.json(settings);
}));

// 2. UPDATE SETTINGS (Admin Only) [2]
router.put('/', authenticateToken, requirePermission('employees:edit'), asyncHandler(async (req, res) => {
  const { name, address, latitude, longitude, allowedRadiusMeters } = req.body;
  
  const settings = await getOrCreateSettings();
  
  if (name) settings.name = name;
  if (address) settings.address = address;
  
   // 🛑 FIXED: Use our safe coordinate parser to prevent NaN database errors [2]
  settings.latitude = parseCoordinate(latitude);
  settings.longitude = parseCoordinate(longitude);
  
  if (allowedRadiusMeters !== undefined) {
    settings.allowedRadiusMeters = parseInt(allowedRadiusMeters) || 100;
  }

  await settings.save();

  // Broadcast WebSocket update [2]
  req.app.get('io').emit('settings_updated');

  res.json({ message: 'Configuration mise à jour.', settings });
}));

// Multer Storage Setup for Logo [3]
const uploadDir = path.join(__dirname, '../uploads');
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `logo-restaurant-${Date.now()}${ext}`);
  }
});
const upload = multer({ storage });

// 3. UPLOAD LOGO (Admin Only) [2, 3]
router.post('/logo', authenticateToken, requirePermission('employees:edit'), upload.single('logo'), asyncHandler(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'Aucun fichier logo envoyé.' });
  }

  const settings = await getOrCreateSettings();

  // Cleanup old logo from disk [2, 3]
  if (settings.logo && settings.logo.includes('/uploads/')) {
    try {
      const oldFilename = settings.logo.split('/uploads/')[1];
      const oldFilePath = path.join(__dirname, '../uploads', oldFilename);
      if (fs.existsSync(oldFilePath)) {
        fs.unlinkSync(oldFilePath);
      }
    } catch (e) {
      console.error('Error deleting old logo:', e.message);
    }
  }

  const logoUrl = `http://localhost:5001/uploads/${req.file.filename}`;
  settings.logo = logoUrl;
  await settings.save();

  req.app.get('io').emit('settings_updated');

  res.json({ message: 'Logo mis à jour avec succès.', logo: logoUrl });
}));

module.exports = router;