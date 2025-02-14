const express = require("express");
const path = require("path");
const bodyParser = require("body-parser");
const http = require("http");
const socketIo = require("socket.io");
const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcrypt");
const session = require("express-session");
const multer = require("multer");
require("dotenv").config();
const { v4: uuidv4 } = require("uuid");
const crypto = require("crypto");
const sanitizeHtml = require("sanitize-html");
const fs = require("fs");
const { Parser } = require("json2csv");

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const port = 3000;
const db = new sqlite3.Database("./election.db");
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
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
  })
);

db.serialize(() => {
  db.run(
    "CREATE TABLE IF NOT EXISTS auth(id TEXT PRIMARY KEY, username VARCHAR(50) NOT NULL UNIQUE, password VARCHAR(255) NOT NULL, user_id TEXT)"
  );
  db.run(
    "CREATE TABLE IF NOT EXISTS roles(id TEXT PRIMARY KEY, role VARCHAR(50) NOT NULL)"
  );
  db.run(
    "CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, first_name VARCHAR(50) NOT NULL, middle_name VARCHAR(50) NULL, last_name VARCHAR(50) NOT NULL, DOB DATE NOT NULL, profile_picture BLOB NOT NULL, role_id TEXT, election_id TEXT, has_voted TEXT)"
  );
  db.run(
    "CREATE TABLE IF NOT EXISTS parties(id TEXT PRIMARY KEY, election_id TEXT NOT NULL, party VARCHAR(50) NOT NULL, logo BLOB)"
  );
  db.run(
    "CREATE TABLE IF NOT EXISTS positions(id TEXT PRIMARY KEY, election_id TEXT NOT NULL, position VARCHAR(50) NOT NULL, position_description VARCHAR(50), candidate_age_eligibility INTEGER NOT NULL)"
  );
  db.run(
    "CREATE TABLE IF NOT EXISTS candidates(id TEXT PRIMARY KEY, first_name VARCHAR(50) NOT NULL, middle_name VARCHAR(50) NULL, last_name VARCHAR(50) NOT NULL, party_id TEXT NOT NULL, position_id TEXT NOT NULL, election_id TEXT NOT NULL, user_id TEXT NOT NULL, photo BLOB)"
  );
  db.run(
    "CREATE TABLE IF NOT EXISTS votes(id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL, vote INTEGER DEFAULT 0, UNIQUE(candidate_id))"
  );

  db.run(
    `
    CREATE TABLE IF NOT EXISTS user_votes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL
    )
  `
  );

  db.run(
    "CREATE TABLE IF NOT EXISTS elections (id TEXT PRIMARY KEY, election VARCHAR(50) NOT NULL UNIQUE, voter_age_eligibility INTEGER NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)"
  );

  db.run(
    "CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, username VARCHAR(50) NOT NULL, election TEXT NOT NULL, message VARCHAR(2000) NOT NULL, title VARCHAR(50) NOT NULL, is_read INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(username) REFERENCES auth (username))"
  );

  db.run(`CREATE TABLE IF NOT EXISTS election_settings (
    id TEXT PRIMARY KEY,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    election_id TEXT NOT NULL
);`);

  // db.run(
  //   "DROP TABLE auth"
  // );
  // db.run(
  //   "DROP TABLE users"
  // );
  // db.run(
  //   "DROP TABLE parties"
  // );
  // db.run(
  //   "DROP TABLE positions"
  // );
  // db.run(
  //   "DROP TABLE candidates"
  // );
  // db.run(
  //   "DROP TABLE user_votes"
  // );
  // db.run(
  //   "DROP TABLE votes"
  // );

  // db.run(
  //   "DROP TABLE notifications"
  // );

});

app.use((req, res, next) => {
  req.io = io;
  next();
});

app.get("/", (req, res) => {
  res.redirect("/login");
});

app.get("/login", (req, res) => {
  res.render("login.ejs");
});

// Route to handle login form submission
app.post("/login", (req, res) => {
  const { username, password } = req.body;

  db.get("SELECT * FROM auth WHERE username = ?", [username], (err, user) => {
    if (err) {
      return res.status(500).send("Internal Server Error");
    }
    if (!user) {
      return res.render("login", {
        errorMessage: "Invalid username or password",
      });
    }

    bcrypt.compare(password, user.password, (err, result) => {
      if (result) {
        db.get(
          `SELECT users.*, roles.role AS role_name
          FROM users
          JOIN roles ON users.role_id = roles.id
          WHERE users.id = ?`,
          [user.user_id],
          (err, userData) => {
            if (err) {
              return res.status(500).send("Internal Server Error");
            }
            req.session.userId = user.user_id;
            req.session.profilePicture =
              userData.profile_picture.toString("base64");
            req.session.userRole = userData.role_name;
            res.redirect("/dashboard");
          }
        );
      } else {
        return res.render("login", {
          errorMessage: "Invalid username or password",
        });
      }
    });
  });
});

app.get("/dashboard", (req, res) => {
  if (!req.session.userId) {
    return res.redirect("/login");
  }

  const electionId = req.query.electionId || null;

  db.get(
    "SELECT election_id FROM users WHERE id = ?",
    [req.session.userId],
    (err, userElection) => {
      if (err) {
        return res
          .status(500)
          .send("Error fetching user's registered election");
      }

      const userElectionId = electionId || userElection.election_id;

      if (!userElectionId) {
        return res.status(404).send("Election not selected or registered");
      }

      const sqlCandidates = `
      SELECT candidates.*, parties.party, parties.logo, positions.position, IFNULL(SUM(votes.vote), 0) AS vote
      FROM candidates
      JOIN parties ON candidates.party_id = parties.id
      JOIN positions ON candidates.position_id = positions.id
      LEFT JOIN votes ON candidates.id = votes.candidate_id
      WHERE candidates.election_id = ?
      GROUP BY candidates.id
      `;

      const sqlTotalVotesPerPosition = `
      SELECT positions.position, SUM(IFNULL(votes.vote, 0)) AS totalVotes
      FROM candidates
      JOIN positions ON candidates.position_id = positions.id
      LEFT JOIN votes ON candidates.id = votes.candidate_id
      WHERE candidates.election_id = ?
      GROUP BY positions.position
      `;

      db.get(
        `
        SELECT COUNT(*) AS totalUsers 
        FROM auth 
        JOIN users ON auth.user_id = users.id 
        WHERE users.election_id = ?
        `,
        [userElectionId],
        (err, result) => {
          if (err) {
            return res.status(500).send("Error fetching total users");
          }
          const totalUsers = result.totalUsers;

          db.all(
            sqlTotalVotesPerPosition,
            [userElectionId],
            (err, totalVotesPerPosition) => {
              if (err) {
                return res
                  .status(500)
                  .send("Error fetching total votes per position");
              }

              const totalVotesMap = {};
              totalVotesPerPosition.forEach((row) => {
                totalVotesMap[row.position] = row.totalVotes || 0;
              });

              db.all(sqlCandidates, [userElectionId], (err, candidates) => {
                if (err) {
                  return res.status(500).send("Error fetching candidates data");
                }

                candidates = candidates.map((candidate) => {
                  return {
                    ...candidate,
                    photo: candidate.photo.toString("base64"),
                    logo: candidate.logo.toString("base64"),
                    votePercentage:
                      totalVotesMap[candidate.position] > 0
                        ? (candidate.vote / totalVotesMap[candidate.position]) *
                          100
                        : 0,
                  };
                });

                const totalVotes = totalVotesPerPosition.reduce(
                  (acc, row) => acc + row.totalVotes,
                  0
                );

                const groupedCandidates = candidates.reduce(
                  (acc, candidate) => {
                    if (!acc[candidate.position]) {
                      acc[candidate.position] = [];
                    }
                    acc[candidate.position].push(candidate);
                    return acc;
                  },
                  {}
                );

                db.get(
                  "SELECT users.role_id, roles.role FROM users JOIN roles ON users.role_id = roles.id WHERE users.id = ?",
                  [req.session.userId],
                  (err, userRole) => {
                    if (err) {
                      return res.status(500).send("Error fetching user role");
                    }

                    // Fetch the current user's username
                    db.get(
                      "SELECT username FROM auth WHERE user_id = ?",
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
                                .send(
                                  "Error fetching unread notifications count"
                                );
                            }
                            db.get(
                              "SELECT * FROM users WHERE id = ?",
                              [req.session.userId],
                              (err, user) => {
                                if (err) {
                                  return res
                                    .status(500)
                                    .send(
                                      "Error fetching user from the user table"
                                    );
                                }

                                db.all(
                                  "SELECT * FROM elections",
                                  (err, elections) => {
                                    if (err) {
                                      return res
                                        .status(500)
                                        .send(
                                          "There was an error getting the elections data"
                                        );
                                    }

                                    const profilePicture =
                                      req.session.profilePicture;

                                    res.render("dashboard", {
                                      totalUsers,
                                      candidates,
                                      totalVotes,
                                      groupedCandidates,
                                      elections: req.elections,
                                      selectedElection: userElectionId,
                                      totalUsers,
                                      profilePicture,
                                      candidates,
                                      totalVotes,
                                      role: userRole.role,
                                      unreadCount: countResult.unreadCount,
                                      user,
                                      groupedCandidates,
                                      elections,
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
            }
          );
        }
      );
    }
  );
});

// ============================ VOTERS GET ROUTE ================================

app.get("/voters", (req, res) => {
  if (
    !req.session.userId ||
    (req.session.userRole !== "Super Admin" && req.session.userRole !== "Admin")
  ) {
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
    SELECT users.*, roles.role, auth.username, elections.election
    FROM users 
    JOIN roles ON users.role_id = roles.id
    JOIN elections ON users.election_id = elections.id
    JOIN auth ON users.id = auth.user_id 
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
          db.all("SELECT * FROM elections", [], (err, elections) => {
            if (err) {
              return res.status(500).send("Error Fetching elections");
            }
            db.all("SELECT * FROM roles LIMIT 1", [], (err, roles) => {
              if (err) {
                return res.status(500).send("error fetchhing roles data");
              }
              db.all("SELECT * FROM roles", [], (err, allRoles) => {
                if (err) {
                  return res.status(500).send("error fetchhing roles data");
                }
                db.get(
                  "SELECT username FROM auth WHERE user_id = ?",
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

                        db.get(
                          "SELECT * FROM users WHERE id = ?",
                          [req.session.userId],
                          (err, user) => {
                            if (err) {
                              return res
                                .status(500)
                                .send(
                                  "Error fetching user from the user table"
                                );
                            }

                            res.render("voters", {
                              users,
                              profilePicture,
                              voteStatus,
                              role: userRole.role,
                              roles,
                              unreadCount: countResult.unreadCount,
                              user,
                              elections,
                              allRoles,
                            });
                          }
                        );
                      }
                    );
                  }
                );
              });
            });
          });
        }
      );
    });
  });
});

app.get("/admin/voters", (req, res) => {
  if (!req.session.userId) {
    return res.redirect("/login");
  }

  const currentUserSql = `
    SELECT users.*, roles.role, auth.username, elections.election
    FROM users
    JOIN roles ON users.role_id = roles.id
    JOIN elections ON users.election_id = elections.id
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

    console.log("Login user data:", user);

    user.profile_picture = user.profile_picture.toString("base64");

    const voteStatus = user.has_voted ? "Voted" : "Not Voted";

    db.get(
      "SELECT users.role_id, roles.role FROM users JOIN roles ON users.role_id = roles.id WHERE users.id = ?",
      [req.session.userId],
      (err, userRole) => {
        if (err) {
          return res.status(500).send("Error fetching user role");
        }
        db.all("SELECT * FROM elections", [], (err, elections) => {
          if (err) {
            return res.status(500).send("Error Fetching elections");
          }
          db.all("SELECT * FROM roles LIMIT 2", [], (err, roles) => {
            if (err) {
              return res.status(500).send("Internal server error");
            }
            db.get(
              "SELECT username FROM auth WHERE user_id = ?",
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

                    db.get(
                      "SELECT * FROM users WHERE id = ?",
                      [req.session.userId],
                      (err, user) => {
                        if (err) {
                          return res
                            .status(500)
                            .send("Error fetching user from the user table");
                        }

                        const adminAllUsersSql = `
                          SELECT users.*, roles.role, auth.username, elections.election
                          FROM users 
                          JOIN roles ON users.role_id = roles.id
                          JOIN elections ON users.election_id = elections.id
                          JOIN auth ON users.id = auth.user_id
                          WHERE users.election_id = ? AND roles.role != 'Super Admin'
                          ORDER BY users.id DESC
                        `;

                        db.all(
                          adminAllUsersSql,
                          [user.election_id],
                          (err, adminUsers) => {
                            if (err) {
                              console.error("Error fetching admin users:", err);
                              return res
                                .status(500)
                                .send("Error fetching admin users");
                            }

                            console.log("Fetched admin users:", adminUsers);

                            adminUsers.forEach((adminUser) => {
                              if (adminUser.profile_picture) {
                                adminUser.profile_picture =
                                  adminUser.profile_picture.toString("base64");
                              }
                            });

                            db.get(
                              `SELECT users.*, elections.election AS election_name
                             FROM users
                             JOIN elections ON users.election_id = elections.id
                             WHERE users.id = ?`,
                              [req.session.userId],
                              (err, userElectionData) => {
                                if (err) {
                                  console.error(
                                    "Error getting the user election name:",
                                    err
                                  );
                                  return res.send(
                                    "Error getting the userElectionName"
                                  );
                                }

                                console.log(
                                  "userElectionData",
                                  userElectionData
                                );

                                res.render("admin-voters", {
                                  adminUsers,
                                  currentUser: user,
                                  profilePicture,
                                  voteStatus,
                                  role: userRole.role,
                                  roles,
                                  unreadCount: countResult.unreadCount,
                                  elections,
                                  userElectionData,
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
        });
      }
    );
  });
});

// =============================== VOTERS POST ROUTE ==================================
app.post("/voters", upload.single("photo"), (req, res) => {
  const {
    firstname,
    middlename,
    lastname,
    dob,
    username,
    role,
    election,
    password,
  } = req.body;
  if (firstname.length < 3 || lastname.length < 3) {
    return res.status(500).json({
      success: false,
      message: "First Name or Last Name must be at least 3 characters",
    });
  }
  const photo = req.file ? req.file.buffer : null;

  const votersID = uuidv4();

  // Fetch voter age eligibility from the elections table
  db.get(
    `SELECT * FROM elections WHERE id = ?`,
    [election],
    (err, electionEligibility) => {
      if (err) {
        console.error("Error fetching election age eligibility:", err);
        return res
          .status(500)
          .json({ success: false, message: "Error fetching election details" });
      }

      const voterAgeEligibility = electionEligibility?.voter_age_eligibility;

      if (!voterAgeEligibility) {
        return res
          .status(400)
          .json({ success: false, message: "Election eligibility not found" });
      }

      // Calculate the user's age
      const userDOB = new Date(dob);
      const today = new Date();
      const age =
        today.getFullYear() -
        userDOB.getFullYear() -
        (today.getMonth() < userDOB.getMonth() ||
        (today.getMonth() === userDOB.getMonth() &&
          today.getDate() < userDOB.getDate())
          ? 1
          : 0);

      console.log("This is the voter age", age);

      // Check if the user's age meets or exceeds the voter eligibility
      if (age < voterAgeEligibility) {
        return res.status(400).json({
          success: false,
          message: `You must be at least ${voterAgeEligibility} years old to register for this election.`,
        });
      }

      // Proceed with registration if age is valid
      bcrypt.hash(password, 10, (err, hashedPassword) => {
        if (err) {
          console.error(err.message);
          return res
            .status(500)
            .json({ success: false, message: "Server error" });
        }

        db.run(
          "INSERT INTO users(id, first_name, middle_name, last_name, DOB, profile_picture, role_id, election_id) VALUES (?,?,?,?,?,?,?,?)",
          [
            votersID,
            firstname,
            middlename,
            lastname,
            dob,
            photo,
            role,
            election,
          ],
          function (err) {
            if (err) {
              console.error(err.message);
              return res.status(500).json({
                success: false,
                message: "Error saving user information",
              });
            }

            db.run(
              "INSERT INTO auth(id, username, password, user_id) VALUES (?,?,?,?)",
              [uuidv4(), username, hashedPassword, votersID],
              function (err) {
                if (err) {
                  console.error(err.message);
                  return res.status(500).json({
                    success: false,
                    message: "Error inserting into auth table",
                  });
                }

                const currentTime = new Date();
                const notificationMessage = `Hi ${firstname} ${middlename} ${lastname} (${username}), congratulations on successfully registering for ${electionEligibility.election}!`;
                const notificationTitle = "Registration Successful";

                db.run(
                  `INSERT INTO notifications (id, username, election, message, title, created_at) VALUES (?,?,?,?,?,?)`,
                  [
                    uuidv4(),
                    username,
                    election,
                    notificationMessage,
                    notificationTitle,
                    currentTime,
                  ],
                  function (err) {
                    if (err) {
                      console.error("Error inserting notification:", err);
                      return res.status(500).json({
                        success: false,
                        message: "Error sending user's notification",
                      });
                    }

                    // Emit the notification
                    io.to(username).emit("new-notification", {
                      message: notificationMessage,
                      title: notificationTitle,
                      created_at: currentTime,
                    });

                    res.status(201).json({
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
    }
  );
});

// edit user
// For deleting a user
app.post("/delete/user/:id", (req, res) => {
  const id = req.params.id;
  db.run("DELETE FROM users WHERE id = ?", [id], function (err) {
    if (err) {
      console.error("Error deleting user:", err.message);
      return res.redirect("/voters?error=Error Deleting User");
    }
    db.run("DELETE FROM auth WHERE user_id = ?", [id], function (err) {
      if (err) {
        console.error("Error deleting user:", err.message);
        return res.redirect("/voters?error=Error Deleting User");
      }

      db.run("DELETE FROM candidates WHERE user_id = ?", [id], function (err) {
        if (err) {
          console.error("Error deleting user:", err.message);
          return res.redirect("/voters?error=Error Deleting User");
        }
        res.redirect("/voters?success=User Deleted Successfully!");
      });
    });
  });
});

// For marking a user as voted
app.post("/voted/user/:id", (req, res) => {
  const id = req.params.id;
  db.run(
    "UPDATE users SET has_voted = ? WHERE id = ?",
    [1, id],
    function (err) {
      if (err) {
        console.error("Error updating user:", err.message);
        return res.redirect("/voters?error=Error Marking User as Voted");
      }
      db.run(
        "INSERT INTO user_votes (user_id) VALUES(?)",
        [id],
        function (err) {
          if (err) {
            console.error("Error inserting vote:", err.message);
            return res.redirect("/voters?error=Error Updating Vote Status");
          }
          res.redirect(
            "/voters?success=User has been Marked as Voted Successfully!"
          );
        }
      );
    }
  );
});

// For updating a user
app.post("/update/user", (req, res) => {
  const { id, first_name, middle_name, last_name, role_id } = req.body;

  // Update the candidates table
  const updateCandidatesQuery = `
    UPDATE candidates
    SET first_name = ?, middle_name = ?, last_name = ?
    WHERE user_id = ?;
  `;

  // Update the users table
  const updateUsersQuery = `
    UPDATE users
    SET first_name = ?, middle_name = ?, last_name = ?, role_id = ?
    WHERE id = ?;
  `;

  // Execute queries
  db.run(
    updateCandidatesQuery,
    [first_name, middle_name, last_name, id],
    function (err) {
      if (err) {
        console.error("Error updating candidates:", err.message);
        return res.redirect("/voters?error=Error Updating Candidates");
      }

      db.run(
        updateUsersQuery,
        [first_name, middle_name, last_name, role_id, id],
        function (err) {
          if (err) {
            console.error("Error updating users:", err.message);
            return res.redirect("/voters?error=Error Updating Users");
          }

          res.redirect("/voters?success=User Updated Successfully!");
        }
      );
    }
  );
});

// For admin

app.post("/admin/delete/user/:id", (req, res) => {
  const id = req.params.id;
  db.run("DELETE FROM users WHERE id = ?", [id], function (err) {
    if (err) {
      console.error("Error deleting user:", err.message);
      return res.redirect("/admin/voters?error=Error Deleting User");
    }
    db.run("DELETE FROM auth WHERE user_id = ?", [id], function (err) {
      if (err) {
        console.error("Error deleting user:", err.message);
        return res.redirect("/admin/voters?error=Error Deleting User");
      }

      db.run("DELETE FROM candidates WHERE user_id = ?", [id], function (err) {
        if (err) {
          console.error("Error deleting user:", err.message);
          return res.redirect("/admin/voters?error=Error Deleting User");
        }
        res.redirect("/admin/voters?success=User Deleted Successfully!");
      });
    });
  });
});

app.post("/admin/voted/user/:id", (req, res) => {
  const id = req.params.id;
  db.run(
    "UPDATE users SET has_voted = ? WHERE id = ?",
    [1, id],
    function (err) {
      if (err) {
        console.error("Error updating user:", err.message);
        return res.redirect("/admin/voters?error=Error Marking User as Voted");
      }
      db.run(
        "INSERT INTO user_votes (user_id) VALUES(?)",
        [id],
        function (err) {
          if (err) {
            console.error("Error inserting vote:", err.message);
            return res.redirect(
              "/admin/voters?error=Error Updating Vote Status"
            );
          }
          res.redirect(
            "/admin/voters?success=User has been Marked as Voted Successfully!"
          );
        }
      );
    }
  );
});

app.post("/admin/update/user", (req, res) => {
  const { id, first_name, middle_name, last_name, role_id } = req.body;

  // Update the candidates table
  const updateCandidatesQuery = `
    UPDATE candidates
    SET first_name = ?, middle_name = ?, last_name = ?
    WHERE user_id = ?;
  `;

  // Update the users table
  const updateUsersQuery = `
    UPDATE users
    SET first_name = ?, middle_name = ?, last_name = ?, role_id = ?
    WHERE id = ?;
  `;

  // Execute queries
  db.run(
    updateCandidatesQuery,
    [first_name, middle_name, last_name, id],
    function (err) {
      if (err) {
        console.error("Error updating candidates:", err.message);
        return res.redirect("/admin/voters?error=Error Updating Candidates");
      }

      db.run(
        updateUsersQuery,
        [first_name, middle_name, last_name, role_id, id],
        function (err) {
          if (err) {
            console.error("Error updating users:", err.message);
            return res.redirect("/admin/voters?error=Error Updating Users");
          }

          res.redirect("/admin/voters?success=User Updated Successfully!");
        }
      );
    }
  );
});

// ================================= VOTERS ENDS =====================================

// Route to render party registration form
app.get("/create/party", (req, res) => {
  if (
    !req.session.userId ||
    (req.session.userRole !== "Super Admin" && req.session.userRole !== "Admin")
  ) {
    return res.redirect("/login");
  }
  db.all(
    `SELECT parties.*, elections.election
          FROM parties
          JOIN elections ON parties.election_id = elections.id

    `,
    [],
    (err, parties) => {
      if (err) {
        return res.status(500).send("Internal server error");
      }

      parties.forEach((party) => {
        if (party.logo) {
          party.logo = party.logo.toString("base64");
        }
      });

      const profilePicture = req.session.profilePicture;
      db.get(
        "SELECT users.role_id, roles.role FROM users JOIN roles ON users.role_id = roles.id WHERE users.id = ?",
        [req.session.userId],
        (err, userRole) => {
          if (err) {
            return res.status(500).send("Error fetching user role");
          }
          db.get(
            "SELECT username FROM auth WHERE user_id = ?",
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
                  db.get(
                    "SELECT * FROM users WHERE id = ?",
                    [req.session.userId],
                    (err, user) => {
                      if (err) {
                        return res
                          .status(500)
                          .send("Error fetching user from the user table");
                      }

                      db.all(
                        "SELECT * FROM parties WHERE election_id = ?",
                        [user.election_id],
                        (err, Adminparties) => {
                          if (err) {
                            return res
                              .status(500)
                              .send("Internal server error");
                          }

                          Adminparties.forEach((party) => {
                            if (party.logo) {
                              party.logo = party.logo.toString("base64");
                            }
                          });

                          db.get(
                            `SELECT users.*, elections.election AS election_name
                       FROM users
                       JOIN elections ON users.election_id = elections.id
                       WHERE users.id = ?`,
                            [req.session.userId],
                            (err, userElectionData) => {
                              if (err) {
                                console.error(
                                  "Error getting the user election name:",
                                  err
                                );
                                return res.send(
                                  "Error getting the userElectionName"
                                );
                              }

                              console.log("userElectionData", userElectionData);

                              db.all(
                                "SELECT * FROM elections",
                                [],
                                (err, elections) => {
                                  if (err) {
                                    res.send(
                                      "There was an error getting election data"
                                    );
                                  }

                                  res.render("party-registration", {
                                    parties,
                                    role: userRole.role,
                                    profilePicture,
                                    unreadCount: countResult.unreadCount,
                                    user,
                                    userElectionData,
                                    elections,
                                    Adminparties,
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
            }
          );
        }
      );
    }
  );
});

app.post("/create/party", upload.single("logo"), (req, res) => {
  const { election, party } = req.body;
  const logo = req.file ? req.file.buffer : null;

  const partyID = uuidv4();

  db.run(
    "INSERT INTO parties (id, election_id, party, logo) VALUES (?, ?, ?, ?)",
    [partyID, election, party, logo],
    function (err) {
      if (err) {
        console.error(err.message);
        return res.status(500).send("Error saving party information");
      }
      res.status(200).send(`${party} created successfully`);
    }
  );
});

app.post("/update/party", upload.single("logo"), (req, res) => {
  const { id, party } = req.body;

  const logo = req.file ? req.file.buffer : null;

  if (!logo) {
    console.error("No logo file uploaded");
    return res.redirect("/create/party?error=Party Logo Required");
  }

  const query = `
      UPDATE parties
      SET party = ?, logo = ? WHERE id = ?;
  `;

  db.run(query, [party, logo, id], function (err) {
    if (err) {
      console.error("Error updating party:", err.message);
      return res.redirect("/create/party?error=Error updating party");
    }
    res.redirect("/create/party?success=Party Updated Successfully!");
  });
});

// Handle delete and edit request
app.post("/delete/party/:id", (req, res) => {
  const id = req.params.id;
  db.run("DELETE FROM parties WHERE id = ?", [id], function (err) {
    if (err) {
      console.error("Error deleting party:", err.message);
      return res.redirect("/create/party?error=Error deleting party");
    }
    res.redirect("/create/party?success=Party Deleted Successfully!");
  });
});

app.get("/add/position", (req, res) => {
  if (
    !req.session.userId ||
    (req.session.userRole !== "Super Admin" && req.session.userRole !== "Admin")
  ) {
    return res.redirect("/login");
  }
  db.all(
    `SELECT positions.*, elections.election
          FROM positions
          JOIN elections ON positions.election_id = elections.id
    `,
    [],
    (err, positions) => {
      if (err) {
        return res.status.send("Internal server error");
      }
      const profilePicture = req.session.profilePicture;
      db.get(
        "SELECT users.role_id, roles.role FROM users JOIN roles ON users.role_id = roles.id WHERE users.id = ?",
        [req.session.userId],
        (err, userRole) => {
          if (err) {
            return res.status(500).send("Error fetching user role");
          }
          db.get(
            "SELECT username FROM auth WHERE user_id = ?",
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
                  db.get(
                    "SELECT * FROM users WHERE id = ?",
                    [req.session.userId],
                    (err, user) => {
                      if (err) {
                        return res
                          .status(500)
                          .send("Error fetching user from the user table");
                      }

                      db.all(
                        "SELECT * FROM positions WHERE election_id = ?",
                        [user.election_id],
                        (err, Adminpositions) => {
                          if (err) {
                            return res.status.send("Internal server error");
                          }

                          db.get(
                            `SELECT users.*, elections.election AS election_name
                       FROM users
                       JOIN elections ON users.election_id = elections.id
                       WHERE users.id = ?`,
                            [req.session.userId],
                            (err, userElectionData) => {
                              if (err) {
                                console.error(
                                  "Error getting the user election name:",
                                  err
                                );
                                return res.send(
                                  "Error getting the userElectionName"
                                );
                              }

                              console.log("userElectionData", userElectionData);

                              db.all(
                                "SELECT * FROM elections",
                                [],
                                (err, elections) => {
                                  if (err) {
                                    res.send(
                                      "There was an error getting election data"
                                    );
                                  }

                                  res.render("position.ejs", {
                                    positions,
                                    profilePicture,
                                    role: userRole.role,
                                    unreadCount: countResult.unreadCount,
                                    user,
                                    elections,
                                    userElectionData,
                                    Adminpositions,
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
            }
          );
        }
      );
    }
  );
});

app.post("/add/position", (req, res) => {
  const {
    election,
    Position,
    position_description,
    candidate_age_eligibility,
  } = req.body;

  const positionID = uuidv4();

  db.run(
    "INSERT INTO positions (id, election_id, position, position_description, candidate_age_eligibility) VALUES (?,?,?,?,?)",
    [
      positionID,
      election,
      Position,
      position_description,
      candidate_age_eligibility,
    ],
    (err) => {
      if (err) {
        return console.log(err.message);
      }
      res.status(200).send(`${Position} Position created successfully`);
    }
  );
});

app.post("/update/position", (req, res) => {
  const { id, position, candidate_age_eligibilities } = req.body;

  const query = `
      UPDATE positions
      SET position = ?, candidate_age_eligibility = ?
      WHERE id = ?;
  `;
  db.run(query, [position, candidate_age_eligibilities, id], function (err) {
    if (err) {
      console.error("Error updating position:", err.message);
      return res.redirect("/add/position?error=Error updating position");
    }
    res.redirect("/add/position?success=Position updated successfully!");
  });
});

app.post("/delete/position/:id", (req, res) => {
  const id = req.params.id;
  db.run("DELETE FROM positions WHERE id = ?", [id], function (err) {
    if (err) {
      console.error("Error deleting party:", err.message);
      return res.redirect("/create/party?error=Error deleting party");
    }
    res.redirect("/add/position?success=Position deleted successfully!");
  });
});

//======================== CANDIDATE REGISTRATION ROUTES =============================

app.get("/candidate/registration", (req, res) => {
  if (
    !req.session.userId ||
    (req.session.userRole !== "Super Admin" && req.session.userRole !== "Admin")
  ) {
    return res.redirect("/login");
  }
  db.all("SELECT * FROM parties", [], (err, parties) => {
    if (err) {
      return res.status(500).send("Error fetching parties information");
    }
    db.all("SELECT * FROM roles LIMIT 1 OFFSET 1", [], (err, roles) => {
      if (err) {
        return res.status(500).send("Error fetching roles information");
      }

      if (roles.length === 0) {
        return res.status(404).send("Second role not found");
      }

      const secondRole = roles[0];

      console.log("Second role:", secondRole);

      db.all("SELECT * FROM positions", [], (err, positions) => {
        if (err) {
          return res.status(500).send("Error fetching positions information");
        }

        const profilePicture = req.session.profilePicture;
        db.get(
          "SELECT users.role_id, roles.role FROM users JOIN roles ON users.role_id = roles.id WHERE users.id = ?",
          [req.session.userId],
          (err, userRole) => {
            if (err) {
              return res.status(500).send("Error fetching user role");
            }
            db.get(
              "SELECT username FROM auth WHERE user_id = ?",
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
                    db.all(
                      `SELECT candidates.*, parties.party, parties.logo, positions.position,votes.vote AS vote, elections.election AS candidate_election
                  FROM candidates
                  JOIN parties ON candidates.party_id = parties.id 
                  JOIN positions ON candidates.position_id = positions.id
                  LEFT JOIN votes ON candidates.id = votes.candidate_id
                  JOIN elections ON candidates.election_id = elections.id
                  ORDER BY candidates.id DESC
                  `,
                      [],
                      (err, candidates) => {
                        if (err) {
                          return res
                            .status(500)
                            .send("error fetching candidates");
                        }
                        candidates = candidates.map((candidate) => {
                          return {
                            ...candidate,
                            photo: candidate.photo.toString("base64"),
                            logo: candidate.logo.toString("base64"),
                          };
                        });
                        db.get(
                          "SELECT * FROM users WHERE id = ?",
                          [req.session.userId],
                          (err, user) => {
                            if (err) {
                              return res
                                .status(500)
                                .send(
                                  "Error fetching user from the user table"
                                );
                            }

                            db.all(
                              "SELECT * FROM parties WHERE election_id = ?",
                              [user.election_id],
                              (err, Adminparties) => {
                                if (err) {
                                  return res
                                    .status(500)
                                    .send("Error fetching parties information");
                                }

                                db.all(
                                  "SELECT * FROM positions WHERE election_id = ?",
                                  [user.election_id],
                                  (err, Adminpositions) => {
                                    if (err) {
                                      return res
                                        .status(500)
                                        .send(
                                          "Error fetching positions information"
                                        );
                                    }
                                    db.all(
                                      "SELECT * FROM elections",
                                      [],
                                      (err, elections) => {
                                        if (err) {
                                          return res
                                            .status(500)
                                            .send("Error Fetching elections");
                                        }

                                        db.get(
                                          `SELECT users.*, elections.election AS election_name
                                 FROM users
                                 JOIN elections ON users.election_id = elections.id
                                 WHERE users.id = ?`,
                                          [req.session.userId],
                                          (err, userElectionData) => {
                                            if (err) {
                                              console.error(
                                                "Error getting the user election name:",
                                                err
                                              );
                                              return res.send(
                                                "Error getting the userElectionName"
                                              );
                                            }

                                            db.all(
                                              `SELECT candidates.*, parties.party, parties.logo, positions.position,votes.vote AS vote, elections.election AS candidate_election
                                  FROM candidates
                                  JOIN parties ON candidates.party_id = parties.id 
                                  JOIN positions ON candidates.position_id = positions.id
                                  LEFT JOIN votes ON candidates.id = votes.candidate_id
                                  JOIN elections ON candidates.election_id = elections.id
                                  WHERE candidates.election_id = ?
                                  ORDER BY candidates.id DESC
                                  `,
                                              [user.election_id],
                                              (err, Admincandidates) => {
                                                if (err) {
                                                  return res
                                                    .status(500)
                                                    .send(
                                                      "error fetching candidates"
                                                    );
                                                }
                                                Admincandidates =
                                                  Admincandidates.map(
                                                    (candidate) => {
                                                      return {
                                                        ...candidate,
                                                        photo:
                                                          candidate.photo.toString(
                                                            "base64"
                                                          ),
                                                        logo: candidate.logo.toString(
                                                          "base64"
                                                        ),
                                                      };
                                                    }
                                                  );

                                                res.render(
                                                  "candidate-registration",
                                                  {
                                                    parties,
                                                    positions,
                                                    profilePicture,
                                                    role: userRole.role,
                                                    unreadCount:
                                                      countResult.unreadCount,
                                                    candidates,
                                                    user,
                                                    elections,
                                                    userElectionData,
                                                    Adminparties,
                                                    Adminpositions,
                                                    Admincandidates,
                                                    secondRole,
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
          }
        );
      });
    });
  });
});

app.post("/update/candidate", (req, res) => {
  const {
    id,
    first_name,
    middle_name,
    last_name,
    position,
    party,
    election,
    user_id,
  } = req.body;

  const query = `
      UPDATE candidates
      SET first_name = ?, middle_name = ?, last_name = ?, position_id = ?, party_id = ?, election_id = ?
      WHERE id = ?;
  `;
  db.run(
    query,
    [first_name, middle_name, last_name, position, party, election, id],
    function (err) {
      if (err) {
        console.error("Error updating candidate:", err.message);
        return res.redirect(
          "/candidate/registration?error=Error updating candidate record"
        );
      }
      db.run(
        `UPDATE users
          SET first_name = ?, middle_name = ?, last_name = ?
          WHERE id = ?
    `,
        [first_name, middle_name, last_name, user_id],
        function (err) {
          if (err) {
            console.error("Error updating candidate:", err.message);
            return res.redirect(
              "/candidate/registration?error=Error updating candidate record"
            );
          }
          res.redirect(
            "/candidate/registration?success=Candidate record updated successfully!"
          );
        }
      );
    }
  );
});
app.post("/delete/candidate/:id", (req, res) => {
  const id = req.params.id;
  db.run("DELETE FROM candidates WHERE id = ?", [id], function (err) {
    if (err) {
      return res.redirect(
        "/candidate/registration?error=Error deleting candidate record"
      );
    }
    res.redirect(
      "/candidate/registration?success=Candidate record deleted successfully!"
    );
  });
});

app.post(
  "/candidate/registration",
  upload.single("photo"),
  async (req, res) => {
    const {
      firstname,
      middlename,
      lastname,
      party,
      position,
      election,
      username,
      password,
      role,
      DOB,
    } = req.body;
    const photo = req.file ? req.file.buffer : null;

    const candidateID = uuidv4();
    const userID = uuidv4();
    const authID = uuidv4();

    // Fetch voter age eligibility from the positions table
    db.get(
      `SELECT candidate_age_eligibility FROM positions WHERE election_id = ? AND id = ?`,
      [election, position],
      async (err, electionEligibility) => {
        if (err) {
          console.error("Error fetching election age eligibility:", err);
          return res.status(500).json({
            success: false,
            message: "Error fetching election details",
          });
        }

        const candidateAgeEligibility =
          electionEligibility?.candidate_age_eligibility;

        if (!candidateAgeEligibility) {
          return res.status(400).json({
            success: false,
            message: "Candidate eligibility not found",
          });
        }

        // Calculate the user's age
        const candidateDOB = new Date(DOB);
        const today = new Date();
        const age =
          today.getFullYear() -
          candidateDOB.getFullYear() -
          (today.getMonth() < candidateDOB.getMonth() ||
          (today.getMonth() === candidateDOB.getMonth() &&
            today.getDate() < candidateDOB.getDate())
            ? 1
            : 0);

        if (age < candidateAgeEligibility) {
          return res.status(400).json({
            success: false,
            message: `Candidate must be at least ${candidateAgeEligibility} years old to register for this election.`,
          });
        }

        try {
          // Check if the username already exists
          const existingUser = await new Promise((resolve, reject) => {
            db.get(
              "SELECT username FROM auth WHERE username = ?",
              [username],
              (err, row) => {
                if (err) return reject(err);
                resolve(row);
              }
            );
          });

          if (existingUser) {
            return res.status(400).json({
              success: false,
              message: `The username '${username}' is already taken. Please choose a different username.`,
            });
          }

          const hashedPassword = await bcrypt.hash(password, 10);

          const electionName = await new Promise((resolve, reject) => {
            db.get(
              "SELECT election FROM elections WHERE id = ?",
              [election],
              (err, row) => {
                if (err) return reject(err);
                resolve(row ? row.election : "the election");
              }
            );
          });

          db.run("BEGIN TRANSACTION");

          await new Promise((resolve, reject) => {
            db.run(
              "INSERT INTO users (id, first_name, middle_name, last_name, DOB, profile_picture, role_id, election_id) VALUES (?,?,?,?,?,?,?,?)",
              [
                userID,
                firstname,
                middlename,
                lastname,
                DOB,
                photo,
                role,
                election,
              ],
              function (err) {
                if (err) return reject(err);
                resolve();
              }
            );
          });

          await new Promise((resolve, reject) => {
            db.run(
              "INSERT INTO auth (id, username, password, user_id) VALUES (?,?,?,?)",
              [authID, username, hashedPassword, userID],
              function (err) {
                if (err) return reject(err);
                resolve();
              }
            );
          });

          await new Promise((resolve, reject) => {
            db.run(
              "INSERT INTO candidates (id, first_name, middle_name, last_name, party_id, position_id, photo, election_id, user_id) VALUES (?,?,?,?,?,?,?,?,?)",
              [
                candidateID,
                firstname,
                middlename,
                lastname,
                party,
                position,
                photo,
                election,
                userID,
              ],
              function (err) {
                if (err) return reject(err);
                resolve();
              }
            );
          });

          const currentTime = new Date();
          const notificationMessage = `Hi ${firstname} ${middlename} ${lastname} (${username}), congratulations on successfully registering for ${electionName} using our online election voting system! Your vote is powerful and can shape the future. Stay tuned for any important updates regarding the election process.`;
          const notificationTitle = "Registration Successful";

          await new Promise((resolve, reject) => {
            db.run(
              `INSERT INTO notifications (id, username, election, message, title, created_at) VALUES (?,?,?,?,?,?)`,
              [
                uuidv4(),
                username,
                election,
                notificationMessage,
                notificationTitle,
                currentTime,
              ],
              function (err) {
                if (err) return reject(err);
                io.to(username).emit("new-notification", {
                  message: notificationMessage,
                  title: notificationTitle,
                  created_at: currentTime,
                });
                resolve();
              }
            );
          });

          db.run("COMMIT");

          res.status(200).json({
            success: true,
            message: `Candidate, ${firstname} ${middlename} ${lastname} has been registered.`,
          });
        } catch (err) {
          console.error(err.message);
          db.run("ROLLBACK");
          res.status(500).json({
            success: false,
            message:
              "There was a problem registering the candidate. Please try again later.",
          });
        }
      }
    );
  }
);

app.get("/my/profile", (req, res) => {
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

    // Check if the user has voted
    const voteStatus = user.has_voted ? "Voted" : "Not Voted";

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

        res.render("profile", {
          user,
          voteStatus,
          unreadCount: countResult.unreadCount,
          profilePicture,
        });
      }
    );
  });
});

app.get("/vote", (req, res) => {
  if (!req.session.userId) {
    return res.redirect("/login");
  }

  db.get(
    `SELECT * FROM users WHERE id = ?`,
    [req.session.userId],
    (err, user) => {
      if (err) {
        return res
          .status(500)
          .send("There was an error getting the login users data");
      }

      const ElectionId = user.election_id;

      const sql = `
    SELECT candidates.id, candidates.first_name, candidates.last_name, candidates.middle_name, candidates.photo, positions.position, parties.party, IFNULL(votes.vote, 0) AS vote
    FROM candidates
    JOIN positions ON candidates.position_id = positions.id
    JOIN parties ON candidates.party_id = parties.id
    LEFT JOIN votes ON candidates.id = votes.candidate_id
    WHERE candidates.election_id = ?
  `;

      db.all(sql, [ElectionId], (err, candidates) => {
        if (err) {
          return res.status(500).send("Error fetching candidates data");
        }
        const profilePicture = req.session.profilePicture;

        candidates = candidates.map((candidate) => {
          return {
            ...candidate,
            photo: candidate.photo.toString("base64"),
          };
        });
        db.get(
          "SELECT users.role_id, roles.role FROM users JOIN roles ON users.role_id = roles.id WHERE users.id = ?",
          [req.session.userId],
          (err, userRole) => {
            if (err) {
              return res.status(500).send("Error fetching user role");
            }
            db.get(
              "SELECT username FROM auth WHERE user_id = ?",
              [req.session.userId],
              (err, user) => {
                if (err) {
                  return res.status(500).send("Error fetching user");
                }

                if (!user) {
                  return res.status(404).send("User not found");
                }

                const groupedCandidates = candidates.reduce(
                  (acc, candidate) => {
                    if (!acc[candidate.position]) {
                      acc[candidate.position] = [];
                    }
                    acc[candidate.position].push(candidate);
                    return acc;
                  },
                  {}
                );

                const userId = req.session.userId;

                db.get(
                  "SELECT election_id FROM users WHERE id = ?",
                  [userId],
                  (err, userElection) => {
                    if (err) {
                      return res
                        .status(500)
                        .send("Error fetching user's registered election");
                    }
                    if (!userElection) {
                      return res
                        .status(404)
                        .send("User's registered election not found");
                    }

                    const userElectionId = userElection.election_id;

                    db.all(
                      "SELECT * FROM candidates WHERE election_id = ?",
                      [userElectionId],
                      (err, candidates) => {
                        if (err) {
                          return res
                            .status(500)
                            .send("Error fetching candidates");
                        }
                        db.get(
                          "SELECT COUNT(*) AS unreadCount FROM notifications WHERE username = ? AND is_read = 0",
                          [user.username],
                          (err, countResult) => {
                            if (err) {
                              return res
                                .status(500)
                                .send(
                                  "Error fetching unread notifications count"
                                );
                            }

                            db.get(
                              "SELECT * FROM users WHERE id = ?",
                              [req.session.userId],
                              (err, users) => {
                                if (err) {
                                  return res
                                    .status(500)
                                    .send("error fetching user election id");
                                }
                                if (!users) {
                                  return res.send("user election id found");
                                }

                                const userElectionID = users.election_id;
                                console.log(
                                  "The is the login user election id",
                                  userElectionID
                                );

                                db.get(
                                  "SELECT * FROM users WHERE id = ?",
                                  [req.session.userId],
                                  (err, user) => {
                                    if (err) {
                                      return res
                                        .status(500)
                                        .send(
                                          "Error fetching user from the user table"
                                        );
                                    }

                                    console.log("The current user data", user);

                                    db.get(
                                      `SELECT start_time, end_time FROM election_settings WHERE election_settings.election_id = ?`,
                                      [user.election_id],
                                      (err, electionTiming) => {
                                        if (err) {
                                          return res
                                            .status(500)
                                            .send(
                                              "Error fetching election timing from the election settings table"
                                            );
                                        }

                                        console.log(
                                          "The election timing data",
                                          electionTiming
                                        );

                                        const currentTime =
                                          new Date().toLocaleTimeString(
                                            "en-US",
                                            {
                                              hour12: false,
                                            }
                                          );

                                        console.log(
                                          "Current Time",
                                          currentTime
                                        );

                                        const startTime =
                                          electionTiming.start_time;
                                        const endTime = electionTiming.end_time;

                                        const currentDate =
                                          startTime.split("T")[0];

                                        const fullCurrentTime = `${currentDate}T${currentTime}`;

                                        const start = new Date(startTime);
                                        const end = new Date(endTime);
                                        const current = new Date(
                                          fullCurrentTime
                                        );

                                        res.render("vote", {
                                          candidates,
                                          role: userRole.role,
                                          profilePicture,
                                          unreadCount: countResult.unreadCount,
                                          user,
                                          groupedCandidates,
                                          userElectionID,
                                          start,
                                          end,
                                          current,
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
                  }
                );
              }
            );
          }
        );
      });
    }
  );
});

app.post("/vote", upload.none(), (req, res) => {
  const { electionID } = req.body;

  console.log("Req Body", req.body);

  const userId = req.session.userId;
  const positions = Object.keys(req.body);

  const votePromises = [];

  db.get(
    "SELECT * FROM user_votes WHERE user_id = ?",
    [userId],
    (err, userVote) => {
      if (err) {
        console.error("Error checking user vote:", err);
        return res
          .status(500)
          .json({ success: false, message: "Database error" });
      }

      if (userVote) {
        return res
          .status(403)
          .json({ success: false, message: "Sorry! You have already voted." });
      }

      const handleVote = (candidateId) => {
        return new Promise((resolve, reject) => {
          if (!candidateId) {
            return resolve();
          }

          db.get(
            "SELECT * FROM votes WHERE candidate_id = ?",
            [candidateId],
            (err, vote) => {
              if (err) {
                return reject(err);
              }

              if (vote) {
                db.run(
                  "UPDATE votes SET vote = vote + 1 WHERE candidate_id = ?",
                  [candidateId],
                  (err) => {
                    if (err) {
                      return reject(err);
                    }
                    resolve();
                  }
                );
              } else {
                db.run(
                  "INSERT INTO votes (candidate_id, vote) VALUES (?, 1)",
                  [candidateId],
                  (err) => {
                    if (err) {
                      return reject(err);
                    }
                    resolve();
                  }
                );
              }
            }
          );
        });
      };

      // Loop through all positions and cast votes
      positions.forEach((position) => {
        const candidateId = req.body[position];
        if (candidateId) {
          votePromises.push(handleVote(candidateId));
        }
      });

      Promise.all(votePromises)
        .then(() => {
          db.run(
            "INSERT INTO user_votes (user_id) VALUES (?)",
            [userId],
            (err) => {
              if (err) {
                console.error("Error recording user vote:", err);
                return res
                  .status(500)
                  .json({ success: false, message: "Database error" });
              }

              db.run(
                "UPDATE users SET has_voted = 1 WHERE id = ?",
                [userId],
                (err) => {
                  if (err) {
                    console.error("Error updating user vote status:", err);
                    return res
                      .status(500)
                      .json({ success: false, message: "Database error" });
                  }

                  db.get(
                    "SELECT username FROM auth WHERE user_id = ?",
                    [req.session.userId],
                    (err, user) => {
                      if (err) {
                        return res.status(500).send("error fetching username");
                      }
                      if (!user) {
                        return res.send("user not found");
                      }

                      const currentTime = new Date();
                      const notificationMessage = `Thank you ${user.username}, for casting your vote. It has been successfully counted.`;
                      const notificationTitle = "Vote Counted";

                      db.run(
                        `INSERT INTO notifications (username, election, message, title, created_at) VALUES (?,?,?,?,?)`,
                        [
                          user.username,
                          electionID,
                          notificationMessage,
                          notificationTitle,
                          currentTime,
                        ],
                        function (err) {
                          if (err) {
                            console.error("Error inserting notification:", err);
                            return res.status(500).json({
                              success: false,
                              message:
                                "Database error by inserting into the notification",
                            });
                          }

                          // Emit the notification to the user's room
                          io.to(user.username).emit("new-notification", {
                            message: notificationMessage,
                            title: notificationTitle,
                            created_at: currentTime,
                          });

                          res.status(200).json({
                            success: true,
                            message: "Your vote has been counted",
                          });
                        }
                      );
                    }
                  );
                }
              );
            }
          );
        })
        .catch((err) => {
          console.error("Error processing votes:", err);
          res.status(500).send("Error processing votes");
        });
    }
  );
});

app.get("/forget-password", (req, res) => {
  res.render("forget-password");
});

app.post("/forget-password", (req, res) => {
  const { username, password, passwordConfirm } = req.body;

  if (password !== passwordConfirm) {
    return res
      .status(400)
      .json({ success: false, message: "Passwords do not match" });
  }

  db.get("SELECT * FROM auth WHERE username = ?", [username], (err, user) => {
    if (err) {
      return res
        .status(500)
        .json({ success: false, message: "An error occurred" });
    }
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "Username does not exist" });
    }

    bcrypt.hash(password, 10, (err, hash) => {
      if (err) {
        return res
          .status(500)
          .json({ success: false, message: "An error occurred" });
      }
      db.run(
        "UPDATE auth SET password = ? WHERE username = ?",
        [hash, username],
        function (err) {
          if (err) {
            return res
              .status(500)
              .json({ success: false, message: "An error occurred" });
          }

          return res
            .status(200)
            .json({ success: true, message: "Password Updated Successfully" });
        }
      );
    });
  });
});

// VOTER SETTING PAGE ROUTE
app.get("/voter/setting", (req, res) => {
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

        const sql = `
      SELECT users.*, roles.role, auth.username
      FROM users
      JOIN roles ON users.role_id = roles.id
      JOIN auth ON users.id = auth.user_id
      WHERE users.id = ?
    `;

        res.render("voter-setting", {
          unreadCount: countResult.unreadCount,
          profilePicture,
          user,
        });
      }
    );
  });
});

// POST ROUTE FOR UPDATING THE USER PASSWORD FROM THE SEETING PAGE
app.post("/setting/forget-password", (req, res) => {
  const { username, password, passwordConfirm } = req.body;

  if (password !== passwordConfirm) {
    return res
      .status(400)
      .json({ success: false, message: "Passwords do not match" });
  }

  db.get(
    "SELECT * FROM auth WHERE username = ? AND user_id = ?",
    [username, req.session.userId],
    (err, user) => {
      if (err) {
        return res.status(500).send("An error occurred");
      }
      if (!user) {
        return res.status(404).json({
          success: false,
          message:
            "Sorry! An error occured. Please check your username correctly.",
        });
      }
      if (user.username !== username) {
        return res.status(403).json({
          success: false,
          message: "You are not authorize to change this password",
        });
      }
      bcrypt.hash(password, 10, (err, hash) => {
        if (err) {
          return res
            .status(500)
            .json({ success: false, message: "An error occurred" });
        }
        db.run(
          "UPDATE auth SET password = ? WHERE username = ? AND user_id = ?",
          [hash, username, req.session.userId],
          function (err) {
            if (err) {
              return res
                .status(500)
                .json({ success: false, message: "An error occurred" });
            }
            res.status(200).json({
              success: true,
              message: "Password updated successfully",
            });
          }
        );
      });
    }
  );
});

// ROUTE FOR UPDATING THE USERNAME
app.post("/setting/change/username", upload.none(), (req, res) => {
  const { username, Newusername, password } = req.body;

  db.get(
    "SELECT * FROM auth WHERE user_id = ?",
    [req.session.userId],
    (err, user) => {
      if (err) {
        return res
          .status(500)
          .json({ success: false, message: "Internal server error" });
      }
      if (!user) {
        return res
          .status(500)
          .json({ success: false, message: "User does not exist" });
      }
      if (user.username !== username) {
        return res.status(403).json({
          success: false,
          message: "You are not authorized to change this username",
        });
      }

      bcrypt.compare(password, user.password, (err, result) => {
        if (result) {
          db.run(
            "UPDATE auth SET username = ? WHERE username = ? AND user_id = ?",
            [Newusername, username, req.session.userId],
            function (err) {
              if (err) {
                return res
                  .status(500)
                  .json({ success: false, message: "Internal server error" });
              }
              return res.status(200).json({
                success: true,
                message: "Username updated successfully!",
              });
            }
          );
        } else {
          return res.status(500).json({
            success: false,
            message:
              "There was an error updating your username. Please provide your correct information.",
          });
        }
      });
    }
  );
});

//========================== ELECTION BEGINS ==========================================

//============================ ELECTION GET ROUTE =================================
app.get("/create/election", (req, res) => {
  if (!req.session.userId || req.session.userRole !== "Super Admin") {
    return res.redirect("/login");
  }
  const profilePicture = req.session.profilePicture;
  db.get(
    "SELECT users.role_id, roles.role FROM users JOIN roles ON users.role_id = roles.id WHERE users.id = ?",
    [req.session.userId],
    (err, userRole) => {
      if (err) {
        return res.status(500).send("Error fetching user role");
      }
      db.all(
        `SELECT elections.*, election_settings.*
              FROM elections
              JOIN election_settings ON elections.id = election_settings.election_id
        `,
        [],
        (err, elections) => {
          if (err) {
            return res.status(500).send("Error fetching elections");
          }
          db.get(
            "SELECT username FROM auth WHERE user_id = ?",
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
                  db.get(
                    "SELECT * FROM users WHERE id = ?",
                    [req.session.userId],
                    (err, user) => {
                      if (err) {
                        return res
                          .status(500)
                          .send("Error fetching user from the user table");
                      }
                      res.render("election", {
                        profilePicture,
                        role: userRole.role,
                        elections,
                        user,
                        unreadCount: countResult.unreadCount,
                        user,
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

//============================== ELECTION POST ROUTE ===============================
app.post("/create/election", (req, res) => {
  if (!req.session.userId) {
    res.redirect("/login");
  }
  const { election, start_time, end_time, voter_age_eligibility } = req.body;

  console.log(req.body);

  const electionID = uuidv4();

  db.run(
    "INSERT INTO elections (id, election, voter_age_eligibility) VALUES (?,?,?)",
    [electionID, election, voter_age_eligibility],

    function (err) {
      if (err) {
        return res.status(500).json({
          success: false,
          message: "An error occured creating election",
        });
      }
      db.run(
        `INSERT INTO election_settings (id, start_time, end_time, election_id) VALUES(?,?,?,?)`,
        [uuidv4(), start_time, end_time, electionID],
        function (err) {
          if (err) {
            return res.status(500).json({
              success: false,
              message: "An error occured creating election settings",
            });
          }
          res.status(200).json({
            success: true,
            message: `${election}, successfully created`,
          });
        }
      );
    }
  );
});

app.post("/update/election", upload.none(), (req, res) => {
  const { id, election, startTime, endTime, voter_age_eligibilities } =
    req.body;

  console.log(req.body);

  db.run(
    "UPDATE elections SET election = ?, voter_age_eligibility = ? WHERE id = ?",
    [election, voter_age_eligibilities, id],
    function (err) {
      if (err) {
        console.error(err.message);
        return res.status(500).send("Error updating election");
      }

      db.run(
        "UPDATE election_settings SET start_time = ?, end_time = ? WHERE election_id = ?",
        [startTime, endTime, id],
        function (err) {
          if (err) {
            console.error(err.message);
            return res.status(500).send("Error updating election dates");
          }
          res.redirect("/create/election");
        }
      );
    }
  );
});

app.post("/delete/election/:id", (req, res) => {
  const id = req.params.id;

  db.run(`DELETE FROM elections WHERE id = ?`, [id], function (err) {
    if (err) {
      console.error("Error deleting election:", err.message);
      return res.send("Error Deleting Election");
    }

    db.run(`DELETE FROM election_settings WHERE election_id = ?`, [id], function (err) {
      if (err) {
        console.error("Error deleting election settings:", err.message);
        return res.send("Error Deleting Election");
      }

      res.redirect("/create/election");
    });
  });
});


app.get("/vote/analysis", (req, res) => {
  if (!req.session.userId) {
    return res.redirect("/login");
  }

  db.get(
    "SELECT * FROM users WHERE id = ?",
    [req.session.userId],
    (err, currentUserID) => {
      if (err) {
        console.error("Error fetching current user data:", err);
        return res.status(500).send("Error fetching current user data");
      }

      console.log("Current user data", currentUserID.election_id);

      const positionsQuery = `
    SELECT positions.position, candidates.first_name, candidates.middle_name, candidates.last_name, IFNULL(SUM(votes.vote), 0) AS vote
    FROM candidates
    JOIN positions ON candidates.position_id = positions.id
    LEFT JOIN votes ON candidates.id = votes.candidate_id
    WHERE candidates.election_id = ?
    GROUP BY positions.position, candidates.id
    ORDER BY positions.position, candidates.last_name

  `;

      db.all(positionsQuery, [currentUserID.election_id], (err, candidates) => {
        if (err) {
          console.error("Error fetching candidates data:", err);
          return res.status(500).send("Error fetching candidates data");
        }

        const groupedData = {};
        candidates.forEach((candidate) => {
          const position = candidate.position;
          const candidateName = `${candidate.first_name} ${
            candidate.middle_name || ""
          } ${candidate.last_name}`;
          if (!groupedData[position]) {
            groupedData[position] = { labels: [], votes: [] };
          }
          groupedData[position].labels.push(candidateName.trim());
          groupedData[position].votes.push(candidate.vote);
        });

        db.get(
          "SELECT users.role_id, roles.role FROM users JOIN roles ON users.role_id = roles.id WHERE users.id = ?",
          [req.session.userId],
          (err, userRole) => {
            if (err) {
              return res.status(500).send("Error fetching user role");
            }
            db.get(
              "SELECT username FROM auth WHERE user_id = ?",
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
                    db.get(
                      "SELECT * FROM users WHERE id = ?",
                      [req.session.userId],
                      (err, user) => {
                        if (err) {
                          return res
                            .status(500)
                            .send("Error fetching user from the user table");
                        }

                        res.render("vote-analysis", {
                          groupedData: JSON.stringify(groupedData), // Pass data as JSON to the template
                          profilePicture: req.session.profilePicture,
                          role: userRole.role,
                          unreadCount: countResult.unreadCount,
                          user,
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
    }
  );
});

app.get("/create/notification", (req, res) => {
  if (
    !req.session.userId ||
    (req.session.userRole !== "Super Admin" && req.session.userRole !== "Admin")
  ) {
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
              "SELECT username FROM auth WHERE user_id = ?",
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
                    db.get(
                      "SELECT * FROM users WHERE id = ?",
                      [req.session.userId],
                      (err, user) => {
                        if (err) {
                          return res
                            .status(500)
                            .send("Error fetching user from the user table");
                        }

                        db.all("SELECT * FROM elections", (err, elections) => {
                          if (err) {
                            return res
                              .status(500)
                              .send(
                                "There was an error getting the elections data"
                              );
                          }

                          db.get(
                            `SELECT users.*, elections.election AS election_name
                             FROM users
                             JOIN elections ON users.election_id = elections.id
                             WHERE users.id = ?`,
                            [req.session.userId],
                            (err, userElectionData) => {
                              if (err) {
                                console.error(
                                  "Error getting the user election name:",
                                  err
                                );
                                return res.send(
                                  "Error getting the userElectionName"
                                );
                              }

                              res.render("create-notification", {
                                users,
                                currentUser: user,
                                profilePicture,
                                voteStatus,
                                role: userRole.role,
                                roles,
                                unreadCount: countResult.unreadCount,
                                user,
                                elections,
                                userElectionData,
                              });
                            }
                          );
                        });
                      }
                    );
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
  const { election, message, title } = req.body;

  // Sanitize HTML content
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

  db.all(
    `SELECT users.*, auth.username
     FROM users
     JOIN auth ON users.id = auth.user_id
     WHERE users.election_id = ?
    `,
    [election],
    (err, users) => {
      if (err) {
        return res
          .status(500)
          .json({ success: false, message: "Error fetching users data" });
      }

      const insertPromises = users.map((user) => {
        return new Promise((resolve, reject) => {
          const notificationID = uuidv4();
          const currentTime = new Date();

          db.run(
            `INSERT INTO notifications (id, username, election, message, title, created_at) VALUES (?,?,?,?,?,?)`,
            [
              notificationID,
              user.username,
              election,
              sanitizedMessage,
              title,
              currentTime,
            ],
            function (err) {
              if (err) {
                return reject(err);
              }

              io.to(user.username).emit("new-notification", {
                message: sanitizedMessage,
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
          res.status(200).json({
            success: true,
            message: "Notifications sent successfully",
          });
        })
        .catch((err) => {
          console.error("Error inserting notifications:", err);
          res.status(500).json({
            success: false,
            message: "Database error occurred while inserting notifications",
          });
        });
    }
  );
});

app.get("/notifications", (req, res) => {
  if (!req.session.userId) {
    return res.redirect("/login");
  }

  db.get(
    "SELECT username FROM auth WHERE user_id = ?",
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
                  db.get(
                    "SELECT * FROM users WHERE id = ?",
                    [req.session.userId],
                    (err, userData) => {
                      if (err) {
                        return res
                          .status(500)
                          .send("Error fetching user from the user table");
                      }

                      res.render("notification", {
                        username: user.username,
                        userId: req.session.userId,
                        notifications,
                        profilePicture,
                        userData,
                        unreadCount: countResult.unreadCount,
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
io.on("connection", (socket) => {
  console.log("A user connected");

  socket.on("join", (userId) => {
    db.get(
      "SELECT username FROM auth WHERE user_id = ?",
      [userId],
      (err, user) => {
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
      }
    );
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

const secretSavedToken = process.env.SECRET_TOKEN;

app.get("/create/user", (req, res) => {
  const token = req.query.token;

  console.log("Token passed:", token);
  console.log("Secret Token:", secretSavedToken);

  if (token !== secretSavedToken) {
    return res.status(403).send("Access Denied");
  } else {
    db.all("SELECT * FROM elections", [], (err, elections) => {
      if (err) {
        return res.status(500).send("Error Fetching elections");
      }
      db.all("SELECT * FROM roles", [], (err, roles) => {
        if (err) {
          return res.status(500).send("internal server error");
        }

        res.render("createUser", {
          roles,

          elections,
        });
      });
    });
  }
});

// =============================== VOTERS POST ROUTE ==================================
app.post("/create/user", upload.single("photo"), (req, res) => {
  const {
    firstname,
    middlename,
    lastname,
    dob,
    username,
    role,
    election,
    password,
  } = req.body;
  const photo = req.file ? req.file.buffer : null;

  const userID = uuidv4();

  bcrypt.hash(password, 10, (err, hashedPassword) => {
    if (err) {
      console.error(err.message);
      return res.status(500).json({ success: false, message: "Server error" });
    }

    db.get(
      "SELECT election FROM elections WHERE id = ?",
      [election],
      (err, row) => {
        if (err) {
          console.error("Error fetching election name:", err);
          return res.status(500).json({
            success: false,
            message: "Error fetching election, error",
          });
        }

        const electionName = row ? row.election : "the election";

        db.run(
          "INSERT INTO users(id, first_name, middle_name, last_name, DOB, profile_picture, role_id, election_id) VALUES (?,?,?,?,?,?,?,?)",
          [userID, firstname, middlename, lastname, dob, photo, role, election],
          function (err) {
            if (err) {
              console.error(err.message);
              return res.status(500).json({
                success: false,
                message: "Error inserting into users error",
              });
            }

            db.run(
              "INSERT INTO auth(id, username, password, user_id) VALUES (?,?,?,?)",
              [uuidv4(), username, hashedPassword, userID],
              function (err) {
                if (err) {
                  console.error(err.message);
                  return res.status(500).json({
                    success: false,
                    message: "Error inserting into auth error",
                  });
                }

                const currentTime = new Date();
                const notificationMessage = `Hi ${firstname} ${middlename} ${lastname} (${username}), congratulations on successfully registering for ${electionName} using our online election voting system! Your vote is powerful and can shape the future. Stay tuned for any important updates regarding the election process.`;
                const notificationTitle = "Registration Successful";

                db.run(
                  `INSERT INTO notifications (id, username, election, message, title, created_at) VALUES (?,?,?,?,?,?)`,
                  [
                    uuidv4(),
                    username,
                    election,
                    notificationMessage,
                    notificationTitle,
                    currentTime,
                  ],
                  function (err) {
                    if (err) {
                      console.error("Error inserting notification:", err);
                      return res.status(500).json({
                        success: false,
                        message: "Error inserting notification: error",
                      });
                    }

                    // Emit the notification to the user's room
                    io.to(username).emit("new-notification", {
                      message: notificationMessage,
                      title: notificationTitle,
                      created_at: currentTime,
                    });

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
      }
    );
  });
});

app.get("/party-dashboard", (req, res) => {
  if (!req.session.userId || req.session.userRole !== "Candidate") {
    return res.redirect("/login");
  }

  db.get(
    "SELECT * FROM candidates WHERE user_id = ?",
    [req.session.userId],
    (err, currentUser) => {
      if (err) {
        console.error("Error fetching current user:", err);
        return res.status(500).send("An error occurred");
      }
      if (!currentUser) {
        return res.status(404).send("User not found");
      }

      console.log("Current Logged-in candidate", currentUser);

      const currentCandidate = `
        SELECT candidates.*, parties.*, users.*
        FROM candidates
        JOIN parties ON candidates.party_id = parties.id
        JOIN users ON candidates.user_id = users.id
        WHERE candidates.election_id = ? AND candidates.user_id = ?
      `;

      db.get(
        `SELECT candidates.*, parties.*, users.*
        FROM candidates
        JOIN parties ON candidates.party_id = parties.id
        JOIN users ON candidates.user_id = users.id
        WHERE candidates.election_id = ? AND candidates.user_id = ?`,
        [currentUser.election_id, currentUser.user_id],
        (err, user) => {
          if (err) {
            console.error(
              `Error fetching current candidate for election_id ${currentUser.election_id}:`,
              err
            );
            return res
              .status(500)
              .send("An error occurred while fetching candidate data.");
          }

          if (!user) {
            return res
              .status(404)
              .send("Candidate not found for the specified election.");
          }

          user.photo = user.photo ? user.photo.toString("base64") : null;
          user.logo = user.logo ? user.logo.toString("base64") : null;

          console.log("Current Candidate Data", user);

          //         const allCandidate = `
          // SELECT candidates.*, parties.*, positions.position, votes.*
          // FROM candidates
          // JOIN parties ON candidates.party_id = parties.id
          // JOIN positions ON candidates.position_id = positions.id
          // JOIN votes ON candidates.id = votes.candidate_id
          // WHERE candidates.party_id = ? AND candidates.election_id = ?
          // `;

          db.all(
            `SELECT candidates.*, parties.*, positions.position, votes.*
              FROM candidates 
              JOIN parties ON candidates.party_id = parties.id
              JOIN positions ON candidates.position_id = positions.id
              LEFT JOIN votes ON candidates.id = votes.candidate_id
              WHERE candidates.party_id = ? AND candidates.election_id = ?`,
            [user.party_id, user.election_id],
            (err, users) => {
              if (err) {
                console.error("Error fetching all candidates:", err);
                return res
                  .status(500)
                  .send("An error occurred while fetching all candidates");
              }

              users.forEach((user) => {
                if (user.photo) {
                  user.photo = user.photo.toString("base64");
                }

                if (user.logo) {
                  user.logo = user.logo.toString("base64");
                }
              });

              console.log("All candidates", users);

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
                    // db.get(
                    //   "SELECT username FROM auth WHERE user_id = ?",
                    //   [req.session.userId],
                    //   (err, user) => {
                    //     if (err) {
                    //       return res.status(500).send("Error fetching user");
                    //     }

                    //     if (!user) {
                    //       return res.status(404).send("User not found");
                    //     }

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
                        // db.get(
                        //   "SELECT * FROM users WHERE id = ?",
                        //   [req.session.userId],
                        //   (err, user) => {
                        //     if (err) {
                        //       return res
                        //         .status(500)
                        //         .send(
                        //           "Error fetching user from the user table"
                        //         );
                        //     }

                        db.all("SELECT * FROM elections", (err, elections) => {
                          if (err) {
                            return res
                              .status(500)
                              .send(
                                "There was an error getting the elections data"
                              );
                          }

                          db.get(
                            `SELECT users.*, elections.election AS election_name
                             FROM users
                             JOIN elections ON users.election_id = elections.id
                             WHERE users.id = ?`,
                            [req.session.userId],
                            (err, userElectionData) => {
                              if (err) {
                                console.error(
                                  "Error getting the user election name:",
                                  err
                                );
                                return res.send(
                                  "Error getting the userElectionName"
                                );
                              }

                              res.render("party-dashboard", {
                                users,
                                profilePicture,
                                voteStatus,
                                role: userRole.role,
                                roles,
                                unreadCount: countResult.unreadCount,
                                user,
                                elections,
                                userElectionData,
                              });
                            }
                          );
                        });
                      }
                    );
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

// Downloading registered voters and election results list
//
app.get("/voters-record", (req, res) => {
  if (
    !req.session.userId ||
    (req.session.userRole !== "Super Admin" &&
      req.session.userRole !== "Admin" &&
      req.session.userRole !== "Candidate")
  ) {
    return res.redirect("/login");
  }
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
          "SELECT * FROM users WHERE id = ?",
          [req.session.userId],
          (err, currentUser) => {
            if (err) {
              console.error("Error fetching current user:", err);
              return res.status(500).send("An error occurred");
            }
            if (!currentUser) {
              return res.status(404).send("User not found");
            }

            db.all(
              `SELECT users.*, elections.election 
              FROM users
              JOIN elections ON users.election_id = elections.id
         WHERE election_id = ?`,
              [currentUser.election_id],
              (err, allVotersData) => {
                if (err) {
                  console.error("Error fetching voters:", err);
                  return res.status(500).send("An error occurred");
                }
                db.get(
                  `SELECT users.*
            FROM users
            WHERE users.election_id = ? AND users.id = ?`,
                  [currentUser.election_id, currentUser.id],
                  (err, user) => {
                    if (err) {
                      console.error(
                        `Error fetching current candidate for election_id ${currentUser.election_id}:`,
                        err
                      );
                      return res
                        .status(500)
                        .send(
                          "An error occurred while fetching candidate data."
                        );
                    }

                    if (!user) {
                      return res
                        .status(404)
                        .send(
                          "Candidate not found for the specified election."
                        );
                    }
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
                        res.render("voters-record", {
                          allVotersData,
                          role: userRole.role,
                          roles,
                          unreadCount: countResult.unreadCount,
                          user,
                          profilePicture,
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
    }
  );
});

app.get("/download/csv", (req, res) => {
  if (
    !req.session.userId ||
    (req.session.userRole !== "Super Admin" &&
      req.session.userRole !== "Admin" &&
      req.session.userRole !== "Candidate")
  ) {
    return res.redirect("/login");
  }

  db.get(
    "SELECT * FROM users WHERE id = ?",
    [req.session.userId],
    (err, currentUser) => {
      if (err) {
        console.error("Error fetching current user:", err);
        return res.status(500).send("An error occurred");
      }
      if (!currentUser) {
        return res.status(404).send("User not found");
      }

      db.all(
        `SELECT users.*, elections.election, roles.role
              FROM users
              JOIN elections ON users.election_id = elections.id
              JOIN roles ON users.role_id = roles.id
              WHERE users.election_id = ?`,
        [currentUser.election_id],
        (err, rows) => {
          if (err) {
            console.error("Error fetching voters:", err);
            return res.status(500).send("An error occurred");
          }

          if (rows.length === 0) {
            return res.status(404).send("No voter records found.");
          }

          try {
            const fields = [
              "first_name",
              "middle_name",
              "last_name",
              "election",
            ];
            const parser = new Parser({ fields });
            const csv = parser.parse(rows);

            res.header("Content-Type", "text/csv");
            res.attachment("voters-data.csv");
            res.send(csv);
          } catch (csvError) {
            console.error("CSV generation error:", csvError);
            return res.status(500).send("Error generating CSV");
          }
        }
      );
    }
  );
});

// ============== Downloading Election result ===============

app.get("/election-record", (req, res) => {
  if (
    !req.session.userId ||
    (req.session.userRole !== "Super Admin" &&
      req.session.userRole !== "Admin" &&
      req.session.userRole !== "Candidate")
  ) {
    return res.redirect("/login");
  }
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
          "SELECT * FROM users WHERE id = ?",
          [req.session.userId],
          (err, currentUser) => {
            if (err) {
              console.error("Error fetching current user:", err);
              return res.status(500).send("Error fetching current user:");
            }
            if (!currentUser) {
              return res.status(404).send("User not found");
            }

            db.all(
              `SELECT candidates.*, votes.vote, positions.position, parties.party
              FROM candidates
              JOIN votes ON candidates.id = votes.candidate_id
              JOIN positions ON candidates.position_id = positions.id
              JOIN parties ON candidates.party_id = parties.id
              WHERE candidates.election_id = ?`,
              [currentUser.election_id],
              (err, allCandidateData) => {
                if (err) {
                  console.error("Error fetching candidate info:", err);
                  return res.status(500).send("Error fetching candidate info:");
                }
                db.get(
                  `SELECT users.*
            FROM users
            WHERE users.election_id = ? AND users.id = ?`,
                  [currentUser.election_id, currentUser.id],
                  (err, user) => {
                    if (err) {
                      console.error(
                        `Error fetching current candidate for election_id ${currentUser.election_id}:`,
                        err
                      );
                      return res
                        .status(500)
                        .send(
                          "An error occurred while fetching candidate data."
                        );
                    }

                    if (!user) {
                      return res
                        .status(404)
                        .send(
                          "Candidate not found for the specified election."
                        );
                    }
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
                        res.render("election-record", {
                          allCandidateData,
                          role: userRole.role,
                          roles,
                          unreadCount: countResult.unreadCount,
                          user,
                          profilePicture,
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
    }
  );
});

app.get("/election/download/csv", (req, res) => {
  if (
    !req.session.userId ||
    (req.session.userRole !== "Super Admin" &&
      req.session.userRole !== "Admin" &&
      req.session.userRole !== "Candidate")
  ) {
    return res.redirect("/login");
  }

  db.get(
    "SELECT * FROM users WHERE id = ?",
    [req.session.userId],
    (err, currentUser) => {
      if (err) {
        console.error("Error fetching current user:", err);
        return res.status(500).send("An error occurred");
      }
      if (!currentUser) {
        return res.status(404).send("User not found");
      }

      db.all(
        `SELECT candidates.*, votes.vote, positions.position, parties.party
              FROM candidates
              JOIN votes ON candidates.id = votes.candidate_id
              JOIN positions ON candidates.position_id = positions.id
              JOIN parties ON candidates.party_id = parties.id
              WHERE candidates.election_id = ?`,
        [currentUser.election_id],
        (err, rows) => {
          if (err) {
            console.error("Error fetching candidates:", err);
            return res.status(500).send("An error occurred");
          }

          if (rows.length === 0) {
            return res.status(404).send("No Candidate records found.");
          }

          try {
            const fields = [
              "first_name",
              "middle_name",
              "last_name",
              "position",
              "party",
              "vote",
            ];
            const parser = new Parser({ fields });
            const csv = parser.parse(rows);

            res.header("Content-Type", "text/csv");
            res.attachment("election-data.csv");
            res.send(csv);
          } catch (csvError) {
            console.error("CSV generation error:", csvError);
            return res.status(500).send("Error generating CSV");
          }
        }
      );
    }
  );
});

//     }
//   );
// });

app.listen(port, () => {
  console.log(`App is listening to port ${port}`);
});
