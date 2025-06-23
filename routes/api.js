// routes/api.js
const express = require("express");
const router = express.Router();
const pool = require("../db");

router.get("/dashboard-live-data", async (req, res) => {
  const electionId = req.query.electionId;

  if (!electionId) return res.status(400).json({ error: "Missing election ID" });

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

    const [candidatesQuery, totalVotesPerPositionQuery, totalVotesQuery] = await Promise.all([
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
      totalUsers
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch live dashboard data" });
  }
});

module.exports = router;
