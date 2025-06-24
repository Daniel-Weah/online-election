const express = require("express");
const bcrypt = require("bcrypt");
const pool = require("../db");
const router = express.Router();

// Render login page or redirect if already logged in
router.get("/login", (req, res) => {
  if (req.session.userId) {
    return res.redirect("/dashboard");
  }
  res.render("login", { errorMessage: null });
});

// Handle login submission
router.post("/login", async (req, res) => {
  const { username, password } = req.body;

  try {
    const authResult = await pool.query(
      "SELECT * FROM auth WHERE username = $1",
      [username]
    );

    const userAuth = authResult.rows[0];

    if (!userAuth) {
      return res.render("login", {
        errorMessage: "Invalid voter ID or password.",
      });
    }

    const validPassword = await bcrypt.compare(password, userAuth.password);
    if (!validPassword) {
      return res.render("login", {
        errorMessage: "Invalid voter ID or password.",
      });
    }

    const userResult = await pool.query(
      `SELECT users.*, roles.role AS role_name
       FROM users
       JOIN roles ON users.role_id = roles.id
       WHERE users.id = $1`,
      [userAuth.user_id]
    );

    const userData = userResult.rows[0];
    if (!userData) {
      return res.status(500).send("User data not found.");
    }

    // Set session
    req.session.userId = userData.id;
    req.session.userRole = userData.role_name;
    req.session.profilePicture = userData.profile_picture
      ? Buffer.from(userData.profile_picture).toString("base64")
      : null;

    res.redirect("/dashboard");

  } catch (err) {
    console.error("Login error:", err);
    res.status(500).send("Internal Server Error");
  }
});

module.exports = router;
