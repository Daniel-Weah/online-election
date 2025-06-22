const express = require("express");
const router = express.Router();
const pool = require("../db");
const { v4: uuidv4 } = require("uuid");
const multer = require("multer");
const { isAuthenticated } = require("../middlewares/auth");

const storage = multer.memoryStorage();
const upload = multer({ storage });

// ✅ GET: Party registration page
router.get("/create/party", isAuthenticated, async (req, res) => {
  try {
    if (!["Super Admin", "Admin"].includes(req.session.userRole)) {
      return res.redirect("/login");
    }

    const [partiesResult, userRoleResult, userResult, userDataResult, electionsResult, userElectionDataResult] = await Promise.all([
      pool.query(`
        SELECT parties.*, elections.election 
        FROM parties 
        JOIN elections ON parties.election_id = elections.id
      `),
      pool.query(`
        SELECT users.role_id, roles.role 
        FROM users 
        JOIN roles ON users.role_id = roles.id 
        WHERE users.id = $1
      `, [req.session.userId]),
      pool.query(`SELECT username FROM auth WHERE user_id = $1`, [req.session.userId]),
      pool.query(`SELECT * FROM users WHERE id = $1`, [req.session.userId]),
      pool.query(`SELECT * FROM elections`),
      pool.query(`
        SELECT users.*, elections.election AS election_name 
        FROM users 
        JOIN elections ON users.election_id = elections.id 
        WHERE users.id = $1
      `, [req.session.userId]),
    ]);

    if (userResult.rows.length === 0 || userDataResult.rows.length === 0) {
      return res.status(404).send("User not found");
    }

    const parties = partiesResult.rows.map(p => ({
      ...p,
      logo: p.logo ? p.logo.toString("base64") : null
    }));

    const AdminpartiesResult = await pool.query(
      "SELECT * FROM parties WHERE election_id = $1",
      [userDataResult.rows[0].election_id]
    );

    const Adminparties = AdminpartiesResult.rows.map(p => ({
      ...p,
      logo: p.logo ? p.logo.toString("base64") : null
    }));

    const unreadCountResult = await pool.query(
      "SELECT COUNT(*) AS unread_count FROM notifications WHERE username = $1 AND is_read = 0",
      [userResult.rows[0].username]
    );

    res.render("party-registration", {
      parties,
      Adminparties,
      role: userRoleResult.rows[0].role,
      profilePicture: req.session.profilePicture,
      unreadCount: unreadCountResult.rows[0].unread_count,
      user: userDataResult.rows[0],
      userElectionData: userElectionDataResult.rows[0],
      elections: electionsResult.rows
    });

  } catch (err) {
    console.error("Error fetching data:", err);
    res.status(500).send("Internal server error");
  }
});

// ✅ POST: Create a party
router.post("/create/party", isAuthenticated, upload.single("logo"), (req, res) => {
  const { election, party } = req.body;
  const logo = req.file ? req.file.buffer : null;

  const partyID = uuidv4();

  pool.query(
    "INSERT INTO parties (id, election_id, party, logo) VALUES ($1, $2, $3, $4)",
    [partyID, election, party, logo],
    function (err) {
      if (err) {
        console.error(err.message);
        return res.status(500).send("Error saving party information");
      }
      res.status(200).send(`${party} created successfully`);
    }
  );
});

// ✅ POST: Update a party
router.post("/update/party", isAuthenticated, upload.single("logo"), (req, res) => {
  const { id, party } = req.body;
  const logo = req.file ? req.file.buffer : null;

  const query = logo
    ? `UPDATE parties SET party = $1, logo = $2 WHERE id = $3`
    : `UPDATE parties SET party = $1 WHERE id = $2`;

  const params = logo ? [party, logo, id] : [party, id];

  pool.query(query, params, function (err) {
    if (err) {
      console.error("Error updating party:", err.message);
      return res.redirect("/create/party?error=Error updating party");
    }
    res.redirect("/create/party?success=Party Updated Successfully!");
  });
});

// ✅ POST: Delete parties
router.post("/delete/party", (req, res) => {
  let { voterIds } = req.body;

  if (!voterIds) {
      return res.redirect("/create/party?error=No party selected");
  }

  try {
      voterIds = JSON.parse(voterIds);
  } catch (error) {
      return res.redirect("/create/party?error=Invalid party data");
  }

  if (!Array.isArray(voterIds) || voterIds.length === 0) {
      return res.redirect("/create/party?error=No party selected");
  }

  const placeholders = voterIds.map((_, i) => `$${i + 1}`).join(", ");

  pool.query(`DELETE FROM parties WHERE id IN (${placeholders})`, voterIds, function (err) {
      if (err) {
          console.error("Error deleting party:", err.message);
          return res.redirect("/create/party?error=Error deleting party");
      }
      res.redirect("/create/party?success=Party Deleted Successfully!");
  });
});

module.exports = router;
