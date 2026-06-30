const express = require('express');
const router = express.Router();

const Role = require('../models/Role');
const User = require('../models/User');
const { authenticateToken, requirePermission } = require('../middleware/auth');
const asyncHandler = require('../helpers/asyncHandler');// 🛑 Import the centralized async wrapper [2]

// ==========================================
// 1. CREATE NEW ROLE (Admins & Managers)
// ==========================================
router.post('/', 
  authenticateToken, 
  requirePermission('employees:create'), 
  asyncHandler(async (req, res) => {
    const { name, permissions } = req.body;
    console.log('Creating role with name:', name, 'and permissions:', permissions);
    const currentUserId = req.user.id;
    console.log('Current user ID:', currentUserId);

    const formattedName = name.toLowerCase().trim();

    // Checkpoint 3: Resource Safeguards
    const roleExists = await Role.findOne({ name: formattedName });
    if (roleExists) {
      return res.status(400).json({ message: 'Role already exists.' });
    }

    // Rule A: Prevent Privilege Escalation
    // Non-admins cannot assign privileges to a new role that they do not possess themselves.
    const currentUser = await User.findById(currentUserId).populate('role');
    if (currentUser.role.name !== 'admin') {
      const currentUserPermissions = currentUser.role.permissions;
      const hasUnauthorizedPermission = permissions.some(
        (perm) => !currentUserPermissions.includes(perm)
      );
      
      if (hasUnauthorizedPermission) {
        return res.status(403).json({ 
          message: 'You cannot assign privileges to a role that exceed your own permissions.' 
        });
      }
    }

    const newRole = new Role({
      name: formattedName,
      permissions
    });

    await newRole.save();
    res.status(201).json({ message: 'Role created successfully.', role: newRole });
  })
);

// ==========================================
// 2. GET ALL ROLES with Pagination & Search (Admins & Managers) [3]
// ==========================================
router.get('/', 
  authenticateToken, 
  requirePermission('employees:view'), 
  asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || '';

    let query = {};

    // If search query is provided, search by Role Name (case-insensitive)
    if (search) {
      query.name = { $regex: search, $options: 'i' };
    }

    const totalDocs = await Role.countDocuments(query);
    const totalPages = Math.ceil(totalDocs / limit);
    const skip = (page - 1) * limit;

    const roles = await Role.find(query)
      .skip(skip)
      .limit(limit);

    // Return standard Pagination payload [3]
    res.json({
      docs: roles,
      totalPages,
      totalDocs,
      page
    });
  })
);

// ==========================================
// 3. GET SINGLE ROLE (Admins & Managers)
// ==========================================
router.get('/:id', 
  authenticateToken, 
  requirePermission('employees:view'), 
  asyncHandler(async (req, res) => {
    const role = await Role.findById(req.params.id);
    if (!role) {
      return res.status(404).json({ message: 'Role not found.' });
    }
    res.json(role);
  })
);

// ==========================================
// 4. UPDATE ROLE (Admins & Managers)
// ==========================================
router.put('/:id', 
  authenticateToken, 
  requirePermission('employees:edit'), 
  asyncHandler(async (req, res) => {
    const roleId = req.params.id;
    const { name, permissions } = req.body;
    const currentUserId = req.user.id;

    const role = await Role.findById(roleId);
    if (!role) {
      return res.status(404).json({ message: 'Role not found.' });
    }

    // Checkpoint 3: Resource Safeguards (Business Logic)

    // Rule A: Protect the default 'admin' role
    if (role.name === 'admin') {
      return res.status(403).json({ message: 'The primary Admin role cannot be modified or renamed.' });
    }

    // Rule B: Prevent Privilege Escalation
    // Non-admins cannot grant a role permissions that they do not have themselves.
    const currentUser = await User.findById(currentUserId).populate('role');
    if (currentUser.role.name !== 'admin') {
      const currentUserPermissions = currentUser.role.permissions;
      const hasUnauthorizedPermission = permissions.some(
        (perm) => !currentUserPermissions.includes(perm)
      );

      if (hasUnauthorizedPermission) {
        return res.status(403).json({ 
          message: 'You cannot grant privileges to a role that exceed your own permissions.' 
        });
      }
    }

    // Apply safe updates
    if (name) role.name = name.toLowerCase().trim();
    if (permissions) role.permissions = permissions;

    await role.save();
    res.json({ message: 'Role updated successfully.', role });
  })
);
 
// ==========================================
// 5. DELETE ROLE (Admins Only)
// ==========================================
router.delete('/:id', 
  authenticateToken, 
  requirePermission('employees:delete'), 
  asyncHandler(async (req, res) => {
    const roleId = req.params.id;

    const role = await Role.findById(roleId);
    if (!role) {
      return res.status(404).json({ message: 'Role not found.' });
    }

    // Checkpoint 3: Resource Safeguards (Business Logic)

    // Rule A: Protect the default 'admin' role
    if (role.name === 'admin') {
      return res.status(403).json({ message: 'The primary Admin role cannot be deleted.' });
    }

    // Rule B: Orphan Prevention
    // Prevent deleting a role if there are still active users assigned to it.
    const usersAssignedToRole = await User.countDocuments({ role: roleId });
    if (usersAssignedToRole > 0) {
      return res.status(400).json({ 
        message: `Cannot delete role. There are currently ${usersAssignedToRole} user(s) assigned to this role.` 
      });
    }

    await Role.findByIdAndDelete(roleId);
    res.json({ message: `Role '${role.name}' was successfully deleted.` });
  })
);

module.exports = router;