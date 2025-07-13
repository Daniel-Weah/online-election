const express = require("express");
const router = express.Router();
const pool = require("../db");
const { isAuthenticated } = require("../middlewares/auth");

router.get("/dashboard", async (req, res) => {
  if (!req.session.userId) {
    return res.redirect("/login");
  }

  try {
    const electionId = req.query.electionId || null;

    // Get the election ID associated with the user
    const userElectionQuery = await pool.query(
      "SELECT election_id FROM users WHERE id = $1",
      [req.session.userId]
    );

    const userElectionId = electionId || userElectionQuery.rows[0]?.election_id;

    if (!userElectionId) {
      return res.status(404).send("Election not selected or registered");
    }

    // Fetch candidates and votes
    const sqlCandidates = `
      SELECT candidates.*, parties.party, parties.logo, positions.position, 
             COALESCE(SUM(votes.vote), 0) AS vote
      FROM candidates
      JOIN parties ON candidates.party_id = parties.id
      JOIN positions ON candidates.position_id = positions.id
      LEFT JOIN votes ON candidates.id = votes.candidate_id
      WHERE candidates.election_id = $1
      GROUP BY candidates.id, parties.party, parties.logo, positions.position
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

    // Fetch total users
    const totalUsersQuery = await pool.query(
      `SELECT COUNT(*) AS totalUsers 
       FROM auth 
       JOIN users ON auth.user_id = users.id 
       WHERE users.election_id = $1`,
      [userElectionId]
    );

    const totalUsers = totalUsersQuery.rows[0].totalusers;

    // Fetch total votes per position
    const totalVotesPerPositionQuery = await pool.query(
      sqlTotalVotesPerPosition,
      [userElectionId]
    );

    const totalVotesMap = {};
    totalVotesPerPositionQuery.rows.forEach((row) => {
      totalVotesMap[row.position] = row.totalvotes || 0;
    });

    // Fetch candidates
    const candidatesQuery = await pool.query(sqlCandidates, [userElectionId]);

    let candidates = candidatesQuery.rows.map((candidate) => ({
      ...candidate,
      photo: candidate.photo ? candidate.photo.toString("base64") : null,
      logo: candidate.logo ? candidate.logo.toString("base64") : null,
      votePercentage:
        totalVotesMap[candidate.position] > 0
          ? (candidate.vote / totalVotesMap[candidate.position]) * 100
          : 0,
    }));

    // Calculate total votes
    const totalVotesQuery = await pool.query(sqlTotalVotes, [userElectionId]);
    const totalVotes = totalVotesQuery.rows[0].totalvotes || 0;

    // Group candidates by position
    const groupedCandidates = candidates.reduce((acc, candidate) => {
      if (!acc[candidate.position]) {
        acc[candidate.position] = [];
      }
      acc[candidate.position].push(candidate);
      return acc;
    }, {});

    // Fetch user role
    const userRoleQuery = await pool.query(
      "SELECT users.role_id, roles.role FROM users JOIN roles ON users.role_id = roles.id WHERE users.id = $1",
      [req.session.userId]
    );

    // Fetch user data
    const userQuery = await pool.query(
      "SELECT username FROM auth WHERE user_id = $1",
      [req.session.userId]
    );

    if (userQuery.rows.length === 0) {
      return res.status(404).send("User not found");
    }

    const username = userQuery.rows[0].username;

    // Fetch unread notifications count
    const unreadCountQuery = await pool.query(
      "SELECT COUNT(*) AS unreadCount FROM notifications WHERE username = $1 AND is_read = 0",
      [username]
    );

    // Fetch user details
    const userDetailsQuery = await pool.query(
      "SELECT * FROM users WHERE id = $1",
      [req.session.userId]
    );

    const currentUserSql = `
    SELECT users.*, roles.role, auth.username
    FROM users
    JOIN roles ON users.role_id = roles.id
    JOIN auth ON users.id = auth.user_id
    WHERE users.id = $1
  `;
  const userResult = await pool.query(currentUserSql, [req.session.userId]);

  if (userResult.rows.length === 0) {
    return res.status(404).send("User not found");
  }

  let user = userResult.rows[0];
  user.profile_picture = user.profile_picture
    ? Buffer.from(user.profile_picture).toString("base64")
    : null;
    // Fetch election settings
    const electionSettingsSql = `SELECT * FROM election_settings WHERE election_id = $1`;
    const electionSettingsResult = await pool.query(electionSettingsSql, [
      user.election_id,
    ]);

    const registrationTiming = electionSettingsResult.rows[0];

    const currentTime = new Date().toLocaleTimeString("en-US", {
      hour12: false,
    });
    const electionStartTime = registrationTiming.start_time;
    // const electionEndTime = registrationTiming.end_time;
    const electionEndTime = registrationTiming.end_time;
    const adminEndTime = registrationTiming.admin_end_time;

    const currentDate = electionStartTime.split("T")[0];
    const fullCurrentTime = `${currentDate}T${currentTime}`;

    const end = new Date(electionEndTime);
    const start = new Date(electionStartTime);
    const admin_end = new Date(adminEndTime);
    const current = new Date(fullCurrentTime);

    // Fetch all elections
    const electionsQuery = await pool.query("SELECT * FROM elections");

    const profilePicture = req.session.profilePicture;
    res.render("dashboard", {
      totalUsers,
      candidates,
      totalVotes,
      groupedCandidates,
      elections: electionsQuery.rows,
      selectedElection: userElectionId,
      role: userRoleQuery.rows[0]?.role,
      unreadCount: unreadCountQuery.rows[0]?.unreadcount || 0,
      user: userDetailsQuery.rows[0],
      profilePicture,
      current: new Date().toISOString(),
      admin_end: new Date(admin_end).toISOString(), 
      end: new Date(end).toISOString(),
      start: new Date(start).toISOString(),
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Internal Server Error");
  }
});

module.exports = router;
