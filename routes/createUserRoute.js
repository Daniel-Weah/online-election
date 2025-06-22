const express = require("express");
const router = express.Router();
const pool = require("../db");
const bcrypt = require("bcrypt");
const { v4: uuidv4 } = require("uuid");
const multer = require("multer");
const upload = multer();
require("dotenv").config();


const secretSavedToken = process.env.SECRET_TOKEN;

router.get("/create/user", async (req, res) => {
  try {
    const token = req.query.token;

    if (token !== secretSavedToken) {
      return res.status(403).send("Access Denied");
    }

    const electionResult = await pool.query("SELECT * FROM elections");
    const roleResult = await pool.query("SELECT * FROM roles");

    res.render("createUser", {
      roles: roleResult.rows,
      elections: electionResult.rows,
    });
  } catch (err) {
    console.error("Error rendering create user page:", err);
    res.status(500).send("Internal server error");
  }
});

// =============================== VOTERS POST ROUTE ==================================
router.post("/create/user", upload.single("photo"), async (req, res) => {
  try {
    const {
      firstname,
      middlename,
      lastname,
      dob,
      username,
      role,
      election,
      password,
    } = req.body;

    const photo = req.file ? req.file.buffer : null;
    const userID = uuidv4();
    const io = req.app.get('io');

    const hashedPassword = await bcrypt.hash(password, 10);

    const electionRes = await pool.query("SELECT election FROM elections WHERE id = $1", [election]);
    const electionName = electionRes.rows[0]?.election || "the election";

    await pool.query(
      `INSERT INTO users (id, first_name, middle_name, last_name, DOB, profile_picture, role_id, election_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [userID, firstname, middlename, lastname, dob, photo, role, election]
    );

    // Insert auth
    await pool.query(
      `INSERT INTO auth (id, username, password, user_id, election_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [uuidv4(), username, hashedPassword, userID, election]
    );

    // Prepare notification
    const currentTime = new Date();
    const notificationMessage = `Hi ${firstname} ${middlename || ""} ${lastname} (${username}), congratulations on successfully registering for ${electionName} using our online election voting system! Your vote is powerful and can shape the future. Stay tuned for any important updates regarding the election process.`;
    const notificationTitle = "Registration Successful";

    // Insert notification
    await pool.query(
      `INSERT INTO notifications (id, username, election, message, title, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [uuidv4(), username, election, notificationMessage, notificationTitle, currentTime]
    );

    // Emit notification via socket.io
    io.to(username).emit("new-notification", {
      message: notificationMessage,
      title: notificationTitle,
      created_at: currentTime,
    });

    res.status(200).json({
      success: true,
      message: `${username} has successfully been registered`,
    });
  } catch (err) {
    console.error("Error in creating user:", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

module.exports = router;
