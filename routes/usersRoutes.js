const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Role = require('../models/Role');
const { authenticateToken, requirePermission } = require('../middleware/auth');

// ==========================================
// 1. CREATE NEW USER (Admins & Managers)
// ==========================================
router.post('/', 
  authenticateToken, 
  requirePermission('employees:create'), 
  async (req, res) => {
    try {
      const { name, email, password, role, pinCode } = req.body;
      const currentUserId = req.user.id;

      // Checkpoint 3: Resource Safeguards
      const currentUser = await User.findById(currentUserId).populate('role');
      const targetRoleObj = await Role.findById(role);

      if (!targetRoleObj) {
        return res.status(404).json({ message: 'Selected role does not exist.' });
      }

      // Rule: Non-admins cannot assign the 'admin' role to new users
      if (targetRoleObj.name === 'admin' && currentUser.role.name !== 'admin') {
        return res.status(403).json({ message: 'Only Admins can assign the Admin role.' });
      }

      const userExists = await User.findOne({ email });
      if (userExists) {
        return res.status(400).json({ message: 'Email already registered.' });
      }

      const newUser = new User({ name, email, password, role, pinCode });
      await newUser.save();

      res.status(201).json({
        message: 'User created successfully.',
        user: { id: newUser._id, name: newUser.name, email: newUser.email, role: targetRoleObj.name }
      });
    } catch (err) {
      res.status(500).json({ message: 'Server error', error: err.message });
    }
  }
);

// ==========================================
// 2. GET ALL USERS (Admins & Managers)
// ==========================================
router.get('/', 
  authenticateToken, 
  requirePermission('employees:view'), 
  async (req, res) => {
    
    try {
      // Find all users and pull their related role documents
      const users = await User.find()
        .select('-password -refreshToken')
        .populate('role', 'name'); // Populates role name instead of just showing ID
      
      res.json(users);
    } catch (err) {
      res.status(500).json({ message: 'Server error', error: err.message });
    }
  }
);

// ==========================================
// 3. GET SINGLE USER (Admins, Managers OR Self)
// ==========================================
router.get('/:id', 
  authenticateToken, 
  async (req, res) => {
    try {
      const targetUserId = req.params.id;
      const currentUserId = req.user.id;

      const currentUser = await User.findById(currentUserId).populate('role');
      const hasViewPermission = currentUser.role.permissions.includes('employees:view');
      const isSelf = currentUserId === targetUserId;

      // Checkpoint 2 & 3 Combined: Block if not self and no global view permission
      if (!hasViewPermission && !isSelf) {
        return res.status(403).json({ 
          message: 'Access denied: You can only view your own profile.' 
        });
      }

      const user = await User.findById(targetUserId)
        .select('-password -refreshToken')
        .populate('role', 'name');

      if (!user) {
        return res.status(404).json({ message: 'User not found.' });
      }

      res.json(user);
    } catch (err) {
      res.status(500).json({ message: 'Server error', error: err.message });
    }
  }
);

// ==========================================
// 4. UPDATE USER (Admins, Managers OR Self)
// ==========================================
router.put('/:id', 
  authenticateToken, 
  async (req, res) => {
    try {
      const targetUserId = req.params.id;
      const currentUserId = req.user.id;
      const { name, email, role, pinCode } = req.body;

      const currentUser = await User.findById(currentUserId).populate('role');
      const hasEditPermission = currentUser.role.permissions.includes('employees:edit');
      const isSelf = currentUserId === targetUserId;

      // Checkpoint 2: Validate authority
      if (!hasEditPermission && !isSelf) {
        return res.status(403).json({ 
          message: 'Access denied: You can only edit your own profile.' 
        });
      }

      const targetUser = await User.findById(targetUserId).populate('role');
      if (!targetUser) {
        return res.status(404).json({ message: 'User not found.' });
      }

      // Checkpoint 3: Resource Safeguards (Business Logic Rules)

      // Rule A: Prevent users from updating their own role
      if (isSelf && role && role !== targetUser.role._id.toString()) {
        return res.status(403).json({ message: 'You cannot change your own role.' });
      }

      // Rule B: Protect Admin users from being modified by non-admins
      if (!isSelf && targetUser.role.name === 'admin' && currentUser.role.name !== 'admin') {
        return res.status(403).json({ message: 'Managers cannot edit Admin accounts.' });
      }

      // Rule C: Prevent non-admins from upgrading anyone to the 'admin' role
      if (role && currentUser.role.name !== 'admin') {
        const targetRoleObj = await Role.findById(role);
        if (targetRoleObj && targetRoleObj.name === 'admin') {
          return res.status(403).json({ message: 'Only Admins can assign the Admin role.' });
        }
      }

      // Apply modifications
      if (name) targetUser.name = name;
      if (email) targetUser.email = email;
      if (pinCode) targetUser.pinCode = pinCode;
      if (role && !isSelf) targetUser.role = role; // Prevent role modifications if modifying self

      await targetUser.save();

      res.json({
        message: 'User updated successfully.',
        user: { id: targetUser._id, name: targetUser.name, email: targetUser.email, role: targetUser.role.name }
      });
    } catch (err) {
      res.status(500).json({ message: 'Server error', error: err.message });
    }
  }
);

// ==========================================
// 5. DELETE USER (Admins Only)
// ==========================================
router.delete('/:id', 
  authenticateToken, 
  requirePermission('employees:delete'), 
  async (req, res) => {
    try {
      const targetUserId = req.params.id;
      const currentUserId = req.user.id;

      // Checkpoint 3: Resource Safeguards

      // Rule A: Prevent self-deletion
      if (currentUserId === targetUserId) {
        return res.status(400).json({ message: 'You cannot delete your own account.' });
      }

      const targetUser = await User.findById(targetUserId).populate('role');
      if (!targetUser) {
        return res.status(404).json({ message: 'User not found.' });
      }

      // Rule B: Administrative accounts cannot be deleted
      if (targetUser.role && targetUser.role.name === 'admin') {
        return res.status(403).json({ message: 'Administrative accounts cannot be deleted.' });
      }

      await User.findByIdAndDelete(targetUserId);

      res.json({ message: `User ${targetUser.name} was successfully deleted.` });
    } catch (err) {
      res.status(500).json({ message: 'Server error', error: err.message });
    }
  }
);

module.exports = router;