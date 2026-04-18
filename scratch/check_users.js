const mongoose = require('mongoose');
const User = require('./models/User');

async function checkUsers() {
  await mongoose.connect('mongodb+srv://priyanshpandeyvns:WosC75ZpQW7MToIs@cluster0.3h8vt.mongodb.net/rapid-response?retryWrites=true&w=majority', { useNewUrlParser: true, useUnifiedTopology: true });
  const users = await User.find({});
  console.log(JSON.stringify(users, null, 2));
  process.exit();
}

checkUsers();
