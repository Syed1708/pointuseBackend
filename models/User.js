const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const { encrypt, decrypt } = require("../helpers/cryptoHelper"); // Import helper

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, lowercase: true },
    password: { type: String, required: true },
    // Reference to the dynamic Role model
    role: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Role",
      required: true,
    },
    // 4 to 6-digit confidential code for mobile clock-in (hashed)
    // pinCode: { type: String, default: null },
    // 🛑 UPDATE THIS FIELD:
    pinCode: {
      type: String,
      default: null,
      unique: true, // 🛑 Prevents any two employees from having the same PIN
      sparse: true, // 🛑 CRUCIAL: Allows multiple users (like Admins) to have 'null' PINs safely [1, 2]
    },
    refreshToken: { type: String, default: null },
    // 🛑 ADD THIS FIELD:
    avatar: { type: String, default: null },
     // 🛑 ADD THIS FIELD:
    contractHours: { type: Number } 
  },
  { timestamps: true },
);

// Hash the password before saving (Modern async/await syntax)
userSchema.pre("save", async function () {
  if (!this.isModified("password")) return; // No "next()" needed, just return

  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
  } catch (err) {
    throw new Error(err); // Throwing an error will automatically reject the save
  }
});

// 🛑 AUTOMATICALLY ENCRYPT PIN CODE ON SAVE
userSchema.pre("save", async function () {
  if (!this.isModified("pinCode") || !this.pinCode) return;
  try {
    // Save the encrypted version in MongoDB
    this.pinCode = encrypt(this.pinCode);
  } catch (err) {
    throw new Error(err);
  }
});

// Methods to compare credentials
userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

// 🛑 DECRYPT AND COMPARE FOR POINTAGE
userSchema.methods.comparePin = async function (candidatePin) {
  const decryptedPin = decrypt(this.pinCode);
  return candidatePin === decryptedPin; // Compare plain-text values
};

module.exports = mongoose.model("User", userSchema);
