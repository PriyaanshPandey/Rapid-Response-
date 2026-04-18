const mongoose = require('mongoose');
require('dotenv').config();

const userSchema = new mongoose.Schema({
  name: String,
  type: String, // 'guest' or 'staff'
  role: String, // 'rescue' or 'evac'
  status: String,
  node: String,
  assignedTo: mongoose.Schema.Types.ObjectId
});

const User = mongoose.model('User', userSchema);

async function check() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    const users = await User.find();
    console.log('Total Users:', users.length);
    const staff = users.filter(u => u.type === 'staff');
    console.log('Staff count:', staff.length);
    staff.forEach(s => {
      console.log(`Staff: ${s.name}, Role: ${s.role}, Node: ${s.node}`);
    });
    const guests = users.filter(u => u.type === 'guest');
    console.log('Guests count:', guests.length);
    guests.forEach(g => {
        console.log(`Guest: ${g.name}, Status: ${g.status}, Node: ${g.node}, AssignedTo: ${g.assignedTo}`);
    });
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

check();
