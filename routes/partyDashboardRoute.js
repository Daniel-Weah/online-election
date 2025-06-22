const express = require("express");
const router = express.Router();
const pool = require("../db");



router.get("/party-dashboard", async (req, res) => {
  if (!req.session.userId || req.session.userRole !== "Candidate") {
    return res.redirect("/login");
  }

  try {
    const candidateRes = await pool.query(
      "SELECT * FROM candidates WHERE user_id = $1",
      [req.session.userId]
    );
    if (candidateRes.rows.length === 0) {
      return res.status(404).send("User not found");
    }

    const currentUser = candidateRes.rows[0];

    const userDetailsRes = await pool.query(
      `SELECT candidates.*, parties.*, users.*
       FROM candidates
       JOIN parties ON candidates.party_id = parties.id
       JOIN users ON candidates.user_id = users.id
       WHERE candidates.election_id = $1 AND candidates.user_id = $2`,
      [currentUser.election_id, currentUser.user_id]
    );

    if (userDetailsRes.rows.length === 0) {
      return res.status(404).send("Candidate not found for the specified election.");
    }

    const user = userDetailsRes.rows[0];
    user.photo = user.photo ? user.photo.toString("base64") : null;
    user.logo = user.logo ? user.logo.toString("base64") : null;

    // Fetch party candidates
    const partyCandidatesRes = await pool.query(
      `SELECT candidates.*, parties.*, users.*, positions.position, 
              COALESCE(votes.vote, 0) AS vote_count
       FROM candidates
       JOIN parties ON candidates.party_id = parties.id
       JOIN users ON candidates.user_id = users.id
       JOIN positions ON candidates.position_id = positions.id
       LEFT JOIN votes ON candidates.id = votes.candidate_id
       WHERE candidates.party_id = $1 AND candidates.election_id = $2
       ORDER BY positions.id`,
      [user.party_id, user.election_id]
    );

    const partyCandidates = partyCandidatesRes.rows.map(candidate => ({
      ...candidate,
      photo: candidate.photo ? candidate.photo.toString("base64") : null,
      logo: candidate.logo ? candidate.logo.toString("base64") : null,
    }));

    // Fetch all candidates for vote calculations
    const allCandidatesRes = await pool.query(
      `SELECT candidates.id AS candidate_id, candidates.position_id,
              users.first_name, users.middle_name, users.last_name,
              COALESCE(votes.vote, 0) AS vote_count
       FROM candidates
       JOIN users ON candidates.user_id = users.id
       LEFT JOIN votes ON candidates.id = votes.candidate_id
       WHERE candidates.election_id = $1`,
      [user.election_id]
    );

    const allCandidates = allCandidatesRes.rows;

    // Vote aggregation
    const voteCounts = {};
    const totalVotesByPosition = {};

    allCandidates.forEach(candidate => {
      const fullName = `${candidate.first_name} ${candidate.middle_name || ""} ${candidate.last_name}`.trim();
      const positionId = candidate.position_id;
      const voteCount = parseInt(candidate.vote_count) || 0;

      if (!voteCounts[positionId]) {
        voteCounts[positionId] = [];
        totalVotesByPosition[positionId] = 0;
      }

      voteCounts[positionId].push({ name: fullName, votes: voteCount });
      totalVotesByPosition[positionId] += voteCount;
    });

    const votePercentageData = {};
    for (let positionId in voteCounts) {
      const total = totalVotesByPosition[positionId];
      votePercentageData[positionId] = voteCounts[positionId].map(c => ({
        name: c.name,
        votes: c.votes,
        percentage: total > 0 ? ((c.votes / total) * 100).toFixed(2) : "0.00",
      }));
    }

    const voteStatus = user.has_voted ? "Voted" : "Not Voted";

    const userRoleRes = await pool.query(
      "SELECT users.role_id, roles.role FROM users JOIN roles ON users.role_id = roles.id WHERE users.id = $1",
      [req.session.userId]
    );
    const userRole = userRoleRes.rows[0];

    const rolesRes = await pool.query("SELECT * FROM roles");
    const roles = rolesRes.rows;

    const notificationRes = await pool.query(
      "SELECT COUNT(*) AS unreadCount FROM notifications WHERE username = $1 AND is_read = 0",
      [user.username]
    );
    const unreadCount = parseInt(notificationRes.rows[0].unreadcount) || 0;

    const electionsRes = await pool.query("SELECT * FROM elections");
    const elections = electionsRes.rows;

    const userElectionRes = await pool.query(
      `SELECT users.*, elections.election AS election_name
       FROM users
       JOIN elections ON users.election_id = elections.id
       WHERE users.id = $1`,
      [req.session.userId]
    );
    const userElectionData = userElectionRes.rows;

    const profilePicture = req.session.profilePicture;

    res.render("party-dashboard", {
      users: partyCandidates,
      votePercentageData,
      profilePicture,
      voteStatus,
      role: userRole.role,
      roles,
      unreadCount,
      user,
      elections,
      userElectionData
    });
  } catch (err) {
    console.error("Server error in /party-dashboard:", err);
    res.status(500).send("Internal server error");
  }
});


module.exports = router;