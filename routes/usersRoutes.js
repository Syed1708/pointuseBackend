const express = require("express");
const router = express.Router();
const User = require("../models/User");
const Role = require("../models/Role");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const { authenticateToken, requirePermission } = require("../middleware/auth");
const { decrypt } = require("../helpers/cryptoHelper");
const asyncHandler = require("../helpers/asyncHandler"); // 🛑 Import the centralized async wrapper [2]
const API_URL = import.meta.env.VITE_API_URL;

// ==========================================
// 1. CREATE NEW USER (Admins & Managers)
// ==========================================
router.post(
  "/create",
  authenticateToken,
  requirePermission("employees:create"),
  asyncHandler(async (req, res) => {
    const { name, email, password, role, pinCode, contractHours } = req.body;
    const currentUserId = req.user.id;

    // Checkpoint 3: Resource Safeguards
    const currentUser = await User.findById(currentUserId).populate("role");
    const targetRoleObj = await Role.findById(role);

    if (!targetRoleObj) {
      return res.status(404).json({ message: "Selected role does not exist." });
    }

    // Rule: Non-admins cannot assign the 'admin' role to new users
    if (targetRoleObj.name === "admin" && currentUser.role.name !== "admin") {
      return res.status(403).json({ message: "Only Admins can assign the Admin role." });
    }

    const userExists = await User.findOne({ email });
    if (userExists) {
      return res.status(400).json({ message: "Email already registered." });
    }

    const newUser = new User({
      name,
      email,
      password,
      role,
      pinCode,
      contractHours: contractHours ? parseInt(contractHours) : 35,
    });
    await newUser.save();

    req.app.get('io').emit('user_updated'); // 🔌 Broadcast

    res.status(201).json({
      message: "User created successfully.",
      user: {
        id: newUser._id,
        name: newUser.name,
        email: newUser.email,
        role: targetRoleObj.name,
        contractHours: newUser.contractHours,
      },
    });
  })
);

// ==========================================
// 2. GET ALL USERS with Pagination, Search & Filter (Admins & Managers) [3]
// ==========================================
router.get(
  "/",
  authenticateToken,
  requirePermission("employees:view"),
  asyncHandler(async (req, res) => {
    // 1. Get Query Parameters from Frontend [3]
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || "";
    const filterRole = req.query.filter || ""; // Stores Role ID if chosen

    // 2. Build the Query Filter Object [3]
    let query = {};

    // If search query is provided, search by Name or Email (case-insensitive)
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
      ];
    }

    // If role filter is selected, filter by role ID
    if (filterRole) {
      query.role = filterRole;
    }

    // 3. Query Database with Pagination limits
    const totalDocs = await User.countDocuments(query);
    const totalPages = Math.ceil(totalDocs / limit);
    const skip = (page - 1) * limit;

    const users = await User.find(query)
      .select("-password -refreshToken")
      .populate("role", "name")
      .skip(skip)
      .limit(limit);

    // Decrypt PINs on the fly [2]
    const decryptedUsers = users.map((u) => {
      const userObj = u.toObject();
      userObj.pinCode = decrypt(u.pinCode) || "";
      return userObj;
    });

    // 4. Return standard Pagination response payload [3]
    res.json({
      docs: decryptedUsers,
      totalPages,
      totalDocs,
      page,
    });
  })
);

// =========================================================
// 2.5 GET CURRENT LOGGED-IN PROFILE (MUST BE ABOVE /:id) [2]
// =========================================================
router.get(
  "/profile", 
  authenticateToken, 
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.user.id)
      .select("-password -refreshToken -pinCode")
      .populate("role"); // Populates full dynamic role permissions

    if (!user) {
      return res.status(404).json({ message: "User profile not found." });
    }

    res.json(user);
  })
);

// ==========================================
// 3. GET SINGLE USER (Admins, Managers OR Self) [2]
// ==========================================
router.get(
  "/:id", 
  authenticateToken, 
  asyncHandler(async (req, res) => {
    const targetUserId = req.params.id;
    const currentUserId = req.user.id;

    const currentUser = await User.findById(currentUserId).populate("role");
    const hasViewPermission = currentUser.role.permissions.includes("employees:view");
    const isSelf = currentUserId === targetUserId;

    // Checkpoint 2 & 3 Combined: Block if not self and no global view permission
    if (!hasViewPermission && !isSelf) {
      return res.status(403).json({
        message: "Access denied: You can only view your own profile.",
      });
    }

    const user = await User.findById(targetUserId)
      .select("-password -refreshToken")
      .populate("role", "name");

    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    res.json(user);
  })
);

// ==========================================
// 4. UPDATE USER (Admins, Managers OR Self) [2]
// ==========================================
router.put(
  "/:id", 
  authenticateToken, 
  asyncHandler(async (req, res) => {
    const targetUserId = req.params.id;
    const currentUserId = req.user.id;
    const { name, email, role, pinCode, contractHours } = req.body;

    const currentUser = await User.findById(currentUserId).populate("role");
    const hasEditPermission = currentUser.role.permissions.includes("employees:edit");
    const isSelf = currentUserId === targetUserId;

    // Checkpoint 2: Validate authority
    if (!hasEditPermission && !isSelf) {
      return res.status(403).json({
        message: "Access denied: You can only edit your own profile.",
      });
    }

    const targetUser = await User.findById(targetUserId).populate("role");
    if (!targetUser) {
      return res.status(404).json({ message: "User not found." });
    }

    // Checkpoint 3: Resource Safeguards (Business Logic Rules)

    // Rule A: Prevent users from updating their own role
    if (isSelf && role && role !== targetUser.role._id.toString()) {
      return res.status(403).json({ message: "You cannot change your own role." });
    }

    // Rule B: Protect Admin users from being modified by non-admins
    if (!isSelf && targetUser.role.name === "admin" && currentUser.role.name !== "admin") {
      return res.status(403).json({ message: "Managers cannot edit Admin accounts." });
    }

    // Rule C: Prevent non-admins from upgrading anyone to the 'admin' role
    if (role && currentUser.role.name !== "admin") {
      const targetRoleObj = await Role.findById(role);
      if (targetRoleObj && targetRoleObj.name === "admin") {
        return res.status(403).json({ message: "Only Admins can assign the Admin role." });
      }
    }

    // Apply modifications
    if (name) targetUser.name = name;
    if (email) targetUser.email = email;
    
    // Only assign if a new PIN was provided (ignoring empty skips)
    if (pinCode && pinCode.trim() !== "") {
      targetUser.pinCode = pinCode;
    }
    if (contractHours !== undefined) {
      targetUser.contractHours = parseInt(contractHours);
    }
    if (role && !isSelf) targetUser.role = role; // Prevent role modifications if modifying self

    await targetUser.save();

    req.app.get('io').emit('user_updated'); // 🔌 Broadcast

    res.json({
      message: "User updated successfully.",
      user: {
        id: targetUser._id,
        name: targetUser.name,
        email: targetUser.email,
        role: targetUser.role.name,
        contractHours: targetUser.contractHours,
        pinCode: decrypt(targetUser.pinCode) || "",
        avatar: targetUser.avatar,
      },
    });
  })
);

// ==========================================
// 5. DELETE USER (Admins Only)
// ==========================================
router.delete(
  "/:id",
  authenticateToken,
  requirePermission("employees:delete"),
  asyncHandler(async (req, res) => {
    const targetUserId = req.params.id;
    const currentUserId = req.user.id;

    // Checkpoint 3: Resource Safeguards

    // Rule A: Prevent self-deletion
    if (currentUserId === targetUserId) {
      return res.status(400).json({ message: "You cannot delete your own account." });
    }

    const targetUser = await User.findById(targetUserId).populate("role");
    if (!targetUser) {
      return res.status(404).json({ message: "User not found." });
    }

    // Rule B: Administrative accounts cannot be deleted
    if (targetUser.role && targetUser.role.name === "admin") {
      return res.status(403).json({ message: "Administrative accounts cannot be deleted." });
    }

    await User.findByIdAndDelete(targetUserId);
    req.app.get('io').emit('user_updated'); // 🔌 Broadcast
    
    res.json({
      message: `User ${targetUser.name} was successfully deleted.`,
    });
  })
);

// ==========================================
// 6. CHANGE PASSWORD (Authenticated Users)
// ==========================================
router.post(
  "/change-password", 
  authenticateToken, 
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body;

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    // Verify current password is valid
    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
      return res.status(400).json({ message: "Current password is incorrect." });
    }

    // Apply new password (pre-save hook will automatically hash it)
    user.password = newPassword;
    await user.save();

    res.json({ message: "Password changed successfully." });
  })
);

// Multer Disk Storage Configuration [3]
const uploadDir = path.join(__dirname, "../uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true }); // Automatically creates folder if missing
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, "avatar-" + uniqueSuffix + path.extname(file.originalname));
  },
});

const fileFilter = (req, file, cb) => {
  if (file.mimetype.startsWith("image/")) {
    cb(null, true);
  } else {
    cb(new Error("Only image files are allowed!"), false);
  }
};

const upload = multer({ storage, fileFilter });

// ==========================================
// 7. UPLOAD AVATAR (With automatic cleanup of old files) [3]
// ==========================================
router.post(
  "/upload-avatar",
  authenticateToken,
  upload.single("avatar"),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded." });
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      if (fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      return res.status(404).json({ message: "User not found." });
    }

    // Delete the previous avatar file if it exists on disk [3]
    if (user.avatar) {
      try {
        if (user.avatar.includes("/uploads/")) {
          const oldFilename = user.avatar.split("/uploads/")[1];
          const oldFilePath = path.join(__dirname, "../uploads", oldFilename);

          if (fs.existsSync(oldFilePath)) {
            fs.unlinkSync(oldFilePath);
            console.log(`🗑️ Successfully deleted old avatar file: ${oldFilename}`);
          }
        }
      } catch (deleteError) {
        console.error("Error cleaning up previous avatar file:", deleteError.message);
      }
    }

    // Save the new avatar URL
    const avatarUrl = `http://localhost:5001/uploads/${req.file.filename}`;
    user.avatar = avatarUrl;
    await user.save();

    res.json({
      message: "Profile picture updated successfully.",
      avatar: avatarUrl,
    });
  })
);

module.exports = router;