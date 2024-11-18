const express = require('express');
const db = require('../model/db');
const router = express.Router();
const bcrypt = require("bcrypt");

router.get("/login", (req, res) => {
    res.render("login.ejs");
  });
  
  router.post("/login", (req, res) => {
    const { username, password } = req.body;
  
    db.get("SELECT * FROM auth WHERE username = ?", [username], (err, user) => {
      if (err) {
        return res.status(500).send("Internal Server Error");
      }
      if (!user) {
        return res.render("login", { errorMessage: "Invalid Username or Password" });
      }
  
      bcrypt.compare(password, user.password, (err, result) => {
        if (result) {
          db.get(
            "SELECT * FROM users WHERE id = ?",
            [user.user_id],
            (err, userData) => {
              if (err) {
                return res.status(500).send("Internal Server Error");
              }
              req.session.userId = user.user_id;
              req.session.profilePicture = userData.profile_picture.toString("base64");
              res.redirect("/dashboard");
            }
          );
        } else {
          res.render("login", { errorMessage: "Invalid Username or Password" });
        }
      });
    });
  });

  module.exports = router;