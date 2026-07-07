const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Role = require('../models/Role');
const { authenticateToken, requirePermission } = require('../middleware/auth');
const { decrypt } = require('../helpers/cryptoHelper');
const asyncHandler = require('../helpers/asyncHandler'); // 🛑 Import the centralized async wrapper [2]

// ==========================================
// 1. GET ALL EMPLOYEES (With Search, Pagination & Decryption) [3]
// ==========================================
router.get(
  "/",
  authenticateToken,
  requirePermission("employees:view"),
  asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || "";

    // Find the 'employee' role document first
    const employeeRole = await Role.findOne({ name: "employee" });
    if (!employeeRole) {
      return res.json({ docs: [], totalPages: 0, totalDocs: 0, page });
    }

    // Filter query: only fetch users with the 'employee' role ID [2]
    let query = { role: employeeRole._id };

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
      ];
    }

    const totalDocs = await User.countDocuments(query);
    const totalPages = Math.ceil(totalDocs / limit);
    const skip = (page - 1) * limit;

    const employees = await User.find(query)
      .select("-password -refreshToken")
      .populate("role", "name")
      .skip(skip)
      .limit(limit);

    // Decrypt PIN codes [2]
    const decryptedEmployees = employees.map((u) => {
      const userObj = u.toObject();
      userObj.pinCode = decrypt(u.pinCode) || "";
      return userObj;
    });

    res.json({
      docs: decryptedEmployees,
      totalPages,
      totalDocs,
      page,
    });
  })
);

// ==========================================
//  GET COLLEAGUES LIST (Names & Avatars only for Shift Swaps - NO permission required!) [2]
// ==========================================
router.get('/colleagues', authenticateToken, asyncHandler(async (req, res) => {
  // Find the 'employee' role document first
  const employeeRole = await Role.findOne({ name: 'employee' });
  if (!employeeRole) return res.json([]);

  // Fetch only active employees, excluding the logged-in user's own profile [2]
  const colleagues = await User.find({
    role: employeeRole._id,
    _id: { $ne: req.user.id } // 🛑 Exclude current user from the swap list! [2]
  }).select('name avatar'); // 🛑 CRITICAL: Only retrieve name and avatar fields [2]

  res.json(colleagues);
}));

// ==========================================
// 2. CREATE EMPLOYEE (Automatically assigns 'employee' Role) [2]
// ==========================================
router.post(
  "/create",
  authenticateToken,
  requirePermission("employees:create"),
  asyncHandler(async (req, res) => {
    const { name, email, password, pinCode, contractHours } = req.body;

    console.log("Received employee creation request:", {
      name,
      email,
      password,
      pinCode,
      contractHours,
    });

    // Auto-resolve the employee role from the database
    const employeeRole = await Role.findOne({ name: "employee" });
    if (!employeeRole) {
      return res
        .status(400)
        .json({ message: "Default Employee role not found in system." });
    }

    const userExists = await User.findOne({ email });
    if (userExists) {
      return res.status(400).json({ message: "Email already registered." });
    }

    const newEmployee = new User({
      name,
      email,
      password,
      role: employeeRole._id, // 🛑 Auto-assigned!
      contractHours: contractHours ? parseInt(contractHours) : 35,
      pinCode,
    });

    await newEmployee.save();

    req.app.get('io').emit('user_updated'); // 🔌 Broadcast
    
    res.status(201).json({
      message: "Employee created successfully.",
      user: {
        id: newEmployee._id,
        name: newEmployee.name,
        email: newEmployee.email,
        contractHours: newEmployee.contractHours,
        pinCode: decrypt(newEmployee.pinCode) || "",
      },
    });
  })
);

module.exports = router;