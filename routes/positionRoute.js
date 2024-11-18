const express = require('express');
const db = require('../model/db');
const router = express.Router();


router.get("/add/position", (req, res) => {
    if (!req.session.userId) {
      return res.redirect("/login");
    }
    db.all("SELECT * FROM positions", [], (err, positions) => {
      if (err) {
        return res.status.send("Internal server error");
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
                  db.get("SELECT * FROM users WHERE id = ?", [req.session.userId], (err, user) => {
                    if(err) {
                      return res.status(500).send('Error fetching user from the user table')
                    }
                  res.render("Position.ejs", {
                    positions,
                    profilePicture,
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
    });
    });
  });
  
  router.post("/add/position", (req, res) => {
    const { Position } = req.body;
  
    db.run("INSERT INTO positions (position) VALUES (?)", [Position], (err) => {
      if (err) {
        return console.log(err.message);
      }
      console.log("New record has been added");
      res.send("Position has been successfully added");
    });
  });
  
  router.post("/delete/position/:id", (req, res) => {
    const id = req.params.id;
    db.run("DELETE FROM positions WHERE id = ?", [id]);
    res.redirect("/add/position");
  });

  module.exports = router;