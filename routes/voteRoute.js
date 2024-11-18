const express = require('express');
const db = require('../model/db');
const router = express.Router();
const multer = require('multer');

const storage = multer.memoryStorage();
const upload = multer({storage: storage});


router.get("/vote", (req, res) => {
    if (!req.session.userId) {
      return res.redirect("/login");
    }
  
    const sql = `
      SELECT candidates.id, candidates.first_name, candidates.last_name, candidates.middle_name, candidates.photo, positions.position, parties.party, IFNULL(votes.vote, 0) AS vote
      FROM candidates
      JOIN positions ON candidates.position_id = positions.id
      JOIN parties ON candidates.party_id = parties.id
      LEFT JOIN votes ON candidates.id = votes.candidate_id
    `;
  
    db.all(sql, [], (err, candidates) => {
      if (err) {
        return res.status(500).send("Error fetching candidates data");
      }
      const profilePicture = req.session.profilePicture;
  
      candidates = candidates.map((candidate) => {
        return {
          ...candidate,
          photo: candidate.photo.toString("base64"), 
        };
      });
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
                  res.render("vote", {
                    candidates,
                    role: userRole.role,
                    profilePicture,
                    unreadCount: countResult.unreadCount,
                    user
                  });
                  });
                }
              );
            }
          );
        }
      );
    });
  });
  
  router.post("/vote", upload.none(), (req, res) => {
    const userId = req.session.userId;
    const candidateId1 = req.body.candidateId;
    const candidateId2 = req.body.candidateId2;
    const candidateId3 = req.body.candidateId3;
  
    const votePromises = [];
  
    db.get(
      "SELECT * FROM user_votes WHERE user_id = ?",
      [userId],
      (err, userVote) => {
        if (err) {
          console.error("Error checking user vote:", err);
          return res
            .status(500)
            .json({ success: false, message: "Database error" });
        }
  
        if (userVote) {
          return res
            .status(403)
            .json({ success: false, message: "You have already voted." });
        }
  
        const handleVote = (candidateId) => {
          return new Promise((resolve, reject) => {
            if (!candidateId) {
              return resolve();
            }
  
            db.get(
              "SELECT * FROM votes WHERE candidate_id = ?",
              [candidateId],
              (err, vote) => {
                if (err) {
                  return reject(err);
                }
  
                if (vote) {
                  db.run(
                    "UPDATE votes SET vote = vote + 1 WHERE candidate_id = ?",
                    [candidateId],
                    (err) => {
                      if (err) {
                        return reject(err);
                      }
                      resolve();
                    }
                  );
                } else {
                  db.run(
                    "INSERT INTO votes (candidate_id, vote) VALUES (?, 1)",
                    [candidateId],
                    (err) => {
                      if (err) {
                        return reject(err);
                      }
                      resolve();
                    }
                  );
                }
              }
            );
          });
        };
  
        if (candidateId1) votePromises.push(handleVote(candidateId1));
        if (candidateId2) votePromises.push(handleVote(candidateId2));
        if (candidateId3) votePromises.push(handleVote(candidateId3));
  
        Promise.all(votePromises)
          .then(() => {
            db.run(
              "INSERT INTO user_votes (user_id) VALUES (?)",
              [userId],
              (err) => {
                if (err) {
                  console.error("Error recording user vote:", err);
                  return res
                    .status(500)
                    .json({ success: false, message: "Database error" });
                }
  
                // Update user status to "Voted"
                db.run(
                  "UPDATE users SET has_voted = 1 WHERE id = ?",
                  [userId],
                  (err) => {
                    if (err) {
                      console.error("Error updating user vote status:", err);
                      return res
                        .status(500)
                        .json({ success: false, message: "Database error" });
                    }
  
                    db.get(
                      "SELECT username FROM auth WHERE id = ?",
                      [req.session.userId],
                      (err, user) => {
                        if (err) {
                          return res.status(500).send("error fetching username");
                        }
                        if (!user) {
                          return res.send("user not found");
                        }
  
                        const currentTime = new Date();
                        const notificationMessage = `Thank you ${user.username}, for casting your vote. It has been successfully counted.`;
                        const notificationTitle = "Vote Counted";
  
                        db.run(
                          `INSERT INTO notifications (username, message, title, created_at) VALUES (?,?,?,?)`,
                          [
                            user.username,
                            notificationMessage,
                            notificationTitle,
                            currentTime,
                          ],
                          function (err) {
                            if (err) {
                              console.error("Error inserting notification:", err);
                              return res
                                .status(500)
                                .json({
                                  success: false,
                                  message: "Database error",
                                });
                            }
  
                            // Emit the notification to the user's room
                            io.to(user.username).emit("new-notification", {
                              message: notificationMessage,
                              title: notificationTitle,
                              created_at: currentTime,
                            });
  
                            res
                              .status(200)
                              .json({
                                success: true,
                                message: "Your vote has been counted",
                              });
                            // Remove or comment out the following line
                            // res.redirect("/dashboard");
                          }
                        );
                      }
                    );
                  }
                );
              }
            );
          })
          .catch((err) => {
            console.error("Error processing votes:", err);
            res.status(500).send("Error processing votes");
          });
      }
    );
  });

  module.exports = router;