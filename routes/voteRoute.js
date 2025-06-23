const express = require("express");
const router = express.Router();
const pool = require("../db");
const { v4: uuidv4 } = require("uuid");
router.use(express.urlencoded({ extended: true }));
const getIO = (req) => req.app.get("io");
const multer = require("multer");

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });
// GET /vote
router.get("/vote", async (req, res) => {
  if (!req.session.userId) {
    return res.redirect("/login");
  }

  try {
    const userResult = await pool.query("SELECT * FROM users WHERE id = $1", [
      req.session.userId,
    ]);
    if (!userResult.rows.length) return res.status(404).send("User not found");

    const electionId = userResult.rows[0].election_id;
    const profilePicture = req.session.profilePicture;

    const candidatesSql = `
      SELECT candidates.id, candidates.first_name, candidates.last_name, candidates.middle_name,
             candidates.photo, positions.position, parties.party, COALESCE(votes.vote, 0) AS vote
      FROM candidates
      JOIN positions ON candidates.position_id = positions.id
      JOIN parties ON candidates.party_id = parties.id
      LEFT JOIN votes ON candidates.id = votes.candidate_id
      WHERE candidates.election_id = $1
    `;
    const candidatesResult = await pool.query(candidatesSql, [electionId]);

    const candidates = candidatesResult.rows.map((candidate) => ({
      ...candidate,
      photo: candidate.photo ? candidate.photo.toString("base64") : null,
    }));

    const groupedCandidates = candidates.reduce((acc, candidate) => {
      if (!acc[candidate.position]) acc[candidate.position] = [];
      acc[candidate.position].push(candidate);
      return acc;
    }, {});

    const roleResult = await pool.query(
      `SELECT users.role_id, roles.role 
       FROM users 
       JOIN roles ON users.role_id = roles.id 
       WHERE users.id = $1`,
      [req.session.userId]
    );

    const authResult = await pool.query(
      `SELECT username FROM auth WHERE user_id = $1`,
      [req.session.userId]
    );
    if (!authResult.rows.length)
      return res.status(404).send("User auth not found");

    const username = authResult.rows[0].username;

    const unreadResult = await pool.query(
      `SELECT COUNT(*) AS unreadCount FROM notifications WHERE username = $1 AND is_read = 0`,
      [username]
    );
    const unreadCount = parseInt(unreadResult.rows[0].unreadcount, 10) || 0;

    const fullUserResult = await pool.query(
      "SELECT * FROM users WHERE id = $1",
      [req.session.userId]
    );
    if (!fullUserResult.rows.length)
      return res.status(404).send("User data not found");

    const userElectionID = fullUserResult.rows[0].election_id;

    const electionSettingsResult = await pool.query(
      "SELECT * FROM election_settings WHERE election_id = $1",
      [userElectionID]
    );
    if (!electionSettingsResult.rows.length)
      return res.status(404).send("Election settings not found");

    const settings = electionSettingsResult.rows[0];

    res.render("vote", {
      candidates,
      groupedCandidates,
      role: roleResult.rows[0].role,
      profilePicture,
      unreadCount,
      user: fullUserResult.rows[0],
      userElectionID,
      start: new Date(settings.start_time).getTime(),
      end: new Date(settings.end_time).getTime(),
      current: Date.now(),
      admin_start: new Date(settings.admin_start_time).getTime(),
      admin_end: new Date(settings.admin_end_time).getTime(),
    });
  } catch (error) {
    console.error("Error in /vote route:", error);
    res.status(500).send("An error occurred while loading the voting page");
  }
});

// POST /local-vote-count
router.post("/local-vote-count", upload.none(), async (req, res) => {
  const { votes } = req.body;

  try {
    const voteEntries = Object.entries(votes || {});
    if (voteEntries.length === 0) {
      return res.status(400).json({ error: "No votes submitted." });
    }

    for (const [candidate_id, count] of voteEntries) {
      const parsedCount = parseInt(count, 10);
      if (isNaN(parsedCount) || parsedCount < 0) continue;

      await pool.query(
        `INSERT INTO votes (candidate_id, vote)
         VALUES ($1, $2)
         ON CONFLICT (candidate_id)
         DO UPDATE SET vote = votes.vote + EXCLUDED.vote`,
        [candidate_id, parsedCount]
      );
    }
    const io = getIO(req);

    if (io) {
      const firstCandidateId = Object.keys(votes || {})[0];
      const electionRes = await pool.query(
        `SELECT election_id FROM candidates WHERE id = $1`,
        [firstCandidateId]
      );
      const electionId = electionRes.rows[0]?.election_id;

      if (electionId) {
        io.emit("vote-updated", { electionId });
        console.log("📢 Emitting 'vote-updated' for election:", electionId);
      }
    }

    res.status(201).json({ message: "Votes incremented successfully." });
  } catch (err) {
    console.error("Error incrementing votes:", err);
    res.status(500).json({ error: "Failed to process votes." });
  }
});

router.post("/vote", upload.none(), async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }

  console.log(req.body);
  const userId = req.session.userId;
  const electionID = req.body.electionID;
  const positions = Object.keys(req.body).filter((k) => k !== "electionID");
  const userVotesID = uuidv4();

  try {
    const client = await pool.connect();
    const io = getIO(req);

    try {
      await client.query("BEGIN");

      const userVoteCheck = await client.query(
        "SELECT * FROM user_votes WHERE user_id = $1",
        [userId]
      );
      if (userVoteCheck.rows.length > 0) {
        await client.release();
        return res
          .status(403)
          .json({ success: false, message: "Sorry! You have already voted." });
      }

      for (const position of positions) {
        const candidateId = req.body[position];
        if (!candidateId) continue;

        const existingVote = await client.query(
          "SELECT * FROM votes WHERE candidate_id = $1",
          [candidateId]
        );

        if (existingVote.rows.length > 0) {
          await client.query(
            "UPDATE votes SET vote = vote + 1 WHERE candidate_id = $1",
            [candidateId]
          );
        } else {
          await client.query(
            "INSERT INTO votes (candidate_id, vote) VALUES ($1, 1)",
            [candidateId]
          );
        }
      }

      await client.query(
        "INSERT INTO user_votes (id, user_id) VALUES ($1, $2)",
        [userVotesID, userId]
      );
      await client.query("UPDATE users SET has_voted = 1 WHERE id = $1", [
        userId,
      ]);

      const userResult = await client.query(
        "SELECT username FROM auth WHERE user_id = $1",
        [userId]
      );
      if (!userResult.rows.length) {
        await client.release();
        return res
          .status(404)
          .json({ success: false, message: "User not found" });
      }

      const username = userResult.rows[0].username;
      const currentTime = new Date();

      await client.query(
        `INSERT INTO notifications (id, username, election, message, title, created_at) 
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          userVotesID,
          username,
          electionID,
          `Thank you ${username}, for casting your vote. It has been successfully counted.`,
          "Vote Counted",
          currentTime,
        ]
      );

      await client.query("COMMIT");
      client.release();

      // Emit notification via socket
      if (io) {
        io.to(username).emit("new-notification", {
          message: `Thank you ${username}, for casting your vote. It has been successfully counted.`,
          title: "Vote Counted",
          created_at: currentTime,
        });

        io.emit("vote-updated", { electionId: electionID });
      }

      res
        .status(200)
        .json({ success: true, message: "Your vote has been counted" });
    } catch (err) {
      await client.query("ROLLBACK");
      client.release();
      throw err;
    }
  } catch (err) {
    console.error("Error processing votes:", err);
    res.status(500).json({ success: false, message: "Error processing votes" });
  }
});

module.exports = router;
