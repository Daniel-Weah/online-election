const express = require('express');
const db = require('../model/db');
const multer = require("multer");

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

const router = express.Router();

router.get("/voters", (req, res) => {
    if (!req.session.userId) {
      return res.redirect("/login");
    }
  
    const currentUserSql = `
      SELECT users.*, roles.role, auth.username
      FROM users
      JOIN roles ON users.role_id = roles.id
      JOIN auth ON users.id = auth.user_id
      WHERE users.id = ?
    `;
  
    db.get(currentUserSql, [req.session.userId], (err, user) => {
      if (err) {
        console.error("Error fetching current user:", err);
        return res.status(500).send("An error occurred");
      }
      if (!user) {
        return res.status(404).send("User not found");
      }
  
      user.profile_picture = user.profile_picture.toString("base64");
  
      // // Fetch all users
      const allUsersSql = `
      SELECT users.*, roles.role, auth.username
      FROM users 
      JOIN roles ON users.role_id = roles.id
      JOIN auth ON users.id = auth.user_id ORDER BY users.id DESC
      `;
  
      db.all(allUsersSql, [], (err, users) => {
        if (err) {
          console.error("Error fetching all users:", err);
          return res
            .status(500)
            .send("An error occurred while fetching all users");
        }
  
        // Encode profile pictures for all users
        users.forEach((user) => {
          if (user.profile_picture) {
            user.profile_picture = user.profile_picture.toString("base64");
          }
        });
  
        const voteStatus = user.has_voted ? "Voted" : "Not Voted";
  
        db.get(
          "SELECT users.role_id, roles.role FROM users JOIN roles ON users.role_id = roles.id WHERE users.id = ?",
          [req.session.userId],
          (err, userRole) => {
            if (err) {
              return res.status(500).send("Error fetching user role");
            }
            db.all("SELECT * FROM roles", [], (err, roles) => {
              if (err) {
                return res.status(500).send("internal server error");
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
                      const profilePicture = req.session.profilePicture;
  
                      db.get("SELECT * FROM users WHERE id = ?", [req.session.userId], (err, user) => {
                        if(err) {
                          return res.status(500).send('Error fetching user from the user table')
                        }
                      res.render("voters", {
                        users,
                        currentUser: user,
                        profilePicture,
                        voteStatus,
                        role: userRole.role,
                        roles,
                        unreadCount: countResult.unreadCount,
                        user
                      });
                    }
                  );
                }
              );
            });
          }
        );
      });
      });
    });
  });
  
  
  router.post("/voters", upload.single("photo"), (req, res) => {
    const { firstname, middlename, lastname, dob, username, role, password } =
      req.body;
    const photo = req.file ? req.file.buffer : null;
  
    bcrypt.hash(password, 10, (err, hashedPassword) => {
      if (err) {
        console.error(err.message);
        return res.status(500).json({ success: false, message: "Server error" });
      }
  
      db.run(
        "INSERT INTO users(first_name, middle_name, last_name, DOB, profile_picture, role_id) VALUES (?,?,?,?,?,?)",
        [firstname, middlename, lastname, dob, photo, role],
        function (err) {
          if (err) {
            console.error(err.message);
            return res
              .status(500)
              .json({ success: false, message: "Database error" });
          }
  
          const userId = this.lastID;
  
          db.run(
            "INSERT INTO auth(username, password, user_id) VALUES (?,?,?)",
            [username, hashedPassword, userId],
            function (err) {
              if (err) {
                console.error(err.message);
                return res
                  .status(500)
                  .json({ success: false, message: "Database error" });
              }
  
              const currentTime = new Date();
              const notificationMessage = `Hi ${username}, congratulations on successfully registering for the online election voting system! Your vote is powerful and can shape the future. Stay tuned for any important updates regarding the election process.`;
              const notificationTitle = "Registration Successful";
  
              db.run(
                `INSERT INTO notifications (username, message, title, created_at) VALUES (?,?,?,?)`,
                [username, notificationMessage, notificationTitle, currentTime],
                function (err) {
                  if (err) {
                    console.error("Error inserting notification:", err);
                    return res
                      .status(500)
                      .json({ success: false, message: "Database error" });
                  }
  
                  // Emit the notification to the user's room
                  io.to(username).emit("new-notification", {
                    message: notificationMessage,
                    title: notificationTitle,
                    created_at: currentTime,
                  });
  
                  console.log(`A row has been inserted with ID ${userId}`);
                  res.status(200).json({
                    success: true,
                    message: `${username} has successfully been registered`,
                  });
                }
              );
            }
          );
        }
      );
    });
  });
  
  // Handle delete request
  router.post("/delete/user/:id", (req, res) => {
    const id = req.params.id;
    db.run("DELETE FROM users WHERE id = ?", [id]);
    db.run("DELETE FROM auth WHERE id = ?", [id]);
    res.redirect("/voters");
  });


  module.exports = router;