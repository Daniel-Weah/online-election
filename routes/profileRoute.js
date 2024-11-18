const express = require('express');
const router = express.Router();
const db = require('../model/db');

router.get("/my/profile", (req, res) => {
    if (!req.session.userId) {
      return res.redirect("/login");
    }
  
    const sql = `
      SELECT users.*, roles.role, auth.username
      FROM users
      JOIN roles ON users.role_id = roles.id
      JOIN auth ON users.id = auth.user_id
      WHERE users.id = ?
    `;
  
    db.get(sql, [req.session.userId], (err, user) => {
      if (err) {
        return res.status(500).send("An error occurred");
      }
      if (!user) {
        return res.status(404).send("User not found");
      }
  
      user.profile_picture = user.profile_picture.toString("base64");
  
      const voteStatus = user.has_voted ? "Voted" : "Not Voted";
  
      res.render("Profile", { user, voteStatus });
    });
  });

  module.exports = router;
  