const mongoose = require('mongoose');
const User = require('../models/User');
const Role = require('../models/Role');


// List of all standard system privileges
const ALL_SYSTEM_PERMISSIONS = [
  'employees:view', 'employees:create', 'employees:edit', 'employees:delete',
  'schedules:view', 'schedules:create', 'schedules:edit', 'schedules:delete', 'schedules:publish',
  'pointage:view', 'pointage:create'
];
// 2. Define our 3 standard default roles and their dynamic privileges
const DEFAULT_ROLES = [
  {
    name: 'admin',
    permissions: ALL_SYSTEM_PERMISSIONS // Admins get full system bypass
  },
  {
    name: 'manager',
    permissions: [
      'employees:view', 'employees:create', 'employees:edit',
      'schedules:view', 'schedules:create', 'schedules:edit', 'schedules:publish',
      'pointage:view', 'pointage:create'
    ]
  },
  {
    name: 'employee',
    permissions: [
      'pointage:create' // Employees can only record clock-ins (pointage)
    ]
  }
];

const connectDB = async () => {
  const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGO_URI missing in .env');
    await mongoose.connect(uri);
    // await mongoose.connect(uri, { dbName: 'pointuse' });

    console.log('✅ Connected to MongoDB');

    await seedDefaultSystem(); // Seed default system roles and users after connecting to the database

};

const seedDefaultSystem = async () => {
  try {
    // Step A: Loop through default roles and create them if missing [1]
    for (const roleData of DEFAULT_ROLES) {
      const roleExists = await Role.findOne({ name: roleData.name });
      if (!roleExists) {
        const newRole = new Role({
          name: roleData.name,
          permissions: roleData.permissions
        });
        await newRole.save();
        console.log(`🛡️ Seeded default role: ${roleData.name}`);
      }
    }

    // Step B: Locate the seeded 'admin' role to link to our Super Admin User
    const adminRole = await Role.findOne({ name: 'admin' });

    // Step C: Check/Create the Super Admin User
    const adminExists = await User.findOne({ email: process.env.SUPERADMIN_EMAIL });
    if (!adminExists) {
      const superAdmin = new User({
        name: 'System Admin',
        email: process.env.SUPERADMIN_EMAIL,
        password: process.env.SUPERADMIN_PASSWORD,
        role: adminRole._id // References the dynamic admin role ID
      });
      await superAdmin.save();
      console.log('👑 Super Admin successfully seeded!');
    }
  } catch (error) {
    console.error('❌ Error seeding database:', error.message);
  }
};

module.exports = connectDB;