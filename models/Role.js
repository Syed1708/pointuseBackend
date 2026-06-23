const mongoose = require('mongoose');

const roleSchema = new mongoose.Schema({
  name: { 
    type: String, 
    required: true, 
    unique: true, 
    trim: true 
  },
  // Array of privileges, e.g., ["employees:create", "schedules:edit"]
  permissions: { 
    type: [String], 
    default: [] 
  }
}, { timestamps: true });

module.exports = mongoose.model('Role', roleSchema);