const express = require("express");
const router = express.Router();
const { v4: uuidv4 } = require("uuid");
const pool = require("../db");
const multer = require("multer");
const upload = multer(); 
// Middleware to check Super Admin login
function ensureSuperAdmin(req, res, next) {
  if (!req.session.userId || req.session.userRole !== "Super Admin") {
    return res.redirect("/login");
  }
  next();
}

// GET /create/election
router.get("/create/election", ensureSuperAdmin, async (req, res) => {
  try {
    const profilePicture = req.session.profilePicture;

    const userRoleResult = await pool.query(
      `SELECT users.role_id, roles.role 
       FROM users 
       JOIN roles ON users.role_id = roles.id 
       WHERE users.id = $1`,
      [req.session.userId]
    );

    const electionsResult = await pool.query(
      `SELECT elections.*, election_settings.*
       FROM elections
       JOIN election_settings ON elections.id = election_settings.election_id`
    );

    const userResult = await pool.query(
      `SELECT username FROM auth WHERE user_id = $1`,
      [req.session.userId]
    );
    if (userResult.rows.length === 0) {
      return res.status(404).send("User not found");
    }
    const username = userResult.rows[0].username;

    const countResult = await pool.query(
      `SELECT COUNT(*) AS unreadCount 
       FROM notifications 
       WHERE username = $1 AND is_read = 0`,
      [username]
    );

    const userDataResult = await pool.query(
      `SELECT * FROM users WHERE id = $1`,
      [req.session.userId]
    );
    if (userDataResult.rows.length === 0) {
      return res.status(404).send("User data not found");
    }

    res.render("election", {
      profilePicture,
      role: userRoleResult.rows[0].role,
      elections: electionsResult.rows,
      user: userDataResult.rows[0],
      unreadCount: countResult.rows[0].unreadcount,
    });
  } catch (err) {
    console.error("Error fetching election page data:", err);
    res.status(500).send("Internal server error");
  }
});

// POST /create/election
router.post("/create/election",upload.none(), async (req, res) => {
  const {
    election,
    start_time,
    end_time,
    voter_age_eligibility,
    registration_start_time,
    registration_end_time,
    admin_start_time,
    admin_end_time,
  } = req.body;

  const electionID = uuidv4();

  try {
    await pool.query("BEGIN");

    const insertElectionQuery = `
      INSERT INTO elections (id, election, voter_age_eligibility)
      VALUES ($1, $2, $3)
    `;
    await pool.query(insertElectionQuery, [
      electionID,
      election,
      voter_age_eligibility,
    ]);

    const insertElectionSettingsQuery = `
      INSERT INTO election_settings (id, start_time, end_time, registration_start_time, registration_end_time, election_id, admin_start_time, admin_end_time)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `;
    await pool.query(insertElectionSettingsQuery, [
      uuidv4(),
      start_time,
      end_time,
      registration_start_time,
      registration_end_time,
      electionID,
      admin_start_time,
      admin_end_time,
    ]);

    await pool.query("COMMIT");

    res.status(200).json({
      success: true,
      message: `${election} successfully created`,
    });
  } catch (err) {
    await pool.query("ROLLBACK");
    console.error("Error creating election:", err);
    res.status(500).json({
      success: false,
      message: "An error occurred while creating the election or its settings",
    });
  }
});

// POST /update/election
router.post("/update/election", upload.none(), async (req, res) => {
  const {
    id,
    election,
    startTime,
    endTime,
    voter_age_eligibilities,
    RegistrationStartTime,
    RegistrationEndTime,
    adminStartTime,
    adminEndTime,
  } = req.body;

  try {
    await pool.query(
      "UPDATE elections SET election = $1, voter_age_eligibility = $2 WHERE id = $3",
      [election, voter_age_eligibilities, id]
    );

    await pool.query(
      `UPDATE election_settings 
       SET start_time = $1, end_time = $2, registration_start_time = $3, registration_end_time = $4, admin_start_time = $5, admin_end_time = $6
       WHERE election_id = $7`,
      [
        startTime,
        endTime,
        RegistrationStartTime,
        RegistrationEndTime,
        adminStartTime,
        adminEndTime,
        id,
      ]
    );

    res.redirect("/create/election");
  } catch (err) {
    console.error("Error updating election:", err);
    res.status(500).send("Error updating election");
  }
});

// POST /delete/election/:id
router.post("/delete/election/:id", async (req, res) => {
  const { id } = req.params;

  try {
    await pool.query("BEGIN");

    await pool.query("DELETE FROM elections WHERE id = $1", [id]);
    await pool.query("DELETE FROM election_settings WHERE election_id = $1", [id]);

    await pool.query("COMMIT");

    res.redirect("/create/election");
  } catch (err) {
    await pool.query("ROLLBACK");
    console.error("Error deleting election:", err);
    res.status(500).send("Error deleting election");
  }
});

module.exports = router;
