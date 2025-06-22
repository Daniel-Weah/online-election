const express = require("express");
const sanitizeHtml = require("sanitize-html");
const { v4: uuidv4 } = require("uuid");

const pool = require("../db");

const router = express.Router();

// Middleware to check if user is logged in and has proper role
function ensureAdminOrSuperAdmin(req, res, next) {
  if (
    !req.session.userId ||
    (req.session.userRole !== "Super Admin" && req.session.userRole !== "Admin")
  ) {
    return res.redirect("/login");
  }
  next();
}

// GET route to render create notification page
router.get("/create/notification", ensureAdminOrSuperAdmin, async (req, res) => {
  try {
    // Fetch current user details
    const currentUserSql = `
      SELECT users.*, roles.role, auth.username
      FROM users
      JOIN roles ON users.role_id = roles.id
      JOIN auth ON users.id = auth.user_id
      WHERE users.id = $1
    `;
    const currentUserResult = await pool.query(currentUserSql, [req.session.userId]);
    const user = currentUserResult.rows[0];

    if (!user) {
      return res.status(404).send("User not found");
    }

    user.profile_picture = user.profile_picture
      ? user.profile_picture.toString("base64")
      : null;

    // Fetch all users with their roles and usernames
    const allUsersSql = `
      SELECT users.*, roles.role, auth.username
      FROM users
      JOIN roles ON users.role_id = roles.id
      JOIN auth ON users.id = auth.user_id
      ORDER BY users.id DESC
    `;
    const allUsersResult = await pool.query(allUsersSql);
    const users = allUsersResult.rows;

    // Convert profile pictures to base64 if present
    users.forEach((u) => {
      if (u.profile_picture) {
        u.profile_picture = u.profile_picture.toString("base64");
      }
    });

    const voteStatus = user.has_voted ? "Voted" : "Not Voted";

    // Fetch user role
    const userRoleSql = `
      SELECT users.role_id, roles.role 
      FROM users 
      JOIN roles ON users.role_id = roles.id 
      WHERE users.id = $1
    `;
    const userRoleResult = await pool.query(userRoleSql, [req.session.userId]);
    const userRole = userRoleResult.rows[0];

    // Fetch all roles
    const rolesSql = `SELECT * FROM roles`;
    const rolesResult = await pool.query(rolesSql);
    const roles = rolesResult.rows;

    // Fetch username for notification count
    const userAuthSql = `SELECT username FROM auth WHERE user_id = $1`;
    const userAuthResult = await pool.query(userAuthSql, [req.session.userId]);
    const username = userAuthResult.rows[0].username;

    // Fetch unread notifications count
    const unreadCountSql = `
      SELECT COUNT(*) AS unreadCount 
      FROM notifications 
      WHERE username = $1 AND is_read = 0
    `;
    const unreadCountResult = await pool.query(unreadCountSql, [username]);
    const unreadCount = unreadCountResult.rows[0].unreadcount;

    // Fetch elections
    const electionsSql = `SELECT * FROM elections`;
    const electionsResult = await pool.query(electionsSql);
    const elections = electionsResult.rows;

    // Fetch user election data
    const userElectionDataSql = `
      SELECT users.*, elections.election AS election_name
      FROM users
      JOIN elections ON users.election_id = elections.id
      WHERE users.id = $1
    `;
    const userElectionDataResult = await pool.query(userElectionDataSql, [
      req.session.userId,
    ]);
    const userElectionData = userElectionDataResult.rows;

    const profilePicture = req.session.profilePicture;

    res.render("create-notification", {
      users,
      currentUser: user,
      profilePicture,
      voteStatus,
      role: userRole.role,
      roles,
      unreadCount,
      user,
      elections,
      userElectionData,
    });
  } catch (err) {
    console.error("Error:", err);
    res.status(500).send("An error occurred");
  }
});

// POST route to create notifications
router.post("/create/notification", ensureAdminOrSuperAdmin, async (req, res) => {
  const { election, message, title } = req.body;
  const io = req.app.get('io');
  // Sanitize message HTML
  const sanitizedMessage = sanitizeHtml(message, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat([
      "u",
      "b",
      "i",
      "ol",
      "ul",
      "li",
      "br",
    ]),
    allowedAttributes: false,
  });

  try {
    // Get all users for the election
    const selectUsersSql = `
      SELECT users.*, auth.username
      FROM users
      JOIN auth ON users.id = auth.user_id
      WHERE users.election_id = $1
    `;
    const usersResult = await pool.query(selectUsersSql, [election]);
    const users = usersResult.rows;

    const insertPromises = users.map((user) => {
      return new Promise((resolve, reject) => {
        const notificationID = uuidv4();
        const currentTime = new Date();

        const insertNotificationSql = `
          INSERT INTO notifications (id, username, election, message, title, created_at)
          VALUES ($1, $2, $3, $4, $5, $6)
        `;
        pool.query(
          insertNotificationSql,
          [
            notificationID,
            user.username,
            election,
            sanitizedMessage,
            title,
            currentTime,
          ],
          (err) => {
            if (err) {
              return reject(err);
            }

            // Emit notification via socket.io
            io.to(user.username).emit("new-notification", {
              message: sanitizedMessage,
              title,
              created_at: currentTime,
            });

            resolve();
          }
        );
      });
    });

    await Promise.all(insertPromises);

    res.status(200).json({
      success: true,
      message: "Notifications sent successfully",
    });
  } catch (err) {
    console.error("Error inserting notifications:", err);
    res.status(500).json({
      success: false,
      message: "Database error occurred while inserting notifications",
    });
  }
});

module.exports = router;
