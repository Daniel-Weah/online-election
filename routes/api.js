// routes/api.js
const express = require("express");
const router = express.Router();
const pool = require("../db");

router.get("/dashboard-live-data", async (req, res) => {
  const electionId = req.query.electionId;

  if (!electionId)
    return res.status(400).json({ error: "Missing election ID" });

  try {
    const sqlCandidates = `
      SELECT candidates.*, parties.party, positions.position,
             COALESCE(SUM(votes.vote), 0) AS vote
      FROM candidates
      JOIN parties ON candidates.party_id = parties.id
      JOIN positions ON candidates.position_id = positions.id
      LEFT JOIN votes ON candidates.id = votes.candidate_id
      WHERE candidates.election_id = $1
      GROUP BY candidates.id, parties.party, positions.position
    `;

    const sqlTotalVotesPerPosition = `
      SELECT positions.position, COALESCE(SUM(votes.vote), 0) AS totalVotes
      FROM candidates
      JOIN positions ON candidates.position_id = positions.id
      LEFT JOIN votes ON candidates.id = votes.candidate_id
      WHERE candidates.election_id = $1
      GROUP BY positions.position
    `;

    const sqlTotalVotes = `
      SELECT COALESCE(SUM(votes.vote), 0) AS totalVotes
      FROM candidates
      LEFT JOIN votes ON candidates.id = votes.candidate_id
      WHERE candidates.election_id = $1
    `;

    const [candidatesQuery, totalVotesPerPositionQuery, totalVotesQuery] =
      await Promise.all([
        pool.query(sqlCandidates, [electionId]),
        pool.query(sqlTotalVotesPerPosition, [electionId]),
        pool.query(sqlTotalVotes, [electionId]),
      ]);

    const totalVotesMap = {};
    totalVotesPerPositionQuery.rows.forEach((row) => {
      totalVotesMap[row.position] = row.totalvotes || 0;
    });

    let candidates = candidatesQuery.rows.map((candidate) => ({
      ...candidate,
      votePercentage:
        totalVotesMap[candidate.position] > 0
          ? (candidate.vote / totalVotesMap[candidate.position]) * 100
          : 0,
    }));

    const groupedCandidates = candidates.reduce((acc, candidate) => {
      if (!acc[candidate.position]) acc[candidate.position] = [];
      acc[candidate.position].push(candidate);
      return acc;
    }, {});

    // Fetch total users
    const totalUsersQuery = await pool.query(
      `SELECT COUNT(*) AS totalUsers 
   FROM auth 
   JOIN users ON auth.user_id = users.id 
   WHERE users.election_id = $1`,
      [electionId]
    );

    const totalUsers = parseInt(totalUsersQuery.rows[0].totalusers);

    res.json({
      totalVotes: totalVotesQuery.rows[0].totalvotes || 0,
      groupedCandidates,
      totalUsers,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch live dashboard data" });
  }
});


router.get("/vote-data", async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const user = await pool.query("SELECT * FROM users WHERE id = $1", [req.session.userId]);
    if (!user.rows.length) return res.status(404).json({ error: "User not found" });

    const electionID = user.rows[0].election_id;

    const result = await pool.query(`
      SELECT positions.position, candidates.first_name, candidates.middle_name, 
             candidates.last_name, candidates.photo, COALESCE(SUM(votes.vote), 0) AS vote
      FROM candidates
      JOIN positions ON candidates.position_id = positions.id
      LEFT JOIN votes ON candidates.id = votes.candidate_id
      WHERE candidates.election_id = $1
      GROUP BY positions.position, candidates.id
      ORDER BY positions.position, candidates.last_name
    `, [electionID]);

    const groupedData = {};
    result.rows.forEach(candidate => {
      const position = candidate.position.trim().replace(/\s+/g, " ");
      const name = `${candidate.first_name} ${candidate.middle_name || ""} ${candidate.last_name}`.trim();

      if (!groupedData[position]) {
        groupedData[position] = { candidates: [] };
      }

      groupedData[position].candidates.push({
        name,
        vote: candidate.vote,
        photo: candidate.photo
          ? `data:image/jpeg;base64,${candidate.photo.toString("base64")}`
          : ""
      });
    });

    res.json(groupedData);
  } catch (err) {
    console.error("Error fetching vote data:", err);
    res.status(500).json({ error: "Failed to fetch vote data" });
  }
});



module.exports = router;
