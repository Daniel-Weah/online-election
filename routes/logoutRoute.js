const express = require("express");
const router = express.Router();

router.get("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error("Logout error:", err);
      return res.status(500).send("Could not log out. Please try again.");
    }
    res.clearCookie("connect.sid");
    res.redirect("/login");
  });
});

module.exports = router;