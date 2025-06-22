const express = require("express");
const router = express.Router();
const pool = require("../db");

// Middleware to check session login
function ensureLoggedIn(req, res, next) {
  if (!req.session.userId) {
    return res.redirect("/login");
  }
  next();
}

router.get("/vote/analysis", ensureLoggedIn, async (req, res) => {
  try {
    // Fetch current user
    const currentUserResult = await pool.query(
      "SELECT * FROM users WHERE id = $1",
      [req.session.userId]
    );
    if (currentUserResult.rows.length === 0) {
      return res.status(404).send("User not found");
    }
    const currentUser = currentUserResult.rows[0];
    console.log("Current user data", currentUser.election_id);

    // Fetch candidates grouped by position with votes
    const positionsQuery = `
      SELECT positions.position, candidates.first_name, candidates.middle_name, 
             candidates.last_name, candidates.photo, COALESCE(SUM(votes.vote), 0) AS vote
      FROM candidates
      JOIN positions ON candidates.position_id = positions.id
      LEFT JOIN votes ON candidates.id = votes.candidate_id
      WHERE candidates.election_id = $1
      GROUP BY positions.position, candidates.id
      ORDER BY positions.position, candidates.last_name
    `;
    const candidatesResult = await pool.query(positionsQuery, [
      currentUser.election_id,
    ]);

    const groupedData = {};
    candidatesResult.rows.forEach((candidate) => {
      const position = candidate.position.trim().replace(/\s+/g, " ");
      const candidateName = `${candidate.first_name} ${
        candidate.middle_name || ""
      } ${candidate.last_name}`.trim();

      if (!groupedData[position]) {
        groupedData[position] = { candidates: [] };
      }

      groupedData[position].candidates.push({
        name: candidateName,
        vote: candidate.vote,
        photo: Buffer.isBuffer(candidate.photo)
          ? `data:image/jpeg;base64,${candidate.photo.toString("base64")}`
          : typeof candidate.photo === "string"
          ? candidate.photo
          : "",
      });
    });

    console.log(groupedData);

    // Fetch user role
    const userRoleResult = await pool.query(
      `SELECT users.role_id, roles.role 
       FROM users 
       JOIN roles ON users.role_id = roles.id 
       WHERE users.id = $1`,
      [req.session.userId]
    );

    // Fetch username
    const userResult = await pool.query(
      "SELECT username FROM auth WHERE user_id = $1",
      [req.session.userId]
    );
    if (userResult.rows.length === 0) {
      return res.status(404).send("User not found");
    }
    const username = userResult.rows[0].username;

    // Fetch unread notification count
    const countResult = await pool.query(
      "SELECT COUNT(*) AS unreadCount FROM notifications WHERE username = $1 AND is_read = 0",
      [username]
    );

    // Fetch user data
    const userDataResult = await pool.query("SELECT * FROM users WHERE id = $1", [
      req.session.userId,
    ]);
    if (userDataResult.rows.length === 0) {
      return res.status(404).send("User data not found");
    }

    res.render("vote-analysis", {
      groupedData: JSON.stringify(groupedData),
      profilePicture: req.session.profilePicture,
      role: userRoleResult.rows[0].role,
      unreadCount: countResult.rows[0].unreadcount,
      user: userDataResult.rows[0],
    });
  } catch (err) {
    console.error("Error in /vote/analysis:", err);
    res.status(500).send("Internal server error");
  }
});

module.exports = router;
