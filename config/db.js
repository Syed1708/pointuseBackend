const mongoose = require('mongoose');
const User = require('../models/User');
const Role = require('../models/Role');


// List of all standard system privileges
const ALL_SYSTEM_PERMISSIONS = [
  'employees:view', 'employees:create', 'employees:edit', 'employees:delete',
  'schedules:view', 'schedules:create', 'schedules:edit', 'schedules:delete', 'schedules:publish',
  'pointage:view', 'pointage:create'
];

const connectDB = async () => {
  const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGO_URI missing in .env');
    await mongoose.connect(uri);
    // await mongoose.connect(uri, { dbName: 'pointuse' });

    console.log('✅ Connected to MongoDB');

    await seedSuperAdmin(); // Seed Super Admin after connecting to the database

};

const seedSuperAdmin = async () => {
  try {
    // 1. Check/Create the default 'admin' Role with ALL permissions
    let adminRole = await Role.findOne({ name: 'admin' });
    if (!adminRole) {
      adminRole = new Role({
        name: 'admin',
        permissions: ALL_SYSTEM_PERMISSIONS
      });
      await adminRole.save();
      console.log('🛡️ Default Admin Role created.');
    }

    // 2. Check/Create the Super Admin User
    const adminExists = await User.findOne({ email: process.env.SUPERADMIN_EMAIL });
    if (!adminExists) {
      const superAdmin = new User({
        name: 'System Admin',
        email: process.env.SUPERADMIN_EMAIL,
        password: process.env.SUPERADMIN_PASSWORD,
        role: adminRole._id // Reference the dynamic admin role ID
      });
      await superAdmin.save();
      console.log('👑 Super Admin successfully seeded!');
    }
  } catch (error) {
    console.error('❌ Error seeding database:', error.message);
  }
};

module.exports = connectDB;