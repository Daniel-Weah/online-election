const express = require("express");
const router = express.Router();
const pool = require("../db");
const bcrypt = require("bcrypt");
const { isAuthenticated } = require("../middlewares/auth");
const { v4: uuidv4 } = require("uuid");
const multer = require("multer");

const storage = multer.memoryStorage();
const upload = multer({ storage });

const getIO = (req) => req.app.get("io");

router.get("/admin/voters", async (req, res) => {
  if (!req.session.userId) {
    return res.redirect("/login");
  }

  try {
    // Fetch current user details
    const currentUserQuery = `
      SELECT users.*, roles.role, auth.username, elections.election
      FROM users
      JOIN roles ON users.role_id = roles.id
      JOIN elections ON users.election_id = elections.id
      JOIN auth ON users.id = auth.user_id
      WHERE users.id = $1
    `;

    const { rows: currentUserRows } = await pool.query(currentUserQuery, [
      req.session.userId,
    ]);
    const user = currentUserRows[0];

    if (!user) {
      return res.status(404).send("User not found");
    }

    console.log("Login user data:", user);
    user.profile_picture = user.profile_picture
      ? Buffer.from(user.profile_picture).toString("base64")
      : null;

    const voteStatus = user.has_voted ? "Voted" : "Not Voted";

    // Fetch user role
    const roleQuery = `
      SELECT users.role_id, roles.role 
      FROM users 
      JOIN roles ON users.role_id = roles.id 
      WHERE users.id = $1
    `;
    const { rows: roleRows } = await pool.query(roleQuery, [
      req.session.userId,
    ]);
    const userRole = roleRows[0];

    // Fetch elections
    const { rows: elections } = await pool.query("SELECT * FROM elections");

    // Fetch roles (limiting to 1)
    const { rows: roles } = await pool.query("SELECT * FROM roles LIMIT 1");

    // Fetch username from auth
    const authQuery = "SELECT username FROM auth WHERE user_id = $1";
    const { rows: authRows } = await pool.query(authQuery, [
      req.session.userId,
    ]);
    const authUser = authRows[0];

    if (!authUser) {
      return res.status(404).send("User not found");
    }

    // Fetch unread notifications count
    const unreadCountQuery = `
      SELECT COUNT(*) AS "unreadCount" 
      FROM notifications 
      WHERE username = $1 AND is_read = 0
    `;
    const { rows: unreadCountRows } = await pool.query(unreadCountQuery, [
      authUser.username,
    ]);
    const unreadCount = unreadCountRows[0].unreadCount;

    const profilePicture = req.session.profilePicture;

    // Fetch user details from users table
    const userQuery = "SELECT * FROM users WHERE id = $1";
    const { rows: userRows } = await pool.query(userQuery, [
      req.session.userId,
    ]);
    const userData = userRows[0];

    // Fetch all admin users (excluding Super Admin)
    const adminAllUsersQuery = `
      SELECT users.*, roles.role, auth.username, elections.election
      FROM users 
      JOIN roles ON users.role_id = roles.id
      JOIN elections ON users.election_id = elections.id
      JOIN auth ON users.id = auth.user_id
      WHERE users.election_id = $1 AND roles.role != 'Super Admin'
      ORDER BY users.id DESC
    `;

    const { rows: adminUsers } = await pool.query(adminAllUsersQuery, [
      userData.election_id,
    ]);


    // Convert profile pictures to base64
    adminUsers.forEach((adminUser) => {
      if (adminUser.profile_picture) {
        adminUser.profile_picture = Buffer.from(
          adminUser.profile_picture
        ).toString("base64");
      }
    });

    // Fetch user election data
    const userElectionQuery = `
      SELECT users.*, elections.election AS election_name
      FROM users
      JOIN elections ON users.election_id = elections.id
      WHERE users.id = $1
    `;

    const { rows: userElectionRows } = await pool.query(userElectionQuery, [
      req.session.userId,
    ]);
    const userElectionData = userElectionRows[0];

    console.log("User Election Data:", userElectionData);

    const electionSettingsSql = `SELECT * FROM election_settings WHERE election_id = $1`;
    const electionSettingsResult = await pool.query(electionSettingsSql, [
      user.election_id,
    ]);

    const registrationTiming = electionSettingsResult.rows[0];
    console.log("Registration Timing:", registrationTiming);

    const currentTime = new Date().toLocaleTimeString("en-US", {
      hour12: false,
    });
    const registrationStartTime = registrationTiming.registration_start_time;
    const registrationEndTime = registrationTiming.registration_end_time;

    console.log("Registration Start time:", registrationStartTime);
    console.log("Registration End time:", registrationEndTime);

    const currentDate = registrationStartTime.split("T")[0];
    const fullCurrentTime = `${currentDate}T${currentTime}`;

    const start = new Date(registrationStartTime);
    const end = new Date(registrationEndTime);
    const current = new Date(fullCurrentTime);

    // Render the template with all data
    res.render("admin-voters", {
      adminUsers,
      currentUser: user,
      profilePicture,
      voteStatus,
      role: userRole.role,
      roles,
      unreadCount,
      elections,
      userElectionData,
      start,
      end,
      current,
    });
  } catch (err) {
    console.error("Error:", err);
    res.status(500).send("Internal Server Error");
  }
});



router.post("/admin/delete/users", (req, res) => {
  let { voterIds } = req.body;

  try {
    voterIds = JSON.parse(voterIds); // Parse JSON string to array
  } catch (error) {
    return res.redirect("/admin/voters?error=Invalid voter data");
  }

  if (!Array.isArray(voterIds) || voterIds.length === 0) {
    return res.redirect("/admin/voters?error=No voter selected");
  }

  const placeholders = voterIds.map((_, i) => `$${i + 1}`).join(", ");

  // Step 1: Get election ID before deletion
  pool.query(`SELECT DISTINCT election_id FROM users WHERE id IN (${placeholders})`, voterIds, (err, result) => {
    if (err || !result.rows.length) {
      console.error("Error fetching election ID:", err?.message);
      return res.redirect("/admin/voters?error=Could not resolve election context");
    }

    const electionId = result.rows[0].election_id;

    // Step 2: Proceed with deletion
    pool.query(`DELETE FROM users WHERE id IN (${placeholders})`, voterIds, function (err) {
      if (err) {
        console.error("Error deleting users:", err.message);
        return res.redirect("/admin/voters?error=Error deleting voter");
      }

      pool.query(`DELETE FROM auth WHERE user_id IN (${placeholders})`, voterIds, function (err) {
        if (err) {
          console.error("Error deleting auth records:", err.message);
          return res.redirect("/admin/voters?error=Error deleting voter");
        }

        pool.query(`DELETE FROM candidates WHERE user_id IN (${placeholders})`, voterIds, function (err) {
          if (err) {
            console.error("Error deleting candidates:", err.message);
            return res.redirect("/admin/voters?error=Error deleting voter");
          }

          pool.query(`DELETE FROM user_votes WHERE user_id IN (${placeholders})`, voterIds, function (err) {
            if (err) {
              console.error("Error deleting user votes:", err.message);
              return res.redirect("/admin/voters?error=Error deleting voter");
            }

            // Step 3: Emit Socket.IO event
            const io = req.app.get("io");
            if (io && electionId) {
              io.emit("user-deleted", { electionId });
              console.log("📢 Emitting 'user-deleted' for election:", electionId);
            }

            return res.redirect("/admin/voters?success=Voter(s) deleted successfully");
          });
        });
      });
    });
  });
});


router.post("/admin/voted/users", (req, res) => {
  let { voterIds } = req.body;

  try {
      voterIds = JSON.parse(voterIds); 
  } catch (error) {
      return res.redirect("/voters?error=Invalid voter data");
  }

  if (!Array.isArray(voterIds) || voterIds.length === 0) {
    return res.redirect("/admin/voters?error=No voter selected");
  }

  const placeholders = voterIds.map((_, i) => `$${i + 1}`).join(", ");

  pool.query(`UPDATE users SET has_voted = 1 WHERE id IN (${placeholders})`, voterIds, function (err) {
      if (err) {
          console.error("Error updating users:", err.message);
          return res.redirect("/voters?error=Error Marking User as Voted");
        }

      const values = voterIds.map(id => `('${uuidv4()}', '${id}')`).join(", ");

      pool.query(`INSERT INTO user_votes (id, user_id) VALUES ${values}`, function (err) {
          if (err) {
              console.error("Error inserting votes:", err.message);
              return res.status(500).json({ message: "Error updating vote status" });
          }
          const io = getIO(req);
    voterIds.forEach((id) => {
      io.emit("voter-updated", { userId: id, status: "Voted" });
    });
          return res.redirect("/admin/voters?success=Users marked as voted successfully!");
      });
  });

});

router.post("/admin/update/user", (req, res) => {
  const { id, first_name, middle_name, last_name, gender, role_id } = req.body;

  // Update the candidates table
  const updateCandidatesQuery = `
    UPDATE candidates
    SET first_name = $1, middle_name = $2, last_name = $3
    WHERE user_id = $4;
  `;

  // Update the users table
  const updateUsersQuery = `
    UPDATE users
    SET first_name = $1, middle_name = $2, last_name = $3, gender = $4, role_id = $5
    WHERE id = $6;
  `;

  // Execute queries
  pool.query(
    updateCandidatesQuery,
    [first_name, middle_name, last_name, id],
    function (err) {
      if (err) {
        console.error("Error updating candidates:", err.message);
        return res.redirect("/admin/voters?error=Error Updating Candidates");
      }

      pool.query(
        updateUsersQuery,
        [first_name, middle_name, last_name, gender, role_id, id],
        function (err) {
          if (err) {
            console.error("Error updating users:", err.message);
            return res.redirect("/admin/voters?error=Error Updating Users");
          }

           const io = getIO(req);
    io.emit("voter-info-updated", {
      userId: id,
      first_name,
      middle_name,
      last_name,
      gender,
      role_id,
    });

          res.redirect("/admin/voters?success=User Updated Successfully!");
        }
      );
    }
  );
});

module.exports = router;
