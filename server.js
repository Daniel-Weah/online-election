const express = require("express");
const path = require("path");
const bodyParser = require("body-parser");
const http = require("http");
const socketIo = require("socket.io");
const bcrypt = require("bcrypt");
const session = require("express-session");
const multer = require("multer");
const db = require('./model/db');
const loginRouter = require('./routes/loginRoute');
const dashboardRouter = require('./routes/dashboardRoute');
const votersRouter = require('./routes/votersRoute');
const partyRouter = require('./routes/partyRoute');
const positionRouter = require('./routes/positionRoute');
const candidateRouter = require('./routes/candidateRoute');
const profileRouter = require('./routes/profileRoute');
const voteRouter = require('./routes/voteRoute');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const port = 3000;
app.set("view engine", "ejs");

app.use(express.static(path.join(__dirname, "public")));

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(bodyParser.json());


const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

app.use(
  session({
    secret: "thisismysecrctekeyfhrgfgrfrty84fwir767",
    resave: false,
    saveUninitialized: true,
  })
);



app.use((req, res, next) => {
  req.io = io;
  next();
});

// =================================
app.use(loginRouter);
app.use(dashboardRouter);
app.use(votersRouter);
app.use(partyRouter);
app.use(positionRouter);
app.use(candidateRouter);
app.use(profileRouter);
app.use(voteRouter);

app.get("/", (req, res) => {
  res.redirect("/login");
});



app.get("/forget-password", (req, res) => {
  res.render("forget-password");
});

app.post("/forget-password", (req, res) => {
  const { username, password, passwordConfirm } = req.body;

  if (password !== passwordConfirm) {
    return res.status(400).json({success:false, message:"Passwords do not match"});
  }

  db.get("SELECT * FROM auth WHERE username = ?", [username], (err, user) => {
    if (err) {
      return res.status(500).json({success:false, message:"An error occurred"});
    }
    if (!user) {
      return res.status(404).json({success:false, message:"Username does not exist"});
    }

    bcrypt.hash(password, 10, (err, hash) => {
      if (err) {
        return res.status(500).json({success: false, message:"An error occurred"});
      }
      db.run(
        "UPDATE auth SET password = ? WHERE username = ?",
        [hash, username],
        function (err) {
          if (err) {
            return res.status(500).json({success:false, message:"An error occurred"});
          }

        return res.status(200).json({success: true, message:'Password Updated Successfully'});
        }
      );
    });
  });
});

app.get("/voter/setting", (req, res) => {
  if (!req.session.userId) {
    return res.redirect("/login");
  }
  res.render("voter-setting");
});

// POST ROUTE FOR UPDATING THE USER PASSWORD FROM THE SEETING PAGE
app.post("/setting/forget-password", (req, res) => {
  const { username, password, passwordConfirm } = req.body;

  if (password !== passwordConfirm) {
    return res.status(400).json({success: false, message:"Passwords do not match"});
  }

  db.get("SELECT * FROM auth WHERE username = ? AND id = ?", [username, req.session.userId], (err, user) => {
    if (err) {
      return res.status(500).send("An error occurred");
    }
    if (!user) {
      return res.status(404).send("Username does not exist");
    }
    if (user.username !== username) {
      return res.status(403).json({success: false, message: 'You are not authorize to change this password'});
    }
    bcrypt.hash(password, 10, (err, hash) => {
      if (err) {
        return res.status(500).json({success: false, message:"An error occurred"});
      }
      db.run(
        "UPDATE auth SET password = ? WHERE username = ? AND id = ?",
        [hash, username, req.session.userId],
        function (err) {
          if (err) {
            return res.status(500).json({success: false, message:"An error occurred"});
          }
          res.status(200).json({success: true, message:"Password updated successfully"});
        }
      );
    });
  });
});

// ROUTE FOR UPDATING THE USERNAME
app.post("/setting/change/username", (req, res) => {
  const { username, Newusername } = req.body;


  db.get(
    "SELECT * FROM auth WHERE id = ?",
    [req.session.userId],
    (err, user) => {
      if (err) {
        return res.status(500).json({success: false, message: "Internal server error"});
      }
      if (!user) {
        return res.status(500).json({success: false, message: "User does not exist"});
      }
      if (user.username !== username) {
        return res.status(403).json({ success: false, message: "You are not authorized to change this username" });
      }
      
      db.run(
        "UPDATE auth SET username = ? WHERE username = ? AND id = ?",
        [Newusername, username, req.session.userId],
        function (err) {
          if (err) {
            return res.status(500).json({success: false, message: "Internal server error"});
          }
          return res.status(200).json({success: true, message: "Username updated successfully!"});
        }
      );
    }
  );
});


//========================== ELECTION BEGINS ==========================================

//============================ ELECTION GET ROUTE =================================
app.get("/create/election", (req, res) => {
  if (!req.session.userId) {
    res.render("/login");
  }
  const profilePicture = req.session.profilePicture;
  db.get(
    "SELECT users.role_id, roles.role FROM users JOIN roles ON users.role_id = roles.id WHERE users.id = ?",
    [req.session.userId],
    (err, userRole) => {
      if (err) {
        return res.status(500).send("Error fetching user role");
      }
      db.all("SELECT * FROM elections", [], (err, elections) => {
        if (err) {
          return res.status(500).send("Error fetching elections");
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
                res.render("Election", {
                  profilePicture,
                  role: userRole.role,
                  elections,
                  user,
                  unreadCount: countResult.unreadCount,
                  user
                });
                });
              }
            );
          }
        );
      });
    }
  );
});

//============================== ELECTION POST ROUTE ===============================
app.post("/create/election", (req, res) => {
  const { election } = req.body;

  db.run(
    "INSERT INTO elections (election) VALUES (?)",
    [election],

    function (err) {
      if (err) {
        return res.status(500).send(`An error occured`);
      }
      res.status(200).send("success");
    }
  );
});

//======================== EDITING AND DELETING ELECTIONS ===========================
// Edit route - displays the edit form

app.get("/edit/election/:id", (req, res) => {
  const id = req.params.id;
  const election = db.get("SELECT * FROM elections WHERE id = ?", [id]);

  res.render("edit-election", { election });
});

// Handle edit form submission
app.post("/update/election/:id", (req, res) => {
  const { id } = req.params; // Get electionId from URL params
  const { election } = req.body;

  db.run(
    "UPDATE elections SET election = ? WHERE id = ?",
    [election, id],
    function (err) {
      if (err) {
        console.error(err.message);
        return res.status(500).send("Error updating election");
      }
      res.send("Election updated successfully");
    }
  );
});

// Handle delete request
app.post("/delete/election/:id", (req, res) => {
  const id = req.params.id;
  db.run("DELETE FROM elections WHERE id = ?", [id]);
  res.redirect("/create/election"); // Redirect to the main page or another relevant page
});

//=============================== ELECTION ENDS =======================================

app.get("/vote/analysis", (req, res) => {
  if (!req.session.userId) {
    return res.redirect("/login");
  }

  const positionsQuery = `
    SELECT positions.position, candidates.first_name, candidates.middle_name, candidates.last_name, IFNULL(SUM(votes.vote), 0) AS vote
    FROM candidates
    JOIN positions ON candidates.position_id = positions.id
    LEFT JOIN votes ON candidates.id = votes.candidate_id
    GROUP BY positions.position, candidates.id
    ORDER BY positions.position, candidates.last_name;
  `;

  db.all(positionsQuery, [], (err, candidates) => {
    if (err) {
      console.error("Error fetching candidates data:", err);
      return res.status(500).send("Error fetching candidates data");
    }
    const profilePicture = req.session.profilePicture;

    // Group candidates by position
    // Group candidates by position
    const groupedCandidates = {};
    candidates.forEach((candidate) => {
      const position = candidate.position;
      if (!groupedCandidates[position]) {
        groupedCandidates[position] = [];
      }
      console.log(groupedCandidates);

      groupedCandidates[position].push(candidate);
    });

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
                res.render("vote-analysis", {
                  groupedCandidates,
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
      }
    );
  });
});

app.get("/create/notification", (req, res) => {
  if (!req.session.userId) {
    return res.redirect("/login");
  }

  // Fetch the current user's data
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
                    res.render("create-notification", {
                      users,
                      currentUser: user,
                      profilePicture,
                      voteStatus,
                      role: userRole.role,
                      roles,
                      unreadCount: countResult.unreadCount,
                      user
                    });
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

app.post("/create/notification", (req, res) => {
  const { message, title } = req.body;

  db.all("SELECT username FROM auth", [], (err, users) => {
    if (err) {
      return res.status(500).send("Error fetching username");
    }

    const insertPromises = users.map((user) => {
      return new Promise((resolve, reject) => {
        const currentTime = new Date();

        db.run(
          `INSERT INTO notifications (username, message, title, created_at) VALUES (?,?,?,?)`,
          [user.username, message, title, currentTime],
          function (err) {
            if (err) {
              return reject(err);
            }

            // Emit the notification to the user room with the current date and time
            io.to(user.username).emit("new-notification", {
              message: message,
              title: title,
              created_at: currentTime,
            });

            resolve();
          }
        );
      });
    });

    Promise.all(insertPromises)
      .then(() => {
        res.status(200).send("Notifications sent successfully");
      })
      .catch((err) => {
        console.error("Error inserting notifications:", err);
        res.status(500).send("Database error");
      });
  });
});

// Route to fetch notifications
app.get("/notifications", (req, res) => {
  if (!req.session.userId) {
    return res.redirect("/login");
  }

  // Fetch the current user's username
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

      // Fetch notifications for the current user
      db.all(
        "SELECT * FROM notifications WHERE username = ? ORDER BY created_at DESC",
        [user.username],
        (err, notifications) => {
          if (err) {
            return res.status(500).send("Error fetching notifications");
          }

          // Reset unread count to zero
          db.run(
            "UPDATE notifications SET is_read = 1 WHERE username = ? AND is_read = 0",
            [user.username],
            (err) => {
              if (err) {
                return res
                  .status(500)
                  .send("Error updating notification status");
              }

              // Render the Notification.ejs page with notifications
              res.render("Notification", {
                username: user.username,
                userId: req.session.userId,
                notifications,
              });
            }
          );
        }
      );
    }
  );
});
io.on("connection", (socket) => {
  console.log("A user connected");

  socket.on("join", (userId) => {
    db.get("SELECT username FROM auth WHERE id = ?", [userId], (err, user) => {
      if (err || !user) {
        console.error("Error fetching user:", err);
        return;
      }

      socket.join(user.username);

      // Emit the count of unread notifications
      db.get(
        "SELECT COUNT(*) AS unreadCount FROM notifications WHERE username = ? AND is_read = 0",
        [user.username],
        (err, countResult) => {
          if (err) {
            console.error("Error fetching unread notifications count:", err);
            return;
          }

          io.to(user.username).emit(
            "unread-notifications-count",
            countResult.unreadCount
          );
        }
      );
    });
  });

  socket.on("disconnect", () => {
    console.log("A user disconnected");
  });
});

// Listen for new notifications and emit them to the specific user
// Server-side socket.io configuration

// Logout route
app.get("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).send("Could not log out. Please try again.");
    }
    res.redirect("/login");
  });
});

app.listen(port, () => {
  console.log(`App is listening to port ${port}`);
});
