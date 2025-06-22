const express = require("express");
const router = express.Router();

const pool = require("../db"); 
// const io = require("./socket");

// Helper to format time ago
const timeAgo = (date) => {
  const seconds = Math.floor((new Date() - new Date(date)) / 1000);
  const intervals = [
    { label: "year", seconds: 31536000 },
    { label: "month", seconds: 2592000 },
    { label: "day", seconds: 86400 },
    { label: "hour", seconds: 3600 },
    { label: "minute", seconds: 60 },
    { label: "second", seconds: 1 },
  ];

  for (const interval of intervals) {
    const count = Math.floor(seconds / interval.seconds);
    if (count >= 1) {
      return `${count} ${interval.label}${count > 1 ? "s" : ""} ago`;
    }
  }
  return "Just now";
};

// Middleware to ensure user is logged in
function ensureLoggedIn(req, res, next) {
  if (!req.session.userId) {
    return res.redirect("/login");
  }
  next();
}

// GET /notifications route
router.get("/notifications", ensureLoggedIn, (req, res) => {
  const userId = req.session.userId;
  const io = req.app.get('io');

  pool.query(
    "SELECT username FROM auth WHERE user_id = $1",
    [userId],
    (err, userResult) => {
      if (err) {
        console.error("USER ERROR", err);
        return res.status(500).send("Error fetching user");
      }

      if (userResult.rows.length === 0) {
        return res.status(404).send("User not found");
      }

      const username = userResult.rows[0].username;

      pool.query(
        "SELECT * FROM notifications WHERE username = $1 ORDER BY created_at DESC",
        [username],
        (err, notificationsResult) => {
          if (err) {
            return res.status(500).send("Error fetching notifications");
          }

          const notifications = notificationsResult.rows;

          pool.query(
            "UPDATE notifications SET is_read = 1 WHERE username = $1 AND is_read = 0",
            [username],
            (err) => {
              if (err) {
                return res.status(500).send("Error updating notification status");
              }

              pool.query(
                "SELECT COUNT(*) AS unreadCount FROM notifications WHERE username = $1 AND is_read = 0",
                [username],
                (err, countResult) => {
                  if (err) {
                    return res.status(500).send("Error fetching unread notifications count");
                  }

                  const unreadCount = parseInt(countResult.rows[0].unreadcount, 10) || 0;

                  pool.query(
                    "SELECT * FROM users WHERE id = $1",
                    [userId],
                    (err, userDataResult) => {
                      if (err) {
                        return res.status(500).send("Error fetching user data");
                      }

                      const userData = userDataResult.rows[0];

                      res.render("notification", {
                        username,
                        userId,
                        notifications,
                        profilePicture: req.session.profilePicture,
                        userData,
                        unreadCount,
                        timeAgo,
                      });
                    }
                  );
                }
              );
            }
          );
        }
      );
    }
  );
});

// Socket.IO connection handling
// io.on("connection", (socket) => {
//   console.log("A user connected");

//   socket.on("join", (userId) => {
//     pool.query(
//       "SELECT username FROM auth WHERE user_id = $1",
//       [userId],
//       (err, userResult) => {
//         if (err || !userResult.rows.length) {
//           console.error("Error fetching user:", err);
//           return;
//         }

//         const username = userResult.rows[0].username;
//         socket.join(username);

//         pool.query(
//           "SELECT COUNT(*) AS unreadCount FROM notifications WHERE username = $1 AND is_read = 0",
//           [username],
//           (err, countResult) => {
//             if (err) {
//               console.error("Error fetching unread notifications count:", err);
//               return;
//             }

//             const unreadCount = parseInt(countResult.rows[0].unreadcount, 10) || 0;
//             io.to(username).emit("unread-notifications-count", unreadCount);
//           }
//         );
//       }
//     );
//   });

//   socket.on("disconnect", () => {
//     console.log("A user disconnected");
//   });
// });

module.exports = router;
