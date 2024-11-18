const express = require('express');
const db = require('../model/db');
const multer = require('multer');

const router = express.Router();

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

router.get("/candidate/registration", (req, res) => {
    if (!req.session.userId) {
      return res.redirect("/login");
    }
    db.all("SELECT * FROM parties", [], (err, parties) => {
      if (err) {
        return res.status(500).send("Error fetching parties information");
      }
  
      db.all("SELECT * FROM positions", [], (err, positions) => {
        if (err) {
          return res.status(500).send("Error fetching positions information");
        }
  
        const profilePicture = req.session.profilePicture;
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
  
                // Fetch unread notifications count
                db.get(
                  "SELECT COUNT(*) AS unreadCount FROM notifications WHERE username = ? AND is_read = 0",
                  [user.username],
                  (err, countResult) => {
                    if (err) {
                      return res
                        .status(500)
                        .send("Error fetching unread notifications count");
                    }
                    db.all(
                      `SELECT candidates.*, parties.party, parties.logo, positions.position,votes.vote AS vote 
                    FROM candidates
                    JOIN parties ON candidates.party_id = parties.id 
                    JOIN positions ON candidates.position_id = positions.id
                    LEFT JOIN votes ON candidates.id = votes.candidate_id
                    ORDER BY candidates.id
                    `,
                      [],
                      (err, candidates) => {
                        if (err) {
                          return res
                            .status(500)
                            .send("error fetching candidates");
                        }
                        candidates = candidates.map((candidate) => {
                          return {
                            ...candidate,
                            photo: candidate.photo.toString("base64"),
                            logo: candidate.logo.toString("base64"),
                            
                          };
                        });
                        db.get("SELECT * FROM users WHERE id = ?", [req.session.userId], (err, user) => {
                          if(err) {
                            return res.status(500).send('Error fetching user from the user table')
                          }
                        res.render("Candidate-Registration", {
                          parties,
                          positions,
                          profilePicture,
                          role: userRole.role,
                          unreadCount: countResult.unreadCount,
                          candidates,
                          user
                        });
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
  });
  
  
  router.post("/candidate/registration", upload.single("photo"), (req, res) => {
    const { firstname, middlename, lastname, party, position } = req.body;
    const photo = req.file ? req.file.buffer : null;
  
    db.run(
      "INSERT INTO candidates (first_name, middle_name, last_name, party_id, position_id, photo) VALUES (?,?,?,?,?,?)",
      [firstname, middlename, lastname, party, position, photo],
      function (err) {
        if (err) {
          console.error(err.message);
          res
            .status(500)
            .json({
              success: false,
              message:
                "There was a problem sending your information. Please try again later",
            });
        } else {
          res
            .status(200)
            .json({
              success: true,
              message: `Candidate, ${firstname} ${middlename} ${lastname} has been registered.`,
            });
        }
      }
    );
  });

  module.exports = router;