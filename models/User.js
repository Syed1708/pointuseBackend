const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true },
  password: { type: String, required: true },
  // Reference to the dynamic Role model
  role: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Role', 
    required: true 
  },
  // 4 to 6-digit confidential code for mobile clock-in (hashed)
  pinCode: { type: String, default: null }, 
  refreshToken: { type: String, default: null },
}, { timestamps: true });

// Hash the password before saving (Modern async/await syntax)
userSchema.pre('save', async function() {
  if (!this.isModified('password')) return; // No "next()" needed, just return
  
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
  } catch (err) {
    throw new Error(err); // Throwing an error will automatically reject the save
  }
});

// Hash the PIN code if it is set or updated
userSchema.pre('save', async function() {
  if (!this.isModified('pinCode') || !this.pinCode) return; // No "next()" needed
  
  try {
    const salt = await bcrypt.genSalt(10);
    this.pinCode = await bcrypt.hash(this.pinCode, salt);
  } catch (err) {
    throw new Error(err);
  }
});

// Methods to compare credentials
userSchema.methods.comparePassword = async function(candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

userSchema.methods.comparePin = async function(candidatePin) {
  return bcrypt.compare(candidatePin, this.pinCode);
};

module.exports = mongoose.model('User', userSchema);