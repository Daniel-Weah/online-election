const express = require("express");
const bcrypt = require("bcrypt");
const router = express.Router();

const pool  = require("../db");

// GET forget-password page, only for Super Admin
router.get("/forget-password", (req, res) => {
  if (!req.session.userId || req.session.userRole !== "Super Admin") {
    return res.redirect("/login");
  }
  res.render("forget-password");
});

// POST forget-password form
router.post("/forget-password", (req, res) => {
  const { voter_id, password, passwordConfirm } = req.body;

  if (password !== passwordConfirm) {
    return res
      .status(400)
      .json({ success: false, message: "Passwords do not match" });
  }

  pool.query(
    "SELECT * FROM auth WHERE username = $1",
    [voter_id],
    (err, result) => {
      if (err) {
        return res
          .status(500)
          .json({ success: false, message: `An error occurred, ${err}` });
      }

      if (!result.rows.length) {
        return res
          .status(404)
          .json({ success: false, message: "VoterID does not exist" });
      }

      bcrypt.hash(password, 10, (err, hash) => {
        if (err) {
          return res
            .status(500)
            .json({ success: false, message: "An error occurred" });
        }

        pool.query(
          "UPDATE auth SET password = $1 WHERE username = $2",
          [hash, voter_id],
          (err) => {
            if (err) {
              return res
                .status(500)
                .json({ success: false, message: "An error occurred" });
            }

            return res.status(200).json({
              success: true,
              message: "Password Updated Successfully",
            });
          }
        );
      });
    }
  );
});

module.exports = router;
