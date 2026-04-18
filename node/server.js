import express from "express";
import mongoose from "mongoose";

mongoose.connect("mongodb://localhost:27017/company")
import {Company} from "./models/Todo.js"
const app = express();
app.set('view engine','ejs')
const port = 3000;

app.get("/", (req, res) => {
  res.render('index');
});


app.get("/add", async (req, res) => {
  try {
    const e = await Company.create({
      Name: "om",
      Salary: 5000,
      Language: "js",
      City: "mirzapur",
      isManager: true
    });

    res.json({ success: true, data: e });
  } catch (err) {
    console.error("GENERATE ERROR:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(port, () => {
  console.log("SERVER STARTED ON PORT", port);
});
