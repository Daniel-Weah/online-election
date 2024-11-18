const express = require('express');
const db = require('../model/db');
const router = express.Router();

router.get("/dashboard", (req, res) => {
    if (!req.session.userId) {
      return res.redirect("/login");
    }
  
    const sqlCandidates = `
  SELECT candidates.*, parties.party, parties.logo, positions.position, IFNULL(SUM(votes.vote), 0) AS vote
  FROM candidates
  JOIN parties ON candidates.party_id = parties.id
  JOIN positions ON candidates.position_id = positions.id
  LEFT JOIN votes ON candidates.id = votes.candidate_id
  GROUP BY candidates.id
  `;
  
    const sqlTotalVotesPerPosition = `
  SELECT positions.position, SUM(IFNULL(votes.vote, 0)) AS totalVotes
  FROM candidates
  JOIN positions ON candidates.position_id = positions.id
  LEFT JOIN votes ON candidates.id = votes.candidate_id
  GROUP BY positions.position
  `;
  
    db.get(
      "SELECT COUNT(username) AS totalUsers FROM auth",
      [],
      (err, result) => {
        if (err) {
          return res.status(500).send("Error fetching total users");
        }
        const totalUsers = result.totalUsers;
        const profilePicture = req.session.profilePicture;
  
        db.all(sqlTotalVotesPerPosition, [], (err, totalVotesPerPosition) => {
          if (err) {
            return res
              .status(500)
              .send("Error fetching total votes per position");
          }
  
          const totalVotesMap = {};
          totalVotesPerPosition.forEach((row) => {
            totalVotesMap[row.position] = row.totalVotes || 0;
          });
  
          db.all(sqlCandidates, [], (err, candidates) => {
            if (err) {
              return res.status(500).send("Error fetching candidates data");
            }
  
            candidates = candidates.map((candidate) => {
              return {
                ...candidate,
                photo: candidate.photo.toString("base64"),
                logo: candidate.logo.toString("base64"),
                votePercentage:
                  totalVotesMap[candidate.position] > 0
                    ? (candidate.vote / totalVotesMap[candidate.position]) * 100
                    : 0,
              };
            });
  
            const totalVotes = totalVotesPerPosition.reduce(
              (acc, row) => acc + row.totalVotes,
              0
            );
  
            db.get(
              "SELECT users.role_id, roles.role FROM users JOIN roles ON users.role_id = roles.id WHERE users.id = ?",
              [req.session.userId],
              (err, userRole) => {
                if (err) {
                  return res.status(500).send("Error fetching user role");
                }
  
                db.get(
                  "SELECT username FROM auth WHERE id = ?",
                  [req.session.userId],
                  (err, user) => {
                    if (err) {
                      return res.status(500).send("Error fetching user");
                    }
  
                    if (!user) {
                      return res.status(404).send("User not found");
                    }
  
                    db.get(
                      "SELECT COUNT(*) AS unreadCount FROM notifications WHERE username = ? AND is_read = 0",
                      [user.username],
                      (err, countResult) => {
                        if (err) {
                          return res
                            .status(500)
                            .send("Error fetching unread notifications count");
                        }
                        db.get("SELECT * FROM users WHERE id = ?", [req.session.userId], (err, user) => {
                          if(err) {
                            return res.status(500).send('Error fetching user from the user table')
                          }
                        
                        res.render("dashboard", {
                          totalUsers,
                          profilePicture,
                          candidates,
                          totalVotes,
                          role: userRole.role,
                          unreadCount: countResult.unreadCount,
                          user
                        });
                      }
                    );
                  }
                );
                  }
                );
              }
            );
          });
        });
      }
    );
  });

  module.exports = router;