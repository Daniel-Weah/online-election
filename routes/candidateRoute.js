const express = require("express");
const router = express.Router();
const pool = require("../db");
const { isAuthenticated } = require("../middlewares/auth");
const { v4: uuidv4 } = require("uuid");
const bcrypt = require("bcrypt");
const multer = require("multer");

const storage = multer.memoryStorage();
const upload = multer({ storage });

const getIO = (req) => req.app.get("io");

// GET candidate registration page
router.get("/candidate/registration", async (req, res) => {
  try {
    if (
      !req.session.userId ||
      (req.session.userRole !== "Super Admin" && req.session.userRole !== "Admin")
    ) {
      return res.redirect("/login");
    }

    const profilePicture = req.session.profilePicture;

    // Fetch user info
    const { rows: userData } = await pool.query(
      "SELECT * FROM users WHERE id = $1",
      [req.session.userId]
    );
    const userTable = userData[0];

    const { rows: authData } = await pool.query(
      "SELECT username FROM auth WHERE user_id = $1",
      [req.session.userId]
    );
    const user = authData[0];

    const { rows: unreadRows } = await pool.query(
      "SELECT COUNT(*) AS unread_count FROM notifications WHERE username = $1 AND is_read = 0",
      [user.username]
    );
    const unreadCount = unreadRows[0].unread_count;

    const { rows: userRoleData } = await pool.query(
      "SELECT roles.role FROM users JOIN roles ON users.role_id = roles.id WHERE users.id = $1",
      [req.session.userId]
    );
    const role = userRoleData[0].role;

    const { rows: parties } = await pool.query("SELECT * FROM parties");
    const { rows: positions } = await pool.query("SELECT * FROM positions");
    const { rows: roles } = await pool.query("SELECT * FROM roles LIMIT 1 OFFSET 1");
    const secondRole = roles[0];

    const { rows: elections } = await pool.query("SELECT * FROM elections");

    const { rows: userElectionData } = await pool.query(
      `SELECT users.*, elections.election AS election_name 
       FROM users 
       JOIN elections ON users.election_id = elections.id 
       WHERE users.id = $1`,
      [req.session.userId]
    );

    const { rows: Adminparties } = await pool.query(
      "SELECT * FROM parties WHERE election_id = $1",
      [userTable.election_id]
    );

    const { rows: Adminpositions } = await pool.query(
      "SELECT * FROM positions WHERE election_id = $1",
      [userTable.election_id]
    );

    let { rows: candidates } = await pool.query(`
      SELECT candidates.*, parties.party, parties.logo, positions.position, votes.vote AS vote, elections.election AS candidate_election
      FROM candidates
      JOIN parties ON candidates.party_id = parties.id 
      JOIN positions ON candidates.position_id = positions.id
      LEFT JOIN votes ON candidates.id = votes.candidate_id
      JOIN elections ON candidates.election_id = elections.id
      ORDER BY candidates.first_name
    `);

    candidates = candidates.map((c) => ({
      ...c,
      photo: c.photo ? c.photo.toString("base64") : null,
      logo: c.logo ? c.logo.toString("base64") : null,
    }));

    let { rows: Admincandidates } = await pool.query(
      `SELECT candidates.*, parties.party, parties.logo, positions.position, votes.vote AS vote, elections.election AS candidate_election
       FROM candidates
       JOIN parties ON candidates.party_id = parties.id 
       JOIN positions ON candidates.position_id = positions.id
       LEFT JOIN votes ON candidates.id = votes.candidate_id
       JOIN elections ON candidates.election_id = elections.id
       WHERE candidates.election_id = $1
       ORDER BY candidates.id DESC`,
      [userTable.election_id]
    );

    Admincandidates = Admincandidates.map((c) => ({
      ...c,
      photo: c.photo ? c.photo.toString("base64") : null,
      logo: c.logo ? c.logo.toString("base64") : null,
    }));

    res.render("candidate-registration", {
      parties,
      positions,
      profilePicture,
      role,
      unreadCount,
      candidates,
      user,
      elections,
      userElectionData: userElectionData[0],
      Adminparties,
      Adminpositions,
      Admincandidates,
      secondRole,
      userTable,
    });
  } catch (error) {
    console.error("Error loading candidate registration:", error.message);
    res.status(500).send("Server Error");
  }
});

// POST create candidate
router.post(
  "/candidate/registration",
  upload.single("photo"),
  async (req, res) => {
    const {
      firstname,
      middlename,
      lastname,
      party,
      position,
      election,
      username,
      password,
      role,
      DOB,
    } = req.body;
    const photo = req.file ? req.file.buffer : null;

    const candidateID = uuidv4();
    const userID = uuidv4();
    const authID = uuidv4();

    try {
      const { rows: posRows } = await pool.query(
        `SELECT candidate_age_eligibility FROM positions WHERE election_id = $1 AND id = $2`,
        [election, position]
      );

      if (posRows.length === 0) {
        return res.status(400).json({ success: false, message: "Invalid position" });
      }

      const candidateAgeEligibility = posRows[0].candidate_age_eligibility;
      const age = new Date().getFullYear() - new Date(DOB).getFullYear();

      if (age < candidateAgeEligibility) {
        return res.status(400).json({
          success: false,
          message: `Candidate must be at least ${candidateAgeEligibility} years old.`,
        });
      }

      const { rows: existing } = await pool.query(
        `SELECT 1 FROM auth WHERE username = $1 AND election_id = $2`,
        [username, election]
      );
      if (existing.length > 0) {
        return res.status(400).json({
          success: false,
          message: `Username '${username}' already exists for this election.`,
        });
      }

      const hashedPassword = await bcrypt.hash(password, 10);
      const io = getIO(req);

      await pool.query("BEGIN");

      await pool.query(
        `INSERT INTO users (id, first_name, middle_name, last_name, DOB, profile_picture, role_id, election_id) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [userID, firstname, middlename, lastname, DOB, photo, role, election]
      );

      await pool.query(
        `INSERT INTO auth (id, username, password, user_id, election_id) 
         VALUES ($1, $2, $3, $4, $5)`,
        [authID, username, hashedPassword, userID, election]
      );

      await pool.query(
        `INSERT INTO candidates (id, first_name, middle_name, last_name, party_id, position_id, photo, election_id, user_id) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [candidateID, firstname, middlename, lastname, party, position, photo, election, userID]
      );

      const { rows: elecRows } = await pool.query(
        "SELECT election FROM elections WHERE id = $1",
        [election]
      );
      const electionName = elecRows[0]?.election || "the election";

      const message = `Hi ${firstname} ${middlename} ${lastname} (${username}), you’ve successfully registered for ${electionName}. Stay tuned for updates.`;
      const title = "Registration Successful";

      await pool.query(
        `INSERT INTO notifications (id, username, election, message, title, created_at) 
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [uuidv4(), username, election, message, title, new Date()]
      );

      io.to(username).emit("new-notification", {
        message,
        title,
        created_at: new Date(),
      });

      await pool.query("COMMIT");

      res.status(200).json({
        success: true,
        message: `Candidate ${firstname} ${middlename} ${lastname} registered.`,
      });
    } catch (err) {
      await pool.query("ROLLBACK");
      console.error("Candidate registration error:", err.message);
      res.status(500).json({
        success: false,
        message: "Registration failed. Try again later.",
      });
    }
  }
);


// UPDATE Candidate
router.post("/update/candidate", async (req, res) => {
  const {
    id,
    first_name,
    middle_name,
    last_name,
    position,
    party,
    election,
    user_id,
  } = req.body;

  try {
    // Update candidate details
    await pool.query(
      `UPDATE candidates
       SET first_name = $1, middle_name = $2, last_name = $3, position_id = $4, party_id = $5, election_id = $6
       WHERE id = $7`,
      [first_name, middle_name, last_name, position, party, election, id]
    );

    // Update user details
    await pool.query(
      `UPDATE users
       SET first_name = $1, middle_name = $2, last_name = $3
       WHERE id = $4`,
      [first_name, middle_name, last_name, user_id]
    );

    res.redirect(
      "/candidate/registration?success=Candidate record updated successfully!"
    );
  } catch (err) {
    console.error("Error updating candidate:", err.message);
    res.redirect(
      "/candidate/registration?error=Error updating candidate record"
    );
  }
});

// DELETE Candidate
// DELETE Candidate
router.post("/delete/candidate/:id", async (req, res) => {
  const { candidateUserID } = req.body;
  const id = req.params.id;

  try {
    // Start transaction
    await pool.query("BEGIN");

    // Delete from candidates
    await pool.query("DELETE FROM candidates WHERE id = $1", [id]);

    // Delete from users
    await pool.query("DELETE FROM users WHERE id = $1", [candidateUserID]);

    // Delete from auth
    await pool.query("DELETE FROM auth WHERE user_id = $1", [candidateUserID]);

    // Delete from votes
    await pool.query("DELETE FROM votes WHERE candidate_id = $1", [id]);

    // Commit transaction
    await pool.query("COMMIT");

    res.redirect(
      "/candidate/registration?success=Candidate record deleted successfully!"
    );
  } catch (err) {
    await pool.query("ROLLBACK"); // Rollback transaction in case of an error
    console.error("Error deleting candidate:", err.message);
    res.redirect(
      "/candidate/registration?error=Error deleting candidate record"
    );
  }
});



module.exports = router;
