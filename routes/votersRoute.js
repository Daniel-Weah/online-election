const express = require("express");
const router = express.Router();
const pool = require("../db");
const { isAuthenticated } = require("../middlewares/auth");
const bcrypt = require("bcrypt");
const { v4: uuidv4 } = require("uuid");
const multer = require("multer");

// Multer config
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });
const getIO = (req) => req.app.get("io");

// ================= GET /voters =================
router.get("/voters", isAuthenticated, async (req, res) => {
  const userId = req.session.userId;

  if (!["Admin", "Super Admin"].includes(req.session.userRole)) {
    return res.redirect("/login");
  }

  try {
    const currentUserQuery = `
      SELECT users.*, roles.role, auth.username
      FROM users
      JOIN roles ON users.role_id = roles.id
      JOIN auth ON users.id = auth.user_id
      WHERE users.id = $1
    `;
    const currentUserResult = await pool.query(currentUserQuery, [userId]);

    if (!currentUserResult.rows.length) return res.status(404).send("User not found");

    const currentUser = currentUserResult.rows[0];
    currentUser.profile_picture = currentUser.profile_picture
      ? Buffer.from(currentUser.profile_picture).toString("base64")
      : null;

    const electionId = currentUser.election_id;

    const settingsResult = await pool.query(
      "SELECT * FROM election_settings WHERE election_id = $1",
      [electionId]
    );

    const registrationTiming = settingsResult.rows[0];
    if (!registrationTiming) return res.status(400).send("Election settings not found");

    const registrationStartTime = registrationTiming.registration_start_time;
    const registrationEndTime = registrationTiming.registration_end_time;
    const currentDate = registrationStartTime.split("T")[0];
    const currentTime = new Date().toLocaleTimeString("en-US", { hour12: false });
    const fullCurrentTime = `${currentDate}T${currentTime}`;
    const start = new Date(registrationStartTime);
    const end = new Date(registrationEndTime);
    const current = new Date(fullCurrentTime);

    const usersResult = await pool.query(`
      SELECT users.*, roles.role, auth.username, elections.election
      FROM users
      JOIN roles ON users.role_id = roles.id
      JOIN elections ON users.election_id = elections.id
      JOIN auth ON users.id = auth.user_id
    `);

    const users = usersResult.rows.map(u => ({
      ...u,
      profile_picture: u.profile_picture ? Buffer.from(u.profile_picture).toString("base64") : null,
      voteStatus: u.has_voted ? "Voted" : "Not Voted",
    }));

    const [rolesResult, allRolesResult, electionsResult, unreadResult] = await Promise.all([
      pool.query("SELECT * FROM roles LIMIT 1"),
      pool.query("SELECT * FROM roles"),
      pool.query("SELECT * FROM elections"),
      pool.query("SELECT COUNT(*) AS unreadCount FROM notifications WHERE username = $1 AND is_read = 0", [
        currentUser.username,
      ]),
    ]);

    res.render("voters", {
      users,
      profilePicture: currentUser.profile_picture,
      voteStatus: currentUser.has_voted ? "Voted" : "Not Voted",
      role: currentUser.role,
      roles: rolesResult.rows,
      unreadCount: unreadResult.rows[0]?.unreadcount || 0,
      user: currentUser,
      elections: electionsResult.rows,
      allRoles: allRolesResult.rows,
      start,
      end,
      current,
    });
  } catch (error) {
    console.error("Error fetching voter data:", error);
    res.status(500).send("An error occurred while fetching data");
  }
});

// ============== POST /voters ==============
router.post("/voters", isAuthenticated, upload.single("photo"), async (req, res) => {
  const { firstname, middlename, lastname, dob, username, role, election, password } = req.body;

  if (!firstname || firstname.length < 3 || !lastname || lastname.length < 3) {
    return res.status(400).json({ success: false, message: "First and last name must be at least 3 characters." });
  }

  const photo = req.file ? req.file.buffer : null;
  const votersID = uuidv4();

  try {
    const existing = await pool.query("SELECT * FROM auth WHERE username = $1 AND election_id = $2", [username, election]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ success: false, message: `The username '${username}' is already taken.` });
    }

    const electionResult = await pool.query("SELECT * FROM elections WHERE id = $1", [election]);
    const electionEligibility = electionResult.rows[0];
    if (!electionEligibility) return res.status(400).json({ success: false, message: "Election not found." });

    const age = calculateAge(new Date(dob));
    if (age < electionEligibility.voter_age_eligibility) {
      return res.status(400).json({ success: false, message: `Must be at least ${electionEligibility.voter_age_eligibility} years old.` });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query("BEGIN");

    await pool.query(
      `INSERT INTO users(id, first_name, middle_name, last_name, DOB, profile_picture, role_id, election_id) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [votersID, firstname, middlename, lastname, dob, photo, role, election]
    );

    const authID = uuidv4();
    await pool.query(
      `INSERT INTO auth(id, username, password, user_id, election_id) 
       VALUES ($1, $2, $3, $4, $5)`,
      [authID, username, hashedPassword, votersID, election]
    );

    const message = `Hi ${firstname} ${middlename} ${lastname} (${username}), you have successfully registered for ${electionEligibility.election}!`;

    await pool.query(
      `INSERT INTO notifications (id, username, election, message, title, created_at) 
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [uuidv4(), username, election, message, "Registration Successful"]
    );

    await pool.query("COMMIT");

    const io = getIO(req);
    io.to(username).emit("new-notification", {
      message,
      title: "Registration Successful",
      created_at: new Date(),
    });

    res.status(201).json({ success: true, message: `${username} registered successfully.` });
  } catch (err) {
    await pool.query("ROLLBACK");
    console.error("Error registering voter:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ========== DELETE voters =============
router.post("/delete/users", isAuthenticated, async (req, res) => {
  let { voterIds } = req.body;

  try {
    voterIds = JSON.parse(voterIds);
  } catch {
    return res.redirect("/voters?error=Invalid voter data");
  }

  if (!Array.isArray(voterIds) || voterIds.length === 0) {
    return res.redirect("/voters?error=No voter selected");
  }

  const placeholders = voterIds.map((_, i) => `$${i + 1}`).join(", ");

  try {
    await pool.query(`DELETE FROM users WHERE id IN (${placeholders})`, voterIds);
    await pool.query(`DELETE FROM auth WHERE user_id IN (${placeholders})`, voterIds);
    await pool.query(`DELETE FROM candidates WHERE user_id IN (${placeholders})`, voterIds);
    await pool.query(`DELETE FROM user_votes WHERE user_id IN (${placeholders})`, voterIds);

    return res.redirect("/voters?success=Voter(s) deleted successfully");
  } catch (err) {
    console.error("Error deleting voters:", err);
    return res.redirect("/voters?error=Error deleting voters");
  }
});

// ========== Mark as voted ============
router.post("/voted/users", isAuthenticated, async (req, res) => {
  let { voterIds } = req.body;

  try {
    voterIds = JSON.parse(voterIds);
  } catch {
    return res.redirect("/voters?error=Invalid voter data");
  }

  if (!Array.isArray(voterIds) || voterIds.length === 0) {
    return res.redirect("/voters?error=No voter selected");
  }

  const placeholders = voterIds.map((_, i) => `$${i + 1}`).join(", ");

  try {
    await pool.query(`UPDATE users SET has_voted = 1 WHERE id IN (${placeholders})`, voterIds);

    const values = voterIds.map(id => `('${uuidv4()}', '${id}')`).join(", ");
    await pool.query(`INSERT INTO user_votes (id, user_id) VALUES ${values}`);

    return res.redirect("/voters?success=Marked as voted successfully!");
  } catch (err) {
    console.error("Error marking voted:", err);
    return res.redirect("/voters?error=Error marking voted");
  }
});

// ========== Update User ============
router.post("/update/user", isAuthenticated, async (req, res) => {
  const { id, first_name, middle_name, last_name, role_id } = req.body;

  try {
    await pool.query(
      `UPDATE candidates SET first_name = $1, middle_name = $2, last_name = $3 WHERE user_id = $4`,
      [first_name, middle_name, last_name, id]
    );

    await pool.query(
      `UPDATE users SET first_name = $1, middle_name = $2, last_name = $3, role_id = $4 WHERE id = $5`,
      [first_name, middle_name, last_name, role_id, id]
    );

    res.redirect("/voters?success=User updated successfully!");
  } catch (err) {
    console.error("Error updating user:", err.message);
    res.redirect("/voters?error=Error updating user");
  }
});

function calculateAge(dob) {
  const today = new Date();
  return today.getFullYear() - dob.getFullYear() -
    (today.getMonth() < dob.getMonth() ||
    (today.getMonth() === dob.getMonth() && today.getDate() < dob.getDate()) ? 1 : 0);
}

module.exports = router;
