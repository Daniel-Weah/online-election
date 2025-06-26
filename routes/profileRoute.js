const express = require("express");
const router = express.Router();
const pool = require("../db");

// GET /profile/:idSlug
router.get("/profile/:idSlug", async (req, res) => {
  const idSlug = req.params.idSlug;

  // Match a UUID (or ID) at the beginning of the slug
  const idMatch = idSlug.match(/^([a-f0-9-]{36})/i); // UUID v4 pattern
  const userId = idMatch ? idMatch[1] : null;

  if (!userId) {
    return res.status(400).send("Invalid profile URL.");
  }

  if (!req.session.userId) {
    return res.redirect("/login");
  }

  try {
    const userResult = await pool.query(
      `
      SELECT users.*, roles.role, auth.username
      FROM users
      JOIN roles ON users.role_id = roles.id
      JOIN auth ON users.id = auth.user_id
      WHERE users.id = $1
    `,
      [userId]
    );

    if (!userResult.rows.length) {
      return res.status(404).send("User not found.");
    }

    const user = userResult.rows[0];

    // Reconstruct expected slug
    const rawName = `${user.first_name} ${user.middle_name || ''} ${user.last_name}`;
    const fullNameSlug = rawName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

    const expectedSlug = `${user.id}-${fullNameSlug}`;

    // Redirect to correct canonical slug if URL mismatches
    if (idSlug !== expectedSlug) {
      return res.redirect(`/profile/${expectedSlug}`);
    }

    // Format DOB
    const formattedDOB = user.dob
      ? new Date(user.dob).toISOString().split("T")[0]
      : "";

    // Convert profile picture to base64
    if (user.profile_picture && Buffer.isBuffer(user.profile_picture)) {
      user.profile_picture = user.profile_picture.toString("base64");
    } else {
      user.profile_picture = null;
    }

    const voteStatus = user.has_voted ? "Voted" : "Not Voted";

    // Unread notifications
    const countResult = await pool.query(
      "SELECT COUNT(*) AS unreadCount FROM notifications WHERE username = $1 AND is_read = 0",
      [user.username]
    );

    const unreadCount = parseInt(countResult.rows[0].unreadcount, 10) || 0;
    const profilePicture = req.session.profilePicture;

    // Render profile
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
