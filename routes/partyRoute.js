const express = require('express');
const db = require('../model/db');
const router = express.Router();

const multer = require("multer");

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });


// Route to render party registration form
router.get("/create/party", (req, res) => {
    if (!req.session.userId) {
      return res.redirect("/login");
    }
    db.all("SELECT * FROM parties", [], (err, parties) => {
      if (err) {
        return res.status(500).send("Internal server error");
      }
  
      parties.forEach((party) => {
        if (party.logo) {
          party.logo = party.logo.toString("base64");
        }
      });
  
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
                  db.get("SELECT * FROM users WHERE id = ?", [req.session.userId], (err, user) => {
                    if(err) {
                      return res.status(500).send('Error fetching user from the user table')
                    }
                  res.render("Party-Registration", {
                    parties,
                    role: userRole.role,
                    profilePicture,
                    unreadCount: countResult.unreadCount,
                    user
                  });
                }
              );
            }
          );
        }
      );
    });
  });
  });
  
  router.post("/create/party", upload.single("logo"), (req, res) => {
    const { party } = req.body;
    const logo = req.file ? req.file.buffer : null;
  
    db.run(
      "INSERT INTO parties (party, logo) VALUES (?, ?)",
      [party, logo],
      function (err) {
        if (err) {
          console.error(err.message);
          return res.status(500).send("Error saving party information");
        }
        console.log(`A row has been inserted with rowid ${this.lastID}`);
        res.status(200).send("Party created successfully");
      }
    );
  });
  
  // Handle delete request
  router.post("/delete/party/:id", (req, res) => {
    const id = req.params.id;
    db.run("DELETE FROM parties WHERE id = ?", [id]);
    res.redirect("/create/party");
  });

  module.exports = router;