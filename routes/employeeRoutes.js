const express = require("express");
const router = express.Router();
const User = require("../models/User");
const Role = require("../models/Role");
const { authenticateToken, requirePermission } = require("../middleware/auth");
const { decrypt } = require("../helpers/cryptoHelper");

// ==========================================
// 1. GET ALL EMPLOYEES (With Search, Pagination & Decryption)
// ==========================================
router.get(
  "/",
  authenticateToken,
  requirePermission("employees:view"),
  async (req, res) => {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 10;
      const search = req.query.search || "";

      // Find the 'employee' role document first
      const employeeRole = await Role.findOne({ name: "employee" });
      if (!employeeRole) {
        return res.json({ docs: [], totalPages: 0, totalDocs: 0, page });
      }

      // Filter query: only fetch users with the 'employee' role ID
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
    } catch (err) {
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },
);

// ==========================================
// 2. CREATE EMPLOYEE (Automatically assigns 'employee' Role)
// ==========================================
router.post(
  "/create",
  authenticateToken,
  requirePermission("employees:create"),
  async (req, res) => {
    try {
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
    } catch (err) {
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },
);

module.exports = router;
