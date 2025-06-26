const express = require("express");
const bcrypt = require("bcrypt");
const router = express.Router();

const pool  = require("../db");

const multer = require("multer");
const upload = multer();

// GET Voter Settings page
router.get("/voter/setting", async (req, res) => {
  if (!req.session.userId) {
    return res.redirect("/login");
  }

  try {
    const sql = `
      SELECT users.*, roles.role, auth.username
      FROM users
      JOIN roles ON users.role_id = roles.id
      JOIN auth ON users.id = auth.user_id
      WHERE users.id = $1
    `;
    const result = await pool.query(sql, [req.session.userId]);

    if (result.rows.length === 0) {
      return res.status(404).send("User not found");
    }

    const user = result.rows[0];

    const countResult = await pool.query(
      "SELECT COUNT(*) AS unreadCount FROM notifications WHERE username = $1 AND is_read = 0",
      [user.username]
    );

    const unreadCount = parseInt(countResult.rows[0].unreadcount, 10) || 0;
    const profilePicture = req.session.profilePicture;

    res.render("voter-setting", {
      unreadCount,
      profilePicture,
      user,
    });
  } catch (err) {
    console.error("Error fetching voter setting data:", err);
    res.status(500).send("An error occurred");
  }
});

// POST - Update password from settings page
router.post("/setting/forget-password",upload.none(), async (req, res) => {
  const { username, password, passwordConfirm } = req.body;

  if (password !== passwordConfirm) {
    return res
      .status(400)
      .json({ success: false, message: "Passwords do not match" });
  }

  try {
    const authResult = await pool.query(
      "SELECT * FROM auth WHERE username = $1 AND user_id = $2",
      [username, req.session.userId]
    );

    if (authResult.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Invalid username." });
    }

    const user = authResult.rows[0];

    if (user.username !== username) {
      return res
        .status(403)
        .json({
          success: false,
          message: "You are not authorized to change this password",
        });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    await pool.query(
      "UPDATE auth SET password = $1 WHERE username = $2 AND user_id = $3",
      [hashedPassword, username, req.session.userId]
    );

    res.status(200).json({
      success: true,
      message: "Password updated successfully",
    });
  } catch (err) {
    console.error("Error updating password:", err);
    res.status(500).json({ success: false, message: "An error occurred" });
  }
});



module.exports = router;
