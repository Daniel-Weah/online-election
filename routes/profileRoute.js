const express = require("express");
const router = express.Router();
const pool = require("../db");

// GET /my/profile
router.get("/my/profile", async (req, res) => {
  if (!req.session.userId) {
    return res.redirect("/login");
  }

  try {
    // Fetch user with role and username
    const userResult = await pool.query(
      `
      SELECT users.*, roles.role, auth.username
      FROM users
      JOIN roles ON users.role_id = roles.id
      JOIN auth ON users.id = auth.user_id
      WHERE users.id = $1
    `,
      [req.session.userId]
    );

    if (!userResult.rows.length) {
      return res.status(404).send("User not found");
    }

    const user = userResult.rows[0];

    // Format date of birth
    const formattedDOB = user.dob
      ? new Date(user.dob).toISOString().split("T")[0]
      : "";

    // Convert profile picture to base64 (safely)
    if (user.profile_picture && Buffer.isBuffer(user.profile_picture)) {
      user.profile_picture = user.profile_picture.toString("base64");
    } else {
      user.profile_picture = null;
    }

    const voteStatus = user.has_voted ? "Voted" : "Not Voted";

    // Fetch unread notifications count
    const countResult = await pool.query(
      "SELECT COUNT(*) AS unreadCount FROM notifications WHERE username = $1 AND is_read = 0",
      [user.username]
    );

    const unreadCount = parseInt(countResult.rows[0].unreadcount, 10) || 0;
    const profilePicture = req.session.profilePicture;

    // Render the profile view
    res.render("profile", {
      user,
      voteStatus,
      unreadCount,
      profilePicture,
      formattedDOB,
    });
  } catch (err) {
    console.error("Error loading profile:", err);
    res.status(500).send("An error occurred while loading the profile page.");
  }
});

module.exports = router;
