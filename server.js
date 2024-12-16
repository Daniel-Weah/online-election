const express = require("express");
const path = require("path");
const bodyParser = require("body-parser");
const http = require("http");
const socketIo = require("socket.io");
const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcrypt");
const session = require("express-session");
const multer = require("multer");
require('dotenv').config();


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
    secret: 'thisismysecrctekeyfhrgfgrfrty84fwir767',
    resave: false,
    saveUninitialized: true,
  })
);

db.serialize(() => {
  db.run(
    "CREATE TABLE IF NOT EXISTS auth(id INTEGER PRIMARY KEY AUTOINCREMENT, username VARCHAR(50) NOT NULL UNIQUE, password VARCHAR(255) NOT NULL, user_id INTEGER)"
  );
  db.run(
    "CREATE TABLE IF NOT EXISTS roles(id INTEGER PRIMARY KEY AUTOINCREMENT, role VARCHAR(50) NOT NULL)"
  );
  db.run(
    "CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT, first_name VARCHAR(50) NOT NULL, middle_name VARCHAR(50) NULL, last_name VARCHAR(50) NOT NULL, DOB DATE NOT NULL, profile_picture BLOB NOT NULL, role_id INTEGER, election_id INTEGER, has_voted INTEGER)"
  );
  db.run(
    "CREATE TABLE IF NOT EXISTS parties(id INTEGER PRIMARY KEY AUTOINCREMENT, party VARCHAR(50) NOT NULL, logo BLOB)"
  );
  db.run(
    "CREATE TABLE IF NOT EXISTS positions(id INTEGER PRIMARY KEY AUTOINCREMENT, position VARCHAR(50) NOT NULL)"
  );
  db.run(
    "CREATE TABLE IF NOT EXISTS candidates(id INTEGER PRIMARY KEY AUTOINCREMENT, first_name VARCHAR(50) NOT NULL, middle_name VARCHAR(50) NULL, last_name VARCHAR(50) NOT NULL, party_id INTEGER NOT NULL, position_id INTEGER NOT NULL, election_id INTEGER NOT NULL, photo BLOB)"
  );
  db.run(
    "CREATE TABLE IF NOT EXISTS votes(id INTEGER PRIMARY KEY AUTOINCREMENT, candidate_id INTEGER NOT NULL, vote INTEGER DEFAULT 0, UNIQUE(candidate_id))"
  );

  db.run(
    `
    CREATE TABLE IF NOT EXISTS user_votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL
    )
  `
  );

  db.run(
    "CREATE TABLE IF NOT EXISTS elections (id INTEGER PRIMARY KEY AUTOINCREMENT, election VARCHAR(50) NOT NULL UNIQUE, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)"
  );

  db.run(
    "CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, username VARCHAR(50) NOT NULL, election INTEGER NOT NULL, message VARCHAR(2000) NOT NULL, title VARCHAR(50) NOT NULL, is_read INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(username) REFERENCES auth (username))"
  );

  // db.run("DELETE FROM auth WHERE id = 13");

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
  //   "DROP TABLE elections"
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
          "SELECT * FROM users WHERE id = ?",
          [user.user_id],
          (err, userData) => {
            if (err) {
              return res.status(500).send("Internal Server Error");
            }
            req.session.userId = user.user_id;
            req.session.profilePicture =
              userData.profile_picture.toString("base64");
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

  console.log('The session userID', req.session.userId);

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

      // Continue with fetching data for the selected election
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
        "SELECT COUNT(*) AS totalUsers FROM users WHERE election_id = ?",
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

                                  const profilePicture = req.session.profilePicture;


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

// Route to render dashboard
// app.get("/dashboard", (req, res) => {
//   if (!req.session.userId) {
//     return res.redirect("/login");
//   }

//   db.get(
//     "SELECT election_id FROM users WHERE id = ?",
//     [req.session.userId],
//     (err, userElection) => {
//       if (err) {
//         return res
//           .status(500)
//           .send("Error fetching user's registered election");
//       }
//       if (!userElection) {
//         return res.status(404).send("User's registered election not found");
//       }

//       const userElectionId = userElection.election_id;

//       const sqlCandidates = `
//       SELECT candidates.*, parties.party, parties.logo, positions.position, IFNULL(SUM(votes.vote), 0) AS vote
//       FROM candidates
//       JOIN parties ON candidates.party_id = parties.id
//       JOIN positions ON candidates.position_id = positions.id
//       LEFT JOIN votes ON candidates.id = votes.candidate_id
//       WHERE candidates.election_id = ?
//       GROUP BY candidates.id
//       `;

//       const sqlTotalVotesPerPosition = `
//       SELECT positions.position, SUM(IFNULL(votes.vote, 0)) AS totalVotes
//       FROM candidates
//       JOIN positions ON candidates.position_id = positions.id
//       LEFT JOIN votes ON candidates.id = votes.candidate_id
//       WHERE candidates.election_id = ?
//       GROUP BY positions.position
//       `;

//       db.get(
//         "SELECT COUNT(*) AS totalUsers FROM users WHERE election_id = ?",
//         [userElectionId],
//         (err, result) => {
//           if (err) {
//             return res.status(500).send("Error fetching total users");
//           }
//           const totalUsers = result.totalUsers;
//           const profilePicture = req.session.profilePicture;

//           db.all(sqlTotalVotesPerPosition, [userElectionId],
//             (err, totalVotesPerPosition) => {
//               if (err) {
//                 return res
//                   .status(500)
//                   .send("Error fetching total votes per position");
//               }

//               const totalVotesMap = {};
//               totalVotesPerPosition.forEach((row) => {
//                 totalVotesMap[row.position] = row.totalVotes || 0;
//               });

//               db.all(sqlCandidates, [userElectionId], (err, candidates) => {
//                 if (err) {
//                   return res.status(500).send("Error fetching candidates data");
//                 }

//                 candidates = candidates.map((candidate) => {
//                   return {
//                     ...candidate,
//                     photo: candidate.photo.toString("base64"),
//                     logo: candidate.logo.toString("base64"),
//                     votePercentage:
//                       totalVotesMap[candidate.position] > 0
//                         ? (candidate.vote / totalVotesMap[candidate.position]) *
//                           100
//                         : 0,
//                   };
//                 });

//                 const totalVotes = totalVotesPerPosition.reduce(
//                   (acc, row) => acc + row.totalVotes,
//                   0
//                 );

//                 const groupedCandidates = candidates.reduce(
//                   (acc, candidate) => {
//                     if (!acc[candidate.position]) {
//                       acc[candidate.position] = [];
//                     }
//                     acc[candidate.position].push(candidate);
//                     return acc;
//                   },
//                   {}
//                 );

//                 db.get(
//                   "SELECT users.role_id, roles.role FROM users JOIN roles ON users.role_id = roles.id WHERE users.id = ?",
//                   [req.session.userId],
//                   (err, userRole) => {
//                     if (err) {
//                       return res.status(500).send("Error fetching user role");
//                     }

//                     // Fetch the current user's username
//                     db.get(
//                       "SELECT username FROM auth WHERE user_id = ?",
//                       [req.session.userId],
//                       (err, user) => {
//                         if (err) {
//                           return res.status(500).send("Error fetching user");
//                         }

//                         if (!user) {
//                           return res.status(404).send("User not found");
//                         }

//                         // Fetch unread notifications count
//                         db.get(
//                           "SELECT COUNT(*) AS unreadCount FROM notifications WHERE username = ? AND is_read = 0",
//                           [user.username],
//                           (err, countResult) => {
//                             if (err) {
//                               return res
//                                 .status(500)
//                                 .send(
//                                   "Error fetching unread notifications count"
//                                 );
//                             }
//                             db.get(
//                               "SELECT * FROM users WHERE id = ?",
//                               [req.session.userId],
//                               (err, user) => {
//                                 if (err) {
//                                   return res
//                                     .status(500)
//                                     .send(
//                                       "Error fetching user from the user table"
//                                     );
//                                 }

//                                 db.all('SELECT * FROM elections', (err, elections) => {
//                                   if (err) {
//                                     return res.status(500).send('There was an error getting the elections data');
//                                   }

//                                 res.render("dashboard", {
//                                   totalUsers,
//                                   profilePicture,
//                                   candidates,
//                                   totalVotes,
//                                   role: userRole.role,
//                                   unreadCount: countResult.unreadCount,
//                                   user,
//                                   groupedCandidates,
//                                   elections
//                                 });
//                               }
//                             );
//                           }
//                         );
//                       }
//                     );
//                   }
//                 );
//               });
//             }
//           );
//         }
//       );
//     }
//   );
// });
// });

// Route to render login form

// ================================= VOTERS BEGINS =====================================

// ============================ VOTERS GET ROUTE ================================

app.get("/voters", (req, res) => {
  if (!req.session.userId) {
    return res.redirect("login");
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
          db.all("SELECT * FROM elections", [], (err, elections) => {
            if (err) {
              return res.status(500).send("Error Fetching elections");
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

                          res.render("voters", {
                            users,
                            currentUser: user,
                            profilePicture,
                            voteStatus,
                            role: userRole.role,
                            roles,
                            unreadCount: countResult.unreadCount,
                            user,
                            elections,
                          });
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
});

// =============================== VOTERS POST ROUTE ==================================
app.get("/voters", (req, res) => {
  if (!req.session.userId) {
    return res.redirect("login");
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

    console.log('Login user data:', user);

    user.profile_picture = user.profile_picture.toString("base64");

    // Fetch all users
    const allUsersSql = `
      SELECT users.*, roles.role, auth.username, elections.election
      FROM users 
      JOIN roles ON users.role_id = roles.id
      JOIN elections ON users.election_id = elections.id
      JOIN auth ON users.id = auth.user_id
      ORDER BY users.id DESC
    `;

   

    // Ensure adminUsers is passed to the render method
    db.all(allUsersSql, [], (err, users) => {
        if (err) {
            console.error("Error fetching all users:", err);
            return res.status(500).send("Error fetching users");
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
            db.all("SELECT * FROM roles", [], (err, roles) => {
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
                        return res.status(500).send("Error fetching unread notifications count");
                      }
                      const profilePicture = req.session.profilePicture;

                      db.get(
                        "SELECT * FROM users WHERE id = ?",
                        [req.session.userId],
                        (err, user) => {
                          if (err) {
                            return res.status(500).send("Error fetching user from the user table");
                          }



                          const adminAllUsersSql = `
                          SELECT users.*, roles.role, auth.username, elections.election
                          FROM users 
                          JOIN roles ON users.role_id = roles.id
                          JOIN elections ON users.election_id = elections.id
                          JOIN auth ON users.id = auth.user_id
                          WHERE users.election_id = 1
                          ORDER BY users.id DESC
                        `;
                      
                      
                        db.all(adminAllUsersSql, [], (err, adminUsers) => {
                          if (err) {
                              console.error("Error fetching admin users:", err);
                              return res.status(500).send("Error fetching admin users");
                          }
                      
                          console.log("Fetched admin users:", adminUsers);
                      
                          adminUsers.forEach((adminUser) => {
                              if (adminUser.profile_picture) {
                                  adminUser.profile_picture = adminUser.profile_picture.toString("base64");
                              }
                          });

                         

                          res.render("voters", {
                            users,                            
                            currentUser: user,
                            profilePicture,
                            voteStatus,
                            role: userRole.role,
                            roles,
                            unreadCount: countResult.unreadCount,
                            user,
                            elections,
                          });
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
});
});


app.get("/admin/voters", (req, res) => {
  if (!req.session.userId) {
    return res.redirect("login");
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

    console.log('Login user data:', user);

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
            db.all("SELECT * FROM roles", [], (err, roles) => {
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
                        return res.status(500).send("Error fetching unread notifications count");
                      }
                      const profilePicture = req.session.profilePicture;

                      db.get(
                        "SELECT * FROM users WHERE id = ?",
                        [req.session.userId],
                        (err, user) => {
                          if (err) {
                            return res.status(500).send("Error fetching user from the user table");
                          }



                          const adminAllUsersSql = `
                          SELECT users.*, roles.role, auth.username, elections.election
                          FROM users 
                          JOIN roles ON users.role_id = roles.id
                          JOIN elections ON users.election_id = elections.id
                          JOIN auth ON users.id = auth.user_id
                          WHERE users.election_id = ?
                          ORDER BY users.id DESC
                        `;
                      
                      
                        db.all(adminAllUsersSql, [user.election_id], (err, adminUsers) => {
                          if (err) {
                              console.error("Error fetching admin users:", err);
                              return res.status(500).send("Error fetching admin users");
                          }
                      
                          console.log("Fetched admin users:", adminUsers);
                      
                          adminUsers.forEach((adminUser) => {
                              if (adminUser.profile_picture) {
                                  adminUser.profile_picture = adminUser.profile_picture.toString("base64");
                              }
                          });

                         

                          res.render("admin-voters", {
                            adminUsers,                           
                            currentUser: user,
                            profilePicture,
                            voteStatus,
                            role: userRole.role,
                            roles,
                            unreadCount: countResult.unreadCount,
                            user,
                            elections,
                          });
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
  const photo = req.file ? req.file.buffer : null;

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
          return res.status(500).json({ success: false, message: "Database error" });
        }

        const electionName = row ? row.election : "the election";

        db.run(
          "INSERT INTO users(first_name, middle_name, last_name, DOB, profile_picture, role_id, election_id) VALUES (?,?,?,?,?,?,?)",
          [firstname, middlename, lastname, dob, photo, role, election],
          function (err) {
            if (err) {
              console.error(err.message);
              return res.status(500).json({ success: false, message: "Database error" });
            }

            const userId = this.lastID;

            db.get(
              "SELECT username FROM auth WHERE username = ?",
              [username],
              function (err, row) {
                if (err) {
                  console.error(err.message);
                  return res.status(500).json({ success: false, message: "Database error" });
                }

                if (row) {
                  return res.status(400).json({ success: false, message: "Username already exists" });
                } else {
                  db.run(
                    "INSERT INTO auth(username, password, user_id) VALUES (?,?,?)",
                    [username, hashedPassword, userId],
                    function (err) {
                      if (err) {
                        console.error(err.message);
                        return res.status(500).json({ success: false, message: "Database error" });
                      }

                      const currentTime = new Date();
                      const notificationMessage = `Hi ${username}, congratulations on successfully registering for ${electionName} using our online election voting system! Your vote is powerful and can shape the future. Stay tuned for any important updates regarding the election process.`;
                      const notificationTitle = "Registration Successful";

                      db.run(
                        `INSERT INTO notifications (username, election, message, title, created_at) VALUES (?,?,?,?,?)`,
                        [username, election, notificationMessage, notificationTitle, currentTime],
                        function (err) {
                          if (err) {
                            console.error("Error inserting notification:", err);
                            return res.status(500).json({ success: false, message: "Database error" });
                          }

                          // Emit the notification to the user's room
                          io.to(username).emit("new-notification", {
                            message: notificationMessage,
                            title: notificationTitle,
                            created_at: currentTime,
                          });

                          console.log(`A row has been inserted with ID ${userId}`);
                          res.status(201).json({
                            success: true,
                            message: `${username} has successfully been registered`,
                          });
                        }
                      );
                    }
                  );
                }
              }
            );
          }
        );
      }
    );
  });
});

// app.post("/voters", upload.single("photo"), (req, res) => {
//   const {
//     firstname,
//     middlename,
//     lastname,
//     dob,
//     username,
//     role,
//     election,
//     password,
//   } = req.body;
//   const photo = req.file ? req.file.buffer : null;

//   bcrypt.hash(password, 10, (err, hashedPassword) => {
//     if (err) {
//       console.error(err.message);
//       return res.status(500).json({ success: false, message: "Server error" });
//     }

//     // Fetch the election name using the election ID
//     db.get(
//       "SELECT election FROM elections WHERE id = ?",
//       [election],
//       (err, row) => {
//         if (err) {
//           console.error("Error fetching election name:", err);
//           return res
//             .status(500)
//             .json({ success: false, message: "Database error" });
//         }

//         const electionName = row ? row.election : "the election";

//         db.run(
//           "INSERT INTO users(first_name, middle_name, last_name, DOB, profile_picture, role_id, election_id) VALUES (?,?,?,?,?,?,?)",
//           [firstname, middlename, lastname, dob, photo, role, election],
//           function (err) {
//             if (err) {
//               console.error(err.message);
//               return res
//                 .status(500)
//                 .json({ success: false, message: "Database error" });
//             }

//             const userId = this.lastID;

//             db.get(
//               "SELECT username FROM auth WHERE username = ?",
//               [username],
//               function (err, row) {
//                 if (err) {
//                   console.error(err.message);
//                   return res
//                     .status(500)
//                     .json({ success: false, message: "Database error" });
//                 }
            
//                 if (row) {
//                   // If the username already exists
//                   return res
//                     .status(400)
//                     .json({ success: false, message: "Username already exists" });
//                 } else {
//                   // If the username does not exist, proceed to insert
//                   db.run(
//                     "INSERT INTO auth(username, password, user_id) VALUES (?,?,?)",
//                     [username, hashedPassword, userId],
//                     function (err) {
//                       if (err) {
//                         console.error(err.message);
//                         return res
//                           .status(500)
//                           .json({ success: false, message: "Database error" });
//                       }
//                       // If insertion is successful
//                       return res
//                         .status(201)
//                         .json({ success: true, message: "User registered successfully" });
             
            

//                 const currentTime = new Date();
//                 const notificationMessage = `Hi ${username}, congratulations on successfully registering for ${electionName} using our online election voting system! Your vote is powerful and can shape the future. Stay tuned for any important updates regarding the election process.`;
//                 const notificationTitle = "Registration Successful";

//                 db.run(
//                   `INSERT INTO notifications (username, election, message, title, created_at) VALUES (?,?,?,?,?)`,
//                   [
//                     username,
//                     election,
//                     notificationMessage,
//                     notificationTitle,
//                     currentTime,
//                   ],
//                   function (err) {
//                     if (err) {
//                       console.error("Error inserting notification:", err);
//                       return res
//                         .status(500)
//                         .json({ success: false, message: "Database error" });
//                     }

//                     // Emit the notification to the user's room
//                     io.to(username).emit("new-notification", {
//                       message: notificationMessage,
//                       title: notificationTitle,
//                       created_at: currentTime,
//                     });

//                     console.log(`A row has been inserted with ID ${userId}`);
//                     res.status(200).json({
//                       success: true,
//                       message: `${username} has successfully been registered`,
//                     });
//                   }
//                 );
//               };
//             );
//           }
//         );
//       }
//     );
//   });
// });
// });

// Handle delete request
app.post("/delete/user/:id", (req, res) => {
  const id = req.params.id;
  db.run("DELETE FROM users WHERE id = ?", [id]);
  db.run("DELETE FROM auth WHERE id = ?", [id]);
  res.redirect("/voters");
});

// ================================= VOTERS ENDS =====================================

// Route to render party registration form
app.get("/create/party", (req, res) => {
  if (!req.session.userId) {
    return res.redirect("/login");
  }
  db.all("SELECT * FROM parties", [], (err, parties) => {
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
                    res.render("party-registration", {
                      parties,
                      role: userRole.role,
                      profilePicture,
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
});

app.post("/create/party", upload.single("logo"), (req, res) => {
  const { party } = req.body;
  const logo = req.file ? req.file.buffer : null;

  db.run(
    "INSERT INTO parties (party, logo) VALUES (?, ?)",
    [party, logo],
    function (err) {
      if (err) {
        console.error(err.message);
        return res.status(500).send("Error saving party information");
      }
      console.log(`A row has been inserted with rowid ${this.lastID}`);
      res.status(200).send("Party created successfully");
    }
  );
});

// Handle delete request
app.post("/delete/party/:id", (req, res) => {
  const id = req.params.id;
  db.run("DELETE FROM parties WHERE id = ?", [id]);
  res.redirect("/create/party");
});

app.get("/add/position", (req, res) => {
  if (!req.session.userId) {
    return res.redirect("/login");
  }
  db.all("SELECT * FROM positions", [], (err, positions) => {
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
                    res.render("position.ejs", {
                      positions,
                      profilePicture,
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
});

app.post("/add/position", (req, res) => {
  const { Position } = req.body;

  db.run("INSERT INTO positions (position) VALUES (?)", [Position], (err) => {
    if (err) {
      return console.log(err.message);
    }
    console.log("New record has been added");
    res.send("Position has been successfully added");
  });
});

app.post("/delete/position/:id", (req, res) => {
  const id = req.params.id;
  db.run("DELETE FROM positions WHERE id = ?", [id]);
  res.redirect("/add/position");
});

//======================== CANDIDATE REGISTRATION ROUTES =============================

app.get("/candidate/registration", (req, res) => {
  if (!req.session.userId) {
    return res.redirect("/login");
  }
  db.all("SELECT * FROM parties", [], (err, parties) => {
    if (err) {
      return res.status(500).send("Error fetching parties information");
    }

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
                    `SELECT candidates.*, parties.party, parties.logo, positions.position,votes.vote AS vote 
                  FROM candidates
                  JOIN parties ON candidates.party_id = parties.id 
                  JOIN positions ON candidates.position_id = positions.id
                  LEFT JOIN votes ON candidates.id = votes.candidate_id
                  ORDER BY candidates.id
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
                              .send("Error fetching user from the user table");
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
                              res.render("candidate-registration", {
                                parties,
                                positions,
                                profilePicture,
                                role: userRole.role,
                                unreadCount: countResult.unreadCount,
                                candidates,
                                user,
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
        }
      );
    });
  });
});

app.post("/candidate/registration", upload.single("photo"), (req, res) => {
  const { firstname, middlename, lastname, party, position, election } =
    req.body;
  const photo = req.file ? req.file.buffer : null;

  db.run(
    "INSERT INTO candidates (first_name, middle_name, last_name, party_id, position_id, photo, election_id) VALUES (?,?,?,?,?,?,?)",
    [firstname, middlename, lastname, party, position, photo, election],
    function (err) {
      if (err) {
        console.error(err.message);
        res.status(500).json({
          success: false,
          message:
            "There was a problem sending your information. Please try again later",
        });
      } else {
        res.status(200).json({
          success: true,
          message: `Candidate, ${firstname} ${middlename} ${lastname} has been registered.`,
        });
      }
    }
  );
});

// ROUTE FOR USER PROFILE PAGE
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

    res.render("profile", { user, voteStatus });
  });
});

// THE MAIN ASPECT OF THE ONLINE PLATFORM, THE VOTING PROCESS
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
            photo: candidate.photo.toString("base64"), // Convert photo to base64
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

                // Group candidates by position
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

                    // Fetch candidates registered for the same election as the user
                    db.all(
                      "SELECT * FROM candidates WHERE election_id = ?",
                      [userElectionId],
                      (err, candidates) => {
                        if (err) {
                          return res
                            .status(500)
                            .send("Error fetching candidates");
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
                              (err, users) => {
                                if (err) {
                                  return res.status(500).send("error fetching user election id");
                                }
                                if (!users) {
                                  return res.send("user election id found");
                                }
      
                                const userElectionID = users.election_id;
                                console.log('The is the login user election id', userElectionID);

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
                                res.render("vote", {
                                  candidates,
                                  role: userRole.role,
                                  profilePicture,
                                  unreadCount: countResult.unreadCount,
                                  user,
                                  groupedCandidates,
                                  userElectionID
                                  
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
      });
    }
  );
});
});

app.post("/vote", upload.none(), (req, res) => {
  const { electionID } = req.body;

  console.log('Req Body', req.body);

  const userId = req.session.userId;
  const positions = Object.keys(req.body); // Get all positions from the form submission

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
                              message: "Database error by inserting into the notification",
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
  res.render("voter-setting");
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
    "SELECT * FROM auth WHERE username = ? AND id = ?",
    [username, req.session.userId],
    (err, user) => {
      if (err) {
        return res.status(500).send("An error occurred");
      }
      if (!user) {
        return res.status(404).send("Username does not exist");
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
          "UPDATE auth SET password = ? WHERE username = ? AND id = ?",
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
app.post("/setting/change/username", (req, res) => {
  const { username, Newusername } = req.body;

  db.get(
    "SELECT * FROM auth WHERE id = ?",
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

      db.run(
        "UPDATE auth SET username = ? WHERE username = ? AND id = ?",
        [Newusername, username, req.session.userId],
        function (err) {
          if (err) {
            return res
              .status(500)
              .json({ success: false, message: "Internal server error" });
          }
          return res
            .status(200)
            .json({ success: true, message: "Username updated successfully!" });
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
        return res
          .status(500)
          .json({ success: false, message: "An error occured" });
      }
      res
        .status(200)
        .json({ success: true, message: `${election}, successfully created` });
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
                      groupedCandidates,
                      profilePicture,
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
                          });
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
          .json({ success: false, message: "Error fetching username" });
      }

      const insertPromises = users.map((user) => {
        return new Promise((resolve, reject) => {
          const currentTime = new Date();

          db.run(
            `INSERT INTO notifications (username, election, message, title, created_at) VALUES (?,?,?,?,?)`,
            [user.username, election, message, title, currentTime],
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
          res
            .status(200)
            .json({
              success: true,
              message: "Notifications sent successfully",
            });
        })
        .catch((err) => {
          console.error("Error inserting notifications:", err);
          res.status(500).json({ success: false, message: "Database error" });
        });
    }
  );
});

// Route to fetch notifications
app.get("/notifications", (req, res) => {
  if (!req.session.userId) {
    return res.redirect("/login");
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
    db.get("SELECT username FROM auth WHERE user_id = ?", [userId], (err, user) => {
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

app.get("/create/user", (req, res) => {
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
});
//             });
//           });
//         }
//       );
//     });
//   });
// });

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

  bcrypt.hash(password, 10, (err, hashedPassword) => {
    if (err) {
      console.error(err.message);
      return res.status(500).json({ success: false, message: "Server error" });
    }

    // Fetch the election name using the election ID
    db.get(
      "SELECT election FROM elections WHERE id = ?",
      [election],
      (err, row) => {
        if (err) {
          console.error("Error fetching election name:", err);
          return res
            .status(500)
            .json({ success: false, message: "Error fetching election, error" });
        }

        const electionName = row ? row.election : "the election";

        db.run(
          "INSERT INTO users(first_name, middle_name, last_name, DOB, profile_picture, role_id, election_id) VALUES (?,?,?,?,?,?,?)",
          [firstname, middlename, lastname, dob, photo, role, election],
          function (err) {
            if (err) {
              console.error(err.message);
              return res
                .status(500)
                .json({ success: false, message: "Error inserting into users error" });
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
                    .json({ success: false, message: "Error inserting into auth error" });
                }

                const currentTime = new Date();
                const notificationMessage = `Hi ${username}, congratulations on successfully registering for ${electionName} using our online election voting system! Your vote is powerful and can shape the future. Stay tuned for any important updates regarding the election process.`;
                const notificationTitle = "Registration Successful";

                db.run(
                  `INSERT INTO notifications (username, election, message, title, created_at) VALUES (?,?,?,?,?)`,
                  [
                    username,
                    election,
                    notificationMessage,
                    notificationTitle,
                    currentTime,
                  ],
                  function (err) {
                    if (err) {
                      console.error("Error inserting notification:", err);
                      return res
                        .status(500)
                        .json({ success: false, message: "Error inserting notification: error" });
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
      }
    );
  });
});

app.listen(port, () => {
  console.log(`App is listening to port ${port}`);
});
