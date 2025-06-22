const express = require("express");
const router = express.Router();
const { v4: uuidv4 } = require("uuid");
const pool = require("../db");

const secretSavedToken = process.env.ADMIN_SECRET_TOKEN;

// Middleware to validate token access
const validateToken = (req, res, next) => {
  const token = req.query.token;
  if (token !== secretSavedToken) {
    return res.status(403).send("Access Denied");
  }
  next();
};

// ==================== GET /create-election ====================
router.get("/create-election", validateToken, (req, res) => {
  res.render("createElection");
});

// ==================== GET /create-role ====================
router.get("/create-role", validateToken, (req, res) => {
  res.render("createRole");
});

// ==================== POST /create-role ====================
router.post("/create-role", async (req, res) => {
  const { role } = req.body;

  if (!role || role.trim().length === 0) {
    return res.status(400).json({ success: false, message: "Role is required" });
  }

  const roleID = uuidv4();

  try {
    await pool.query("INSERT INTO roles (id, role) VALUES($1, $2)", [roleID, role.trim()]);
    res.status(201).json({ success: true, message: "Role added successfully", roleID });
  } catch (err) {
    console.error("Error inserting role:", err);
    res.status(500).json({ success: false, message: "Error inserting role", error: err.message });
  }
});

module.exports = router;
