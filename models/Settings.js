const mongoose = require('mongoose');

const settingsSchema = new mongoose.Schema({
  key: { 
    type: String, 
    default: 'restaurant_config', 
    unique: true 
  }, // Singleton key to ensure we only ever have 1 configuration document
  name: { type: String, default: 'Sushi Pointuse' },
  address: { type: String, default: '123 Rue de la Paix, 75002 Paris' },
  logo: { type: String, default: null },
  latitude: { type: Number, default: null }, // Null by default = Bypassed! [2]
  longitude: { type: Number, default: null }, // Null by default = Bypassed! [2]
  allowedRadiusMeters: { type: Number, default: 100 }
}, { timestamps: true });

module.exports = mongoose.model('Settings', settingsSchema);