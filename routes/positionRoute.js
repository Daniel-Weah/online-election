const express = require("express");
const router = express.Router();
const pool = require("../db");
const { v4: uuidv4 } = require("uuid");
const { isAuthenticated } = require("../middlewares/auth");

router.get("/add/position", async (req, res) => {
  try {
    if (
      !req.session.userId ||
      (req.session.userRole !== "Super Admin" &&
        req.session.userRole !== "Admin")
    ) {
      return res.redirect("/login");
    }

    const profilePicture = req.session.profilePicture;

    // Fetch all positions with election names
    const positionsResult = await pool.query(
      `SELECT positions.*, elections.election
       FROM positions 
       JOIN elections ON positions.election_id = elections.id`
    );
    const positions = positionsResult.rows;

    // Fetch user role
    const userRoleResult = await pool.query(
      "SELECT roles.role FROM users JOIN roles ON users.role_id = roles.id WHERE users.id = $1",
      [req.session.userId]
    );
    if (userRoleResult.rows.length === 0) {
      return res.status(404).send("User role not found");
    }
    const userRole = userRoleResult.rows[0].role;

    // Fetch username
    const userResult = await pool.query(
      "SELECT username FROM auth WHERE user_id = $1",
      [req.session.userId]
    );
    if (userResult.rows.length === 0) {
      return res.status(404).send("User not found");
    }
    const username = userResult.rows[0].username;

    // Fetch unread notifications count
    const unreadCountResult = await pool.query(
      "SELECT COUNT(*) AS unreadCount FROM notifications WHERE username = $1 AND is_read = 0",
      [username]
    );
    const unreadCount = unreadCountResult.rows[0].unreadcount;

    // Fetch user data
    const userDataResult = await pool.query(
      "SELECT * FROM users WHERE id = $1",
      [req.session.userId]
    );
    if (userDataResult.rows.length === 0) {
      return res.status(404).send("User not found in users table");
    }
    const user = userDataResult.rows[0];

    // Fetch positions for the admin's election
    const adminPositionsResult = await pool.query(
      "SELECT * FROM positions WHERE election_id = $1",
      [user.election_id]
    );
    const Adminpositions = adminPositionsResult.rows;

    // Fetch user election data
    const userElectionDataResult = await pool.query(
      `SELECT users.*, elections.election AS election_name 
       FROM users 
       JOIN elections ON users.election_id = elections.id 
       WHERE users.id = $1`,
      [req.session.userId]
    );
    const userElectionData = userElectionDataResult.rows[0];

    // Fetch all elections
    const electionsResult = await pool.query("SELECT * FROM elections");
    const elections = electionsResult.rows;

    // Render the page
    res.render("position.ejs", {
      positions,
      profilePicture,
      role: userRole,
      unreadCount,
      user,
      elections,
      userElectionData,
      Adminpositions,
    });
  } catch (err) {
    console.error("Error fetching data:", err);
    res.status(500).send("Internal server error");
  }
});

router.post("/add/position", async (req, res) => {
  try {

    const {
      election,
      position,
      position_description,
      candidate_age_eligibility,
    } = req.body;
    if (
      !election ||
      !position ||
      !position_description ||
      !candidate_age_eligibility
    ) {
      return res
        .status(400)
        .json({ success: false, message: "All fields are required." });
    }

    const positionID = uuidv4();

    await pool.query(
      "INSERT INTO positions (id, election_id, position, position_description, candidate_age_eligibility) VALUES ($1, $2, $3, $4, $5)",
      [
        positionID,
        election,
        position,
        position_description,
        candidate_age_eligibility,
      ]
    );

    res
      .status(200)
      .json({
        success: true,
        message: `${position} Position created successfully`,
      });
  } catch (error) {
    console.error("Database Insert Error:", error);
    res.status(500).json({ success: false, message: "Database insert failed" });
  }
});

router.post("/update/position", async (req, res) => {
  try {
    const { id, position, candidate_age_eligibilities } = req.body;

    const result = await pool.query(
      "UPDATE positions SET position = $1, candidate_age_eligibility = $2 WHERE id = $3",
      [position, candidate_age_eligibilities, id]
    );

    if (result.rowCount === 0) {
      return res.redirect("/add/position?error=Position not found");
    }

    res.redirect("/add/position?success=Position updated successfully!");
  } catch (err) {
    console.error("Error updating position:", err);
    res.redirect("/add/position?error=Error updating position");
  }
});

router.post("/delete/position", async (req, res) => {
  let { voterIds } = req.body;

  if (!voterIds) {
      return res.redirect("/add/position?error=No position selected");
  }

  try {
      voterIds = JSON.parse(voterIds);
  } catch (error) {
      return res.redirect("/add/position?error=Invalid position data");
  }

  if (!Array.isArray(voterIds) || voterIds.length === 0) {
      return res.redirect("/add/position?error=No position selected");
  }

  const placeholders = voterIds.map((_, i) => `$${i + 1}`).join(", ");

  pool.query(`DELETE FROM positions WHERE id IN (${placeholders})`, voterIds, function (err) {
      if (err) {
          console.error("Error deleting position:", err.message);
          return res.redirect("/add/position?error=Error deleting position");
      }
      res.redirect("/add/position?success=Position Deleted Successfully!");
  });
});


module.exports = router;