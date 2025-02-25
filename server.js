const express = require("express");
const path = require("path");
const bodyParser = require("body-parser");
const http = require("http");
const socketIo = require("socket.io");
const bcrypt = require("bcrypt");
const session = require("express-session");
const multer = require("multer");
require("dotenv").config();
const { v4: uuidv4 } = require("uuid");
const crypto = require("crypto");
const sanitizeHtml = require("sanitize-html");
const fs = require("fs");
const { Parser } = require("json2csv");
const nodemailer = require("nodemailer");
const cors = require("cors");
const { Pool } = require('pg');
const async = require('async');


const app = express();

app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
  })
); 

app.use(cors());
app.use(bodyParser.json());
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

const Redis = require("ioredis");
const redis = new Redis();

const pool = new Pool({
  user: 'neondb_owner',
  host: process.env.DATABASE_HOST, 
  database: 'neondb',
  password: process.env.DATABASE_PASS, 
  port: 5432,
  ssl: {
    rejectUnauthorized: false, 
  },
});



pool.connect()
  .then(() => console.log('Connected to Neon PostgreSQL database successfully!'))
  .catch(err => console.error('Error connecting to Neon PostgreSQL database:', err));

module.exports = pool;



app.use((req, res, next) => {
  req.io = io;
  next();
});

app.get("/", (req, res) => {
  res.render("index");
});
// ============= SENDING MESSAGE FROM THE HOME PAGE TO MY EMAIL ============

// Nodemailer Transporter
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// Route to handle contact form submission
app.post("/send-email", (req, res) => {
  const { name, email, message } = req.body;

  const mailOptions = {
    from: email,
    to: process.env.EMAIL_USER,
    subject: `New Contact Message from ${name}`,
    text: `Name: ${name}\nEmail: ${email}\n\nMessage:\n${message}`,
  };

  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      console.error("Error sending email:", error);
      res.status(500).json({ success: false, message: "Failed to send email" });
    } else {
      console.log("Email sent:", info.response);
      res
        .status(200)
        .json({ success: true, message: "Email sent successfully" });
    }
  });
});

app.get("/login", (req, res) => {
  res.render("login.ejs");
});

// Route to handle login form submission
app.post("/login", (req, res) => {
  const { username, password } = req.body;

  pool.query("SELECT * FROM auth WHERE username = $1", [username], (err, result) => {
    if (err) {
      return res.status(500).send("Internal Server Error");
    }

    const user = result.rows[0]; // Extract the first user from the result set
    if (!user) {
      return res.render("login", {
        errorMessage: "Invalid username or password",
      });
    }

    bcrypt.compare(password, user.password, (err, isMatch) => {
      if (err) {
        return res.status(500).send("Internal Server Error");
      }
      if (!isMatch) {
        return res.render("login", {
          errorMessage: "Invalid username or password",
        });
      }

      // Fetch user data and role
      pool.query(
        `SELECT users.*, roles.role AS role_name
        FROM users
        JOIN roles ON users.role_id = roles.id
        WHERE users.id = $1`,
        [user.user_id],
        (err, userDataResult) => {
          if (err) {
            return res.status(500).send("Internal Server Error");
          }

          const userData = userDataResult.rows[0];

          if (!userData) {
            return res.status(500).send("User data not found.");
          }

          req.session.userId = user.user_id;
          req.session.profilePicture = userData.profile_picture
            ? userData.profile_picture.toString("base64")
            : null; // Handle null case
          req.session.userRole = userData.role_name;

          res.redirect("/dashboard");
        }
      );
    });
  });
});




// Assuming pool is already configured for your database

app.get("/dashboard", async (req, res) => {
  if (!req.session.userId) {
    return res.redirect("/login");
  }

  try {
    const electionId = req.query.electionId || null;

    // Get election ID from user
    const userElectionQuery = await pool.query(
      "SELECT election_id FROM users WHERE id = $1",
      [req.session.userId]
    );
    const userElectionId = electionId || userElectionQuery.rows[0]?.election_id;

    if (!userElectionId) {
      return res.status(404).send("Election not selected or registered");
    }

    // Cache prefix
    const cachePrefix = `dashboard:${userElectionId}:`;

    // Check cache
    const cachedCandidates = await redis.get(cachePrefix + "candidates");
    const cachedTotalVotes = await redis.get(cachePrefix + "totalVotes");

    if (cachedCandidates && cachedTotalVotes) {
      // Fetch additional data since totalUsers is not cached
      const totalUsersQuery = await pool.query(
        `SELECT COUNT(*) AS totalUsers 
         FROM auth 
         JOIN users ON auth.user_id = users.id 
         WHERE users.election_id = $1`,
        [userElectionId]
      );

      const totalUsers = totalUsersQuery.rows[0].totalusers;

      // Fetch role, user details, and elections
      const [userRoleQuery, unreadCountQuery, userDetailsQuery, electionsQuery] =
        await Promise.all([
          pool.query(
            "SELECT users.role_id, roles.role FROM users JOIN roles ON users.role_id = roles.id WHERE users.id = $1",
            [req.session.userId]
          ),
          pool.query(
            "SELECT COUNT(*) AS unreadCount FROM notifications WHERE username = (SELECT username FROM auth WHERE user_id = $1) AND is_read = 0",
            [req.session.userId]
          ),
          pool.query("SELECT * FROM users WHERE id = $1", [req.session.userId]),
          pool.query("SELECT * FROM elections"),
        ]);

      return res.render("dashboard", {
        totalUsers,
        candidates: JSON.parse(cachedCandidates),
        totalVotes: JSON.parse(cachedTotalVotes),
        groupedCandidates: JSON.parse(cachedCandidates).reduce((acc, candidate) => {
          acc[candidate.position] = acc[candidate.position] || [];
          acc[candidate.position].push(candidate);
          return acc;
        }, {}),
        elections: electionsQuery.rows,
        selectedElection: userElectionId,
        role: userRoleQuery.rows[0]?.role,
        unreadCount: unreadCountQuery.rows[0]?.unreadcount || 0,
        user: userDetailsQuery.rows[0],
        profilePicture: req.session.profilePicture,
      });
    }

    // Fetch all needed data from DB if cache misses
    const [candidatesQuery, totalVotesQuery, totalVotesPerPositionQuery] = await Promise.all([
      pool.query(
        `SELECT candidates.*, parties.party, parties.logo, positions.position, 
                COALESCE(SUM(votes.vote), 0) AS vote
         FROM candidates
         JOIN parties ON candidates.party_id = parties.id
         JOIN positions ON candidates.position_id = positions.id
         LEFT JOIN votes ON candidates.id = votes.candidate_id
         WHERE candidates.election_id = $1
         GROUP BY candidates.id, parties.party, parties.logo, positions.position`,
        [userElectionId]
      ),
      pool.query(
        `SELECT COALESCE(SUM(votes.vote), 0) AS totalVotes
         FROM candidates
         LEFT JOIN votes ON candidates.id = votes.candidate_id
         WHERE candidates.election_id = $1`,
        [userElectionId]
      ),
      pool.query(
        `SELECT positions.position, COALESCE(SUM(votes.vote), 0) AS totalVotes
         FROM candidates
         JOIN positions ON candidates.position_id = positions.id
         LEFT JOIN votes ON candidates.id = votes.candidate_id
         WHERE candidates.election_id = $1
         GROUP BY positions.position`,
        [userElectionId]
      ),
    ]);

    let totalVotes = totalVotesQuery.rows[0]?.totalvotes || 0;

    // Compute votes per position
    let totalVotesMap = {};
    totalVotesPerPositionQuery.rows.forEach((row) => {
      totalVotesMap[row.position] = row.totalvotes || 0;
    });

    let candidates = candidatesQuery.rows.map((candidate) => ({
      ...candidate,
      photo: candidate.photo ? candidate.photo.toString("base64") : null,
      logo: candidate.logo ? candidate.logo.toString("base64") : null,
      votePercentage:
        totalVotesMap[candidate.position] > 0
          ? (candidate.vote / totalVotesMap[candidate.position]) * 100
          : 0,
    }));

    // Store results in cache
    await Promise.all([
      redis.set(cachePrefix + "candidates", JSON.stringify(candidates), "EX", 3600),
      redis.set(cachePrefix + "totalVotes", JSON.stringify(totalVotes), "EX", 3600),
    ]);

    let groupedCandidates = candidates.reduce((acc, candidate) => {
      acc[candidate.position] = acc[candidate.position] || [];
      acc[candidate.position].push(candidate);
      return acc;
    }, {});

    // Fetch additional user data
    const totalUsersQuery = await pool.query(
      `SELECT COUNT(*) AS totalUsers 
       FROM auth 
       JOIN users ON auth.user_id = users.id 
       WHERE users.election_id = $1`,
      [userElectionId]
    );

    const totalUsers = totalUsersQuery.rows[0]?.totalusers;

    const [userRoleQuery, unreadCountQuery, userDetailsQuery, electionsQuery] =
      await Promise.all([
        pool.query(
          "SELECT users.role_id, roles.role FROM users JOIN roles ON users.role_id = roles.id WHERE users.id = $1",
          [req.session.userId]
        ),
        pool.query(
          "SELECT COUNT(*) AS unreadCount FROM notifications WHERE username = (SELECT username FROM auth WHERE user_id = $1) AND is_read = 0",
          [req.session.userId]
        ),
        pool.query("SELECT * FROM users WHERE id = $1", [req.session.userId]),
        pool.query("SELECT * FROM elections"),
      ]);

    res.render("dashboard", {
      totalUsers,
      candidates,
      totalVotes,
      groupedCandidates,
      elections: electionsQuery.rows,
      selectedElection: userElectionId,
      role: userRoleQuery.rows[0]?.role,
      unreadCount: unreadCountQuery.rows[0]?.unreadcount || 0,
      user: userDetailsQuery.rows[0],
      profilePicture: req.session.profilePicture,
    });

  } catch (err) {
    console.error(err);
    res.status(500).send("Internal Server Error");
  }
});



// ============================ VOTERS GET ROUTE ================================





app.get("/voters", async (req, res) => {
  if (!req.session.userId || (req.session.userRole !== "Super Admin" && req.session.userRole !== "Admin")) {
    return res.redirect("/login");
  }

  try {
    // Check Redis cache for the current user
    const userCache = await redis.get(`user:${req.session.userId}`);
    let user;
    
    if (userCache) {
      user = JSON.parse(userCache); // If user data is cached
    } else {
      // If not cached, fetch the current user's data from the database
      const currentUserSql = `
        SELECT users.*, roles.role, auth.username
        FROM users
        JOIN roles ON users.role_id = roles.id
        JOIN auth ON users.id = auth.user_id
        WHERE users.id = $1
      `;
      const userResult = await pool.query(currentUserSql, [req.session.userId]);
      
      if (userResult.rows.length === 0) {
        return res.status(404).send("User not found");
      }

      user = userResult.rows[0];
      user.profile_picture = user.profile_picture ? Buffer.from(user.profile_picture).toString("base64") : null;

      // Cache the user data in Redis for 1 hour
      await redis.set(`user:${req.session.userId}`, JSON.stringify(user), 'EX', 3600);
    }

    // Fetch election settings, check Redis cache first
    const electionSettingsCache = await redis.get(`electionSettings:${user.election_id}`);
    let registrationTiming;

    if (electionSettingsCache) {
      registrationTiming = JSON.parse(electionSettingsCache);
    } else {
      const electionSettingsSql = `SELECT * FROM election_settings WHERE election_id = $1`;
      const electionSettingsResult = await pool.query(electionSettingsSql, [user.election_id]);

      registrationTiming = electionSettingsResult.rows[0];

      // Cache the election settings in Redis for 1 hour
      await redis.set(`electionSettings:${user.election_id}`, JSON.stringify(registrationTiming), 'EX', 3600);
    }

    // Fetch all users (store in Redis as well to cache results)
    const allUsersCache = await redis.get("allUsers");
    let users;

    if (allUsersCache) {
      users = JSON.parse(allUsersCache); // If data is cached
    } else {
      const allUsersSql = `
        SELECT users.*, roles.role, auth.username, elections.election
        FROM users 
        JOIN roles ON users.role_id = roles.id
        JOIN elections ON users.election_id = elections.id
        JOIN auth ON users.id = auth.user_id
      `;
      const usersResult = await pool.query(allUsersSql);
      users = usersResult.rows;

      users.forEach((user) => {
        if (user.profile_picture) {
          user.profile_picture = Buffer.from(user.profile_picture).toString("base64");
        }
      });

      // Cache the users data in Redis for 1 hour
      await redis.set("allUsers", JSON.stringify(users), 'EX', 3600);
    }

    const voteStatus = user.has_voted ? "Voted" : "Not Voted";

    // Fetch role data
    const userRoleResult = await pool.query(
      "SELECT users.role_id, roles.role FROM users JOIN roles ON users.role_id = roles.id WHERE users.id = $1",
      [req.session.userId]
    );
    const userRole = userRoleResult.rows[0];

    // Fetch elections
    const electionsResult = await pool.query("SELECT * FROM elections");
    const elections = electionsResult.rows;

    // Fetch roles
    const rolesResult = await pool.query("SELECT * FROM roles LIMIT 1");
    const roles = rolesResult.rows;

    const allRolesResult = await pool.query("SELECT * FROM roles");
    const allRoles = allRolesResult.rows;

    // Fetch username
    const usernameResult = await pool.query("SELECT username FROM auth WHERE user_id = $1", [req.session.userId]);
    const username = usernameResult.rows[0]?.username;

    if (!username) {
      return res.status(404).send("User not found");
    }

    // Fetch unread notifications count
    const unreadCountResult = await pool.query(
      "SELECT COUNT(*) AS unreadCount FROM notifications WHERE username = $1 AND is_read = 0",
      [username]
    );
    const unreadCount = unreadCountResult.rows[0]?.unreadcount || 0;

    const profilePicture = req.session.profilePicture;

    // Fetch current user data
    const currentUserDataResult = await pool.query("SELECT * FROM users WHERE id = $1", [req.session.userId]);
    const currentUser = currentUserDataResult.rows[0];

    const currentTime = new Date().toLocaleTimeString("en-US", { hour12: false });
    const registrationStartTime = registrationTiming.registration_start_time;
    const registrationEndTime = registrationTiming.registration_end_time;

    const currentDate = registrationStartTime.split("T")[0];
    const fullCurrentTime = `${currentDate}T${currentTime}`;

    const start = new Date(registrationStartTime);
    const end = new Date(registrationEndTime);
    const current = new Date(fullCurrentTime);

    res.render("voters", {
      users,
      profilePicture,
      voteStatus,
      role: userRole.role,
      roles,
      unreadCount,
      user: currentUser,
      elections,
      allRoles,
      start,
      end,
      current,
    });
  } catch (error) {
    console.error("Error fetching voter data:", error);
    return res.status(500).send("An error occurred while fetching data");
  }
});





app.get("/admin/voters", async (req, res) => {
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

    // Check for unread notifications count from Redis cache first
    let unreadCount = await redis.get(`unreadCount:${authUser.username}`);
    if (!unreadCount) {
      // Fetch unread notifications count from the database if not in cache
      const unreadCountQuery = `
        SELECT COUNT(*) AS "unreadCount" 
        FROM notifications 
        WHERE username = $1 AND is_read = 0
      `;
      const { rows: unreadCountRows } = await pool.query(unreadCountQuery, [
        authUser.username,
      ]);
      unreadCount = unreadCountRows[0].unreadCount;
      // Store the unread count in Redis for future requests
      redis.set(`unreadCount:${authUser.username}`, unreadCount, "EX", 3600); // Set an expiration of 1 hour
    }

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

    console.log("Fetched admin users:", adminUsers);

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
    const electionSettingsResult = await pool.query(electionSettingsSql, [user.election_id]);

    const registrationTiming = electionSettingsResult.rows[0];
    console.log("Registration Timing:", registrationTiming);

    const currentTime = new Date().toLocaleTimeString("en-US", { hour12: false });
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
      current
    });
  } catch (err) {
    console.error("Error:", err);
    res.status(500).send("Internal Server Error");
  }
});



// =============================== VOTERS POST ROUTE ==================================
app.post("/voters", upload.single("photo"), async (req, res) => {
  const { firstname, middlename, lastname, dob, username, role, election, password } = req.body;

  if (firstname.length < 3 || lastname.length < 3) {
    return res.status(400).json({ success: false, message: "First Name or Last Name must be at least 3 characters" });
  }

  const photo = req.file ? req.file.buffer : null;
  const votersID = uuidv4();

  try {
    // Check if username already exists for the election
    const existingVoter = await pool.query(
      "SELECT * FROM auth WHERE username = $1 AND election_id = $2",
      [username, election]
    );

    if (existingVoter.rows.length > 0) {
      return res.status(400).json({ success: false, message: `The username '${username}' is already taken.` });
    }

    // Get election age eligibility
    const electionResult = await pool.query("SELECT * FROM elections WHERE id = $1", [election]);
    const electionEligibility = electionResult.rows[0];

    if (!electionEligibility) {
      return res.status(400).json({ success: false, message: "Election eligibility not found" });
    }

    const voterAgeEligibility = electionEligibility.voter_age_eligibility;

    // Calculate user's age
    const userDOB = new Date(dob);
    const today = new Date();
    const age = today.getFullYear() - userDOB.getFullYear() - 
      (today.getMonth() < userDOB.getMonth() || (today.getMonth() === userDOB.getMonth() && today.getDate() < userDOB.getDate()) ? 1 : 0);

    if (age < voterAgeEligibility) {
      return res.status(400).json({ success: false, message: `You must be at least ${voterAgeEligibility} years old to register.` });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // **Start Transaction**
    await pool.query("BEGIN");

    // Insert into users table
    const insertUserQuery = `
      INSERT INTO users(id, first_name, middle_name, last_name, DOB, profile_picture, role_id, election_id) 
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id
    `;
    const userInsertResult = await pool.query(insertUserQuery, [votersID, firstname, middlename, lastname, dob, photo, role, election]);

    if (userInsertResult.rowCount === 0) {
      throw new Error("User insertion failed");
    }

    // Insert into auth table
    const authID = uuidv4();
    const insertAuthQuery = `
      INSERT INTO auth(id, username, password, user_id, election_id) 
      VALUES ($1, $2, $3, $4, $5)
    `;
    const authInsertResult = await pool.query(insertAuthQuery, [authID, username, hashedPassword, votersID, election]);

    if (authInsertResult.rowCount === 0) {
      throw new Error("Auth insertion failed");
    }

    // Insert notification
    const notificationMessage = `Hi ${firstname} ${middlename} ${lastname} (${username}), you have successfully registered for ${electionEligibility.election}!`;
    await pool.query(
      "INSERT INTO notifications (id, username, election, message, title, created_at) VALUES ($1, $2, $3, $4, $5, NOW())",
      [uuidv4(), username, election, notificationMessage, "Registration Successful"]
    );

    // Commit transaction if everything is successful
    await pool.query("COMMIT");

    // Emit notification
    io.to(username).emit("new-notification", {
      message: notificationMessage,
      title: "Registration Successful",
      created_at: new Date(),
    });

    res.status(201).json({ success: true, message: `${username} has successfully been registered` });

  } catch (err) {
    // Rollback transaction if an error occurs
    await pool.query("ROLLBACK");
    console.error("Error processing request:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});


// Delete user
app.post("/delete/user/:id", (req, res) => {
  const id = req.params.id;
  pool.query("DELETE FROM users WHERE id = $1", [id], function (err) {
    if (err) {
      console.error("Error deleting user:", err.message);
      return res.redirect("/voters?error=Error Deleting User");
    }
    pool.query("DELETE FROM auth WHERE user_id = $1", [id], function (err) {
      if (err) {
        console.error("Error deleting user:", err.message);
        return res.redirect("/voters?error=Error Deleting User");
      }

      pool.query("DELETE FROM candidates WHERE user_id = $1", [id], function (err) {
        if (err) {
          console.error("Error deleting user:", err.message);
          return res.redirect("/voters?error=Error Deleting User");
        }

        pool.query("DELETE FROM user_votes WHERE user_id = $1", [id], function (err) {
          if (err) {
            console.error("Error deleting user:", err.message);
            return res.redirect("/voters?error=Error Deleting User");
          }
        res.redirect("/voters?success=User Deleted Successfully!");
      });
    });
  });
});
});


// Mark user as voted
app.post("/voted/user/:id", (req, res) => {
  const id = req.params.id;
  const votedID = uuidv4();
  pool.query(
    "UPDATE users SET has_voted = $1 WHERE id = $2",
    [1, id],
    function (err) {
      if (err) {
        console.error("Error updating user:", err.message);
        return res.redirect("/voters?error=Error Marking User as Voted");
      }
      pool.query(
        "INSERT INTO user_votes (id, user_id) VALUES($1, $2)",
        [votedID, id],
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

// Update user
// For updating a user
app.post("/update/user", (req, res) => {
  const { id, first_name, middle_name, last_name, role_id } = req.body;

  // Update the candidates table
  const updateCandidatesQuery = `
    UPDATE candidates
    SET first_name = $1, middle_name = $2, last_name = $3
    WHERE user_id = $4;
  `;

  // Update the users table
  const updateUsersQuery = `
    UPDATE users
    SET first_name = $1, middle_name = $2, last_name = $3, role_id = $4
    WHERE id = $5;
  `;

  // Execute queries
  pool.query(
    updateCandidatesQuery,
    [first_name, middle_name, last_name, id],
    function (err) {
      if (err) {
        console.error("Error updating candidates:", err.message);
        return res.redirect("/voters?error=Error Updating Candidates");
      }

      pool.query(
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
  pool.query("DELETE FROM users WHERE id = $1", [id], function (err) {
    if (err) {
      console.error("Error deleting user:", err.message);
      return res.redirect("/admin/voters?error=Error Deleting User");
    }
    pool.query("DELETE FROM auth WHERE user_id = $1", [id], function (err) {
      if (err) {
        console.error("Error deleting user:", err.message);
        return res.redirect("/admin/voters?error=Error Deleting User");
      }

      pool.query("DELETE FROM candidates WHERE user_id = $1", [id], function (err) {
        if (err) {
          console.error("Error deleting user:", err.message);
          return res.redirect("/admin/voters?error=Error Deleting User");
        }

        pool.query("DELETE FROM user_votes WHERE user_id = $1", [id], function (err) {
          if (err) {
            console.error("Error deleting user:", err.message);
            return res.redirect("/admin/voters?error=Error Deleting User");
          }
        res.redirect("/admin/voters?success=User Deleted Successfully!");
      });
    });
  });
});
});

app.post("/admin/voted/user/:id", (req, res) => {
  const id = req.params.id;
  const votedID = uuidv4();
  pool.query(
    "UPDATE users SET has_voted = $1 WHERE id = $2",
    [1, id],
    function (err) {
      if (err) {
        console.error("Error updating user:", err.message);
        return res.redirect("/admin/voters?error=Error Marking User as Voted");
      }
      pool.query(
        "INSERT INTO user_votes (id, user_id) VALUES($1, $2)",
        [votedID,id],
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
    SET first_name = $1, middle_name = $2, last_name = $3
    WHERE user_id = $4;
  `;

  // Update the users table
  const updateUsersQuery = `
    UPDATE users
    SET first_name = $1, middle_name = $2, last_name = $3, role_id = $4
    WHERE id = $5;
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


app.get("/create/party", async (req, res) => {
  try {
    if (
      !req.session.userId ||
      (req.session.userRole !== "Super Admin" && req.session.userRole !== "Admin")
    ) {
      return res.redirect("/login");
    }

    // Check if the party data is already cached in Redis
    const cachedParties = await redis.get("parties");
    
    let parties;
    if (cachedParties) {
      // If data is in cache, parse and use it
      parties = JSON.parse(cachedParties);
    } else {
      // If data is not in cache, fetch from database
      const partiesResult = await pool.query(
        `SELECT parties.*, elections.election 
         FROM parties 
         JOIN elections ON parties.election_id = elections.id`
      );

      parties = partiesResult.rows.map((party) => {
        if (party.logo) {
          party.logo = party.logo.toString("base64");
        }
        return party;
      });

      // Cache the fetched data in Redis for 1 hour (3600 seconds)
      await redis.setex("parties", 3600, JSON.stringify(parties));
    }

    const profilePicture = req.session.profilePicture;

    // Fetch user role
    const userRoleResult = await pool.query(
      "SELECT users.role_id, roles.role FROM users JOIN roles ON users.role_id = roles.id WHERE users.id = $1",
      [req.session.userId]
    );
    const userRole = userRoleResult.rows[0];

    // Fetch username
    const userResult = await pool.query(
      "SELECT username FROM auth WHERE user_id = $1",
      [req.session.userId]
    );
    if (userResult.rows.length === 0) {
      return res.status(404).send("User not found");
    }
    const username = userResult.rows[0].username;

    // Fetch unread notifications count
    const unreadCountResult = await pool.query(
      "SELECT COUNT(*) AS unread_count FROM notifications WHERE username = $1 AND is_read = 0",
      [username]
    );
    const unreadCount = unreadCountResult.rows[0].unread_count;

    // Fetch user data
    const userDataResult = await pool.query(
      "SELECT * FROM users WHERE id = $1",
      [req.session.userId]
    );
    if (userDataResult.rows.length === 0) {
      return res.status(404).send("User not found in users table");
    }
    const user = userDataResult.rows[0];

    // Fetch parties for the admin's election
    const adminPartiesResult = await pool.query(
      "SELECT * FROM parties WHERE election_id = $1",
      [user.election_id]
    );
    const Adminparties = adminPartiesResult.rows.map((party) => {
      if (party.logo) {
        party.logo = party.logo.toString("base64");
      }
      return party;
    });

    // Fetch user election data
    const userElectionDataResult = await pool.query(
      `SELECT users.*, elections.election AS election_name 
       FROM users 
       JOIN elections ON users.election_id = elections.id 
       WHERE users.id = $1`,
      [req.session.userId]
    );
    const userElectionData = userElectionDataResult.rows[0];

    // Fetch all elections
    const electionsResult = await pool.query("SELECT * FROM elections");
    const elections = electionsResult.rows;

    // Render the page
    res.render("party-registration", {
      parties,
      role: userRole.role,
      profilePicture,
      unreadCount,
      user,
      userElectionData,
      elections,
      Adminparties,
    });
  } catch (err) {
    console.error("Error fetching data:", err);
    res.status(500).send("Internal server error");
  }
});





app.post("/create/party", upload.single("logo"), (req, res) => {
  const { election, party } = req.body;
  const logo = req.file ? req.file.buffer : null;

  const partyID = uuidv4();

  pool.query(
    "INSERT INTO parties (id, election_id, party, logo) VALUES ($1, $2, $3, $4)",
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
      SET party = $1, logo = $2 WHERE id = $3;
  `;

  pool.query(query, [party, logo, id], function (err) {
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
  pool.query("DELETE FROM parties WHERE id = $1", [id], function (err) {
    if (err) {
      console.error("Error deleting party:", err.message);
      return res.redirect("/create/party?error=Error deleting party");
    }
    res.redirect("/create/party?success=Party Deleted Successfully!");
  });
});


app.get("/add/position", async (req, res) => {
  try {
    if (
      !req.session.userId ||
      (req.session.userRole !== "Super Admin" && req.session.userRole !== "Admin")
    ) {
      return res.redirect("/login");
    }

    const profilePicture = req.session.profilePicture;

    // Cache prefix
    const cachePrefix = `positions:${req.session.userId}:`;

    // Check if positions and elections are cached
    const cachedPositions = await redis.get(cachePrefix + "positions");
    const cachedElections = await redis.get(cachePrefix + "elections");

    let positions, elections;
    
    if (cachedPositions && cachedElections) {
      // Parse cached data if available
      positions = JSON.parse(cachedPositions);
      elections = JSON.parse(cachedElections);
    } else {
      // Fetch positions and elections from the database if not cached
      const positionsResult = await pool.query(
        `SELECT positions.*, elections.election
         FROM positions 
         JOIN elections ON positions.election_id = elections.id`
      );
      positions = positionsResult.rows;

      const electionsResult = await pool.query("SELECT * FROM elections");
      elections = electionsResult.rows;

      // Store fetched data in Redis cache for 1 hour (3600 seconds)
      await redis.set(cachePrefix + "positions", JSON.stringify(positions), "EX", 3600);
      await redis.set(cachePrefix + "elections", JSON.stringify(elections), "EX", 3600);
    }

    // Fetch user role
    const userRoleResult = await pool.query(
      "SELECT roles.role FROM users JOIN roles ON users.role_id = roles.id WHERE users.id = $1",
      [req.session.userId]
    );
    if (userRoleResult.rows.length === 0) {
      return res.status(404).send("User role not found");
    }
    const userRole = userRoleResult.rows[0].role;

    // Fetch username
    const userResult = await pool.query(
      "SELECT username FROM auth WHERE user_id = $1",
      [req.session.userId]
    );
    if (userResult.rows.length === 0) {
      return res.status(404).send("User not found");
    }
    const username = userResult.rows[0].username;

    // Fetch unread notifications count
    const unreadCountResult = await pool.query(
      "SELECT COUNT(*) AS unreadCount FROM notifications WHERE username = $1 AND is_read = 0",
      [username]
    );
    const unreadCount = unreadCountResult.rows[0].unreadcount;

    // Fetch user data
    const userDataResult = await pool.query(
      "SELECT * FROM users WHERE id = $1",
      [req.session.userId]
    );
    if (userDataResult.rows.length === 0) {
      return res.status(404).send("User not found in users table");
    }
    const user = userDataResult.rows[0];

    // Fetch positions for the admin's election
    const adminPositionsResult = await pool.query(
      "SELECT * FROM positions WHERE election_id = $1",
      [user.election_id]
    );
    const Adminpositions = adminPositionsResult.rows;

    // Fetch user election data
    const userElectionDataResult = await pool.query(
      `SELECT users.*, elections.election AS election_name 
       FROM users 
       JOIN elections ON users.election_id = elections.id 
       WHERE users.id = $1`,
      [req.session.userId]
    );
    const userElectionData = userElectionDataResult.rows[0];

    // Render the page
    res.render("position.ejs", {
      positions,
      profilePicture,
      role: userRole,
      unreadCount,
      user,
      elections,
      userElectionData,
      Adminpositions,
    });
  } catch (err) {
    console.error("Error fetching data:", err);
    res.status(500).send("Internal server error");
  }
});



app.post("/add/position", async (req, res) => {
  try {
    const { election, Position, position_description, candidate_age_eligibility } = req.body;
    const positionID = uuidv4();

    await pool.query(
      "INSERT INTO positions (id, election_id, position, position_description, candidate_age_eligibility) VALUES ($1, $2, $3, $4, $5)",
      [positionID, election, Position, position_description, candidate_age_eligibility]
    );

    res.status(200).send(`${Position} Position created successfully`);
  } catch (err) {
    console.error("Error inserting position:", err);
    res.status(500).send("Internal server error");
  }
});


app.post("/update/position", async (req, res) => {
  try {
    const { id, position, candidate_age_eligibilities } = req.body;

    const result = await pool.query(
      "UPDATE positions SET position = $1, candidate_age_eligibility = $2 WHERE id = $3",
      [position, candidate_age_eligibilities, id]
    );

    if (result.rowCount === 0) {
      return res.redirect("/add/position?error=Position not found");
    }

    res.redirect("/add/position?success=Position updated successfully!");
  } catch (err) {
    console.error("Error updating position:", err);
    res.redirect("/add/position?error=Error updating position");
  }
});


app.post("/delete/position/:id", async (req, res) => {
  try {
    const id = req.params.id;

    const result = await pool.query("DELETE FROM positions WHERE id = $1", [id]);

    if (result.rowCount === 0) {
      return res.redirect("/add/position?error=Position not found");
    }

    res.redirect("/add/position?success=Position deleted successfully!");
  } catch (err) {
    console.error("Error deleting position:", err);
    res.redirect("/add/position?error=Error deleting position");
  }
});


//======================== CANDIDATE REGISTRATION ROUTES =============================


app.get("/candidate/registration", async (req, res) => {
  try {
    if (
      !req.session.userId ||
      (req.session.userRole !== "Super Admin" && req.session.userRole !== "Admin")
    ) {
      return res.redirect("/login");
    }

    // Check Redis cache for parties
    let parties = await redis.get("parties");
    if (!parties) {
      // If not in cache, fetch from database and store in cache
      const { rows } = await pool.query("SELECT * FROM parties");
      parties = rows;
      await redis.set("parties", JSON.stringify(parties), "EX", 3600); // Cache for 1 hour
    } else {
      parties = JSON.parse(parties);
    }

    // Check Redis cache for roles
    let roles = await redis.get("roles");
    if (!roles) {
      // If not in cache, fetch from database and store in cache
      const { rows } = await pool.query("SELECT * FROM roles LIMIT 1 OFFSET 1");
      if (rows.length === 0) {
        return res.status(404).send("Second role not found");
      }
      roles = rows[0];
      await redis.set("roles", JSON.stringify(roles), "EX", 3600); // Cache for 1 hour
    } else {
      roles = JSON.parse(roles);
    }
    const secondRole = roles;

    // Fetch positions from database as Redis caching may not apply here
    const { rows: positions } = await pool.query("SELECT * FROM positions");

    // Fetch user role
    const { rows: userRoleData } = await pool.query(
      "SELECT users.role_id, roles.role FROM users JOIN roles ON users.role_id = roles.id WHERE users.id = $1",
      [req.session.userId]
    );
    const userRole = userRoleData[0];

    // Fetch username
    const { rows: userData } = await pool.query(
      "SELECT username FROM auth WHERE user_id = $1",
      [req.session.userId]
    );
    if (userData.length === 0) {
      return res.status(404).send("User not found");
    }
    const user = userData[0];

    // Fetch unread notifications count from Redis cache
    let unreadCount = await redis.get(`unreadCount:${user.username}`);
    if (!unreadCount) {
      const { rows: unreadNotifications } = await pool.query(
        "SELECT COUNT(*) AS unreadCount FROM notifications WHERE username = $1 AND is_read = 0",
        [user.username]
      );
      unreadCount = unreadNotifications[0].unreadcount;
      await redis.set(`unreadCount:${user.username}`, unreadCount, "EX", 3600); // Cache for 1 hour
    } else {
      unreadCount = parseInt(unreadCount, 10);
    }

    // Fetch candidates
    let candidates = await redis.get("candidates");
    if (!candidates) {
      // If not in cache, fetch from database and store in cache
      const { rows } = await pool.query(`
        SELECT candidates.*, parties.party, parties.logo, positions.position, votes.vote AS vote, elections.election AS candidate_election
        FROM candidates
        JOIN parties ON candidates.party_id = parties.id 
        JOIN positions ON candidates.position_id = positions.id
        LEFT JOIN votes ON candidates.id = votes.candidate_id
        JOIN elections ON candidates.election_id = elections.id
        ORDER BY candidates.id DESC
      `);
      candidates = rows.map(candidate => ({
        ...candidate,
        photo: candidate.photo ? candidate.photo.toString("base64") : null,
        logo: candidate.logo ? candidate.logo.toString("base64") : null,
      }));
      await redis.set("candidates", JSON.stringify(candidates), "EX", 3600); // Cache for 1 hour
    } else {
      candidates = JSON.parse(candidates);
    }

    // Fetch user details from users table
    const { rows: userTableData } = await pool.query(
      "SELECT * FROM users WHERE id = $1",
      [req.session.userId]
    );
    const userTable = userTableData[0];

    // Fetch parties and positions for Admin based on election_id
    let Adminparties = await redis.get(`Adminparties:${userTable.election_id}`);
    if (!Adminparties) {
      const { rows: partiesData } = await pool.query(
        "SELECT * FROM parties WHERE election_id = $1",
        [userTable.election_id]
      );
      Adminparties = partiesData;
      await redis.set(`Adminparties:${userTable.election_id}`, JSON.stringify(Adminparties), "EX", 3600); // Cache for 1 hour
    } else {
      Adminparties = JSON.parse(Adminparties);
    }

    let Adminpositions = await redis.get(`Adminpositions:${userTable.election_id}`);
    if (!Adminpositions) {
      const { rows: positionsData } = await pool.query(
        "SELECT * FROM positions WHERE election_id = $1",
        [userTable.election_id]
      );
      Adminpositions = positionsData;
      await redis.set(`Adminpositions:${userTable.election_id}`, JSON.stringify(Adminpositions), "EX", 3600); // Cache for 1 hour
    } else {
      Adminpositions = JSON.parse(Adminpositions);
    }

    // Fetch all elections
    const { rows: elections } = await pool.query("SELECT * FROM elections");

    // Fetch user's election name
    const { rows: userElectionData } = await pool.query(
      `SELECT users.*, elections.election AS election_name 
      FROM users 
      JOIN elections ON users.election_id = elections.id 
      WHERE users.id = $1`,
      [req.session.userId]
    );

    // Fetch Admin candidates for specific election
    let Admincandidates = await redis.get(`Admincandidates:${userTable.election_id}`);
    if (!Admincandidates) {
      const { rows } = await pool.query(
        `SELECT candidates.*, parties.party, parties.logo, positions.position, votes.vote AS vote, elections.election AS candidate_election
        FROM candidates
        JOIN parties ON candidates.party_id = parties.id 
        JOIN positions ON candidates.position_id = positions.id
        LEFT JOIN votes ON candidates.id = votes.candidate_id
        JOIN elections ON candidates.election_id = elections.id
        WHERE candidates.election_id = $1
        ORDER BY candidates.id DESC`,
        [userTable.election_id]
      );
      Admincandidates = rows.map(candidate => ({
        ...candidate,
        photo: candidate.photo ? candidate.photo.toString("base64") : null,
        logo: candidate.logo ? candidate.logo.toString("base64") : null,
      }));
      await redis.set(`Admincandidates:${userTable.election_id}`, JSON.stringify(Admincandidates), "EX", 3600); // Cache for 1 hour
    } else {
      Admincandidates = JSON.parse(Admincandidates);
    }

    res.render("candidate-registration", {
      parties,
      positions,
      profilePicture: req.session.profilePicture,
      role: userRole.role,
      unreadCount,
      candidates,
      user,
      elections,
      userElectionData: userElectionData[0],
      Adminparties,
      Adminpositions,
      Admincandidates,
      secondRole,
    });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).send("Server error");
  }
});



// UPDATE Candidate
app.post("/update/candidate", async (req, res) => {
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

  try {
    // Update candidate details
    await pool.query(
      `UPDATE candidates
       SET first_name = $1, middle_name = $2, last_name = $3, position_id = $4, party_id = $5, election_id = $6
       WHERE id = $7`,
      [first_name, middle_name, last_name, position, party, election, id]
    );

    // Update user details
    await pool.query(
      `UPDATE users
       SET first_name = $1, middle_name = $2, last_name = $3
       WHERE id = $4`,
      [first_name, middle_name, last_name, user_id]
    );

    res.redirect("/candidate/registration?success=Candidate record updated successfully!");
  } catch (err) {
    console.error("Error updating candidate:", err.message);
    res.redirect("/candidate/registration?error=Error updating candidate record");
  }
});

// DELETE Candidate
app.post("/delete/candidate/:id", async (req, res) => {
  const { candidateUserID } = req.body;
  const id = req.params.id;

  try {
    // Start transaction
    await pool.query("BEGIN");

    // Delete from candidates
    await pool.query("DELETE FROM candidates WHERE id = $1", [id]);

    // Delete from users
    await pool.query("DELETE FROM users WHERE id = $1", [candidateUserID]);

    // Delete from auth
    await pool.query("DELETE FROM auth WHERE user_id = $1", [candidateUserID]);

    // Delete from votes
    await pool.query("DELETE FROM votes WHERE candidate_id = $1", [id]);

    // Commit transaction
    await pool.query("COMMIT");

    res.redirect("/candidate/registration?success=Candidate record deleted successfully!");
  } catch (err) {
    await pool.query("ROLLBACK"); // Rollback transaction in case of an error
    console.error("Error deleting candidate:", err.message);
    res.redirect("/candidate/registration?error=Error deleting candidate record");
  }
});




app.post("/candidate/registration", upload.single("photo"), async (req, res) => {
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

  try {
    // Fetch voter age eligibility from positions table
    const positionResult = await pool.query(
      `SELECT candidate_age_eligibility FROM positions WHERE election_id = $1 AND id = $2`,
      [election, position]
    );

    if (positionResult.rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Candidate eligibility not found",
      });
    }

    const candidateAgeEligibility = positionResult.rows[0].candidate_age_eligibility;

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

    // Check if username already exists
    const existingUser = await pool.query(
      `SELECT 1 FROM auth WHERE username = $1 AND election_id = $2`,
      [username, election]
    );

    if (existingUser.rows.length > 0) {
      return res.status(400).json({
        success: false,
        message: `The username '${username}' is already taken. Please choose a different username.`,
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    // Fetch election name
    const electionResult = await pool.query(
      "SELECT election FROM elections WHERE id = $1",
      [election]
    );

    const electionName = electionResult.rows.length > 0 ? electionResult.rows[0].election : "the election";

    // Start transaction
    await pool.query("BEGIN");

    // Insert into users table
    await pool.query(
      `INSERT INTO users (id, first_name, middle_name, last_name, DOB, profile_picture, role_id, election_id) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [userID, firstname, middlename, lastname, DOB, photo, role, election]
    );

    // Insert into auth table
    await pool.query(
      `INSERT INTO auth (id, username, password, user_id, election_id) 
       VALUES ($1, $2, $3, $4, $5)`,
      [authID, username, hashedPassword, userID, election]
    );

    // Insert into candidates table
    await pool.query(
      `INSERT INTO candidates (id, first_name, middle_name, last_name, party_id, position_id, photo, election_id, user_id) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [candidateID, firstname, middlename, lastname, party, position, photo, election, userID]
    );

    // Send notification
    const currentTime = new Date();
    const notificationMessage = `Hi ${firstname} ${middlename} ${lastname} (${username}), congratulations on successfully registering for ${electionName} using our online election voting system! Your vote is powerful and can shape the future. Stay tuned for any important updates regarding the election process.`;
    const notificationTitle = "Registration Successful";

    await pool.query(
      `INSERT INTO notifications (id, username, election, message, title, created_at) 
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [uuidv4(), username, election, notificationMessage, notificationTitle, currentTime]
    );

    io.to(username).emit("new-notification", {
      message: notificationMessage,
      title: notificationTitle,
      created_at: currentTime,
    });

    // Commit transaction
    await pool.query("COMMIT");

    res.status(200).json({
      success: true,
      message: `Candidate, ${firstname} ${middlename} ${lastname} has been registered.`,
    });
  } catch (err) {
    await pool.query("ROLLBACK"); // Rollback transaction in case of an error
    console.error("Error registering candidate:", err.message);
    res.status(500).json({
      success: false,
      message: "There was a problem registering the candidate. Please try again later.",
    });
  }
});


app.get("/my/profile", (req, res) => {
  if (!req.session.userId) {
    return res.redirect("/login");
  }

  // Try to fetch the profile data from Redis cache first
  redis.get(`user_profile_${req.session.userId}`, (err, cachedData) => {
    if (cachedData) {
      // If cached data exists, parse it and send the response
      const cachedUser = JSON.parse(cachedData);
      const voteStatus = cachedUser.has_voted ? "Voted" : "Not Voted";

      res.render("profile", {
        user: cachedUser,
        voteStatus,
        unreadCount: cachedUser.unreadCount,
        profilePicture: cachedUser.profile_picture,
        formattedDOB: cachedUser.formattedDOB,
      });
    } else {
      // If no cached data, fetch from database
      const sql = `
        SELECT users.*, roles.role, auth.username
        FROM users
        JOIN roles ON users.role_id = roles.id
        JOIN auth ON users.id = auth.user_id
        WHERE users.id = $1
      `;

      pool.query(sql, [req.session.userId], (err, result) => {
        if (err) {
          return res.status(500).send("An error occurred");
        }
        if (result.rows.length === 0) {
          return res.status(404).send("User not found");
        }

        const user = result.rows[0];
        console.log('profile user data', user);

        const DOB = new Date(user.dob);
        const formattedDOB = DOB.toISOString().split('T')[0];

        console.log("Profile new dob", formattedDOB);

        user.profile_picture = user.profile_picture.toString("base64");

        // Check if the user has voted
        const voteStatus = user.has_voted ? "Voted" : "Not Voted";

        // Fetch unread notifications count
        pool.query(
          "SELECT COUNT(*) AS unreadCount FROM notifications WHERE username = $1 AND is_read = 0",
          [user.username],
          (err, countResult) => {
            if (err) {
              return res
                .status(500)
                .send("Error fetching unread notifications count");
            }

            // Prepare the data for caching
            const userProfileData = {
              ...user,
              formattedDOB,
              unreadCount: countResult.rows[0].unreadCount,
            };

            // Cache the data in Redis for future use
            redis.setex(
              `user_profile_${req.session.userId}`,
              3600, // Cache expiration time (1 hour)
              JSON.stringify(userProfileData)
            );

            const profilePicture = req.session.profilePicture;

            res.render("profile", {
              user: userProfileData,
              voteStatus,
              unreadCount: countResult.rows[0].unreadCount,
              profilePicture,
              formattedDOB
            });
          }
        );
      });
    }
  });
});



app.get("/vote", async (req, res) => {
  if (!req.session.userId) {
    return res.redirect("/login");
  }

  try {
    // Check Redis Cache First
    const cachedData = await redis.get(`vote_page_${req.session.userId}`);
    if (cachedData) {
      const cachedResponse = JSON.parse(cachedData);

      // If unreadCount is missing, fetch it and update cache
      if (typeof cachedResponse.unreadCount === 'undefined') {
        const unreadResult = await pool.query(
          `SELECT COUNT(*) AS unreadCount FROM notifications WHERE username = $1 AND is_read = 0`,
          [req.session.username]
        );
        cachedResponse.unreadCount = unreadResult.rows[0].unreadcount;

        // Update Redis with the new unreadCount
        await redis.setex(`vote_page_${req.session.userId}`, 3600, JSON.stringify(cachedResponse));

        return res.render("vote", cachedResponse);
      }
      
      return res.render("vote", cachedResponse);
    }

    // If no cache, fetch data from database
    const userQuery = await pool.query(
      `SELECT users.id, users.election_id, users.role_id, roles.role, auth.username
       FROM users 
       JOIN roles ON users.role_id = roles.id
       JOIN auth ON users.id = auth.user_id
       WHERE users.id = $1`,
      [req.session.userId]
    );

    if (!userQuery.rows.length) {
      return res.status(404).send("User not found");
    }

    const user = userQuery.rows[0];
    const { election_id, role, username } = user;

    // Fetch candidates and group by position
    const candidatesQuery = await pool.query(
      `SELECT candidates.id, candidates.first_name, candidates.last_name, candidates.middle_name, candidates.photo, 
              positions.position, parties.party, COALESCE(votes.vote, 0) AS vote
       FROM candidates
       JOIN positions ON candidates.position_id = positions.id
       JOIN parties ON candidates.party_id = parties.id
       LEFT JOIN votes ON candidates.id = votes.candidate_id
       WHERE candidates.election_id = $1`,
      [election_id]
    );

    const groupedCandidates = candidatesQuery.rows.reduce((acc, candidate) => {
      if (!acc[candidate.position]) acc[candidate.position] = [];
      acc[candidate.position].push({
        ...candidate,
        photo: candidate.photo.toString("base64"),
      });
      return acc;
    }, {});

    // Get unread notifications count
    const unreadQuery = await pool.query(
      `SELECT COUNT(*) AS unreadCount FROM notifications WHERE username = $1 AND is_read = 0`,
      [username]
    );
    const unreadCount = unreadQuery.rows[0].unreadcount;

    // Fetch election timing
    const electionTimingQuery = await pool.query(
      `SELECT start_time, end_time FROM election_settings WHERE election_id = $1`,
      [election_id]
    );

    if (!electionTimingQuery.rows.length) {
      return res.status(404).send("Election timing not found");
    }

    const { start_time, end_time } = electionTimingQuery.rows[0];
    const start = new Date(start_time);
    const end = new Date(end_time);
    const current = new Date();

    // Prepare Data for Rendering
    const votePageData = {
      candidates: candidatesQuery.rows,
      role,
      profilePicture: req.session.profilePicture,
      unreadCount,
      user,
      groupedCandidates,
      userElectionID: election_id,
      start,
      end,
      current,
    };

    // Cache Data in Redis
    await redis.setex(`vote_page_${req.session.userId}`, 3600, JSON.stringify(votePageData));

    // Render Page
    res.render("vote", votePageData);
  } catch (err) {
    console.error("Error in /vote route:", err);
    res.status(500).send("Internal Server Error");
  }
});





app.post("/vote", upload.none(), async (req, res) => {
  const { electionID } = req.body;
  const userId = req.session.userId;
  const positions = Object.keys(req.body);
  const userVotesID = uuidv4();
  try {
    const client = await pool.connect(); // Get a client connection
    await client.query("BEGIN"); // Start a transaction

    // Check if user has already voted
    const userVote = await client.query(
      "SELECT * FROM user_votes WHERE user_id = $1",
      [userId]
    );

    if (userVote.rows.length > 0) {
      await client.release();
      return res.status(403).json({
        success: false,
        message: "Sorry! You have already voted.",
      });
    }

    // Handle votes
    for (const position of positions) {
      const candidateId = req.body[position];
      if (!candidateId) continue;

      const voteResult = await client.query(
        "SELECT * FROM votes WHERE candidate_id = $1",
        [candidateId]
      );

      if (voteResult.rows.length > 0) {
        await client.query(
          "UPDATE votes SET vote = vote + 1 WHERE candidate_id = $1",
          [candidateId]
        );
      } else {
        await client.query(
          "INSERT INTO votes (candidate_id, vote) VALUES ($1, 1)",
          [candidateId]
        );
      }
    }

    // Record that the user has voted
    await client.query("INSERT INTO user_votes (id, user_id) VALUES ($1, $2)", [
      userVotesID,userId,
    ]);

    // Update user vote status
    await client.query("UPDATE users SET has_voted = 1 WHERE id = $1", [
      userId,
    ]);

    // Fetch the voter's username
    const userResult = await client.query(
      "SELECT username FROM auth WHERE user_id = $1",
      [userId]
    );

    if (userResult.rows.length === 0) {
      await client.release();
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const username = userResult.rows[0].username;
    const currentTime = new Date();
    const notificationMessage = `Thank you ${username}, for casting your vote. It has been successfully counted.`;
    const notificationTitle = "Vote Counted";

    // Insert a notification
    await client.query(
      `INSERT INTO notifications (id,username, election, message, title, created_at) 
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userVotesID, username, electionID, notificationMessage, notificationTitle, currentTime]
    );

    await client.query("COMMIT"); // Commit transaction
    await client.release(); // Release connection

    // Emit notification
    io.to(username).emit("new-notification", {
      message: notificationMessage,
      title: notificationTitle,
      created_at: currentTime,
    });

    return res.status(200).json({
      success: true,
      message: "Your vote has been counted",
    });
  } catch (err) {
    console.error("Error processing votes:", err);
    await pool.query("ROLLBACK"); // Rollback transaction on error
    return res.status(500).json({
      success: false,
      message: "Error processing votes",
    });
  }
});


app.get("/forget-password", (req, res) => {
  if (
    !req.session.userId ||
    (req.session.userRole !== "Super Admin")
  ) {
    return res.redirect("/login");
  }
  res.render("forget-password");
});

app.post("/forget-password", (req, res) => {
  const { username, password, passwordConfirm } = req.body;

  if (password !== passwordConfirm) {
    return res.status(400).json({ success: false, message: "Passwords do not match" });
  }

  pool.query("SELECT * FROM auth WHERE username = $1", [username], (err, result) => {
    if (err) {
      return res.status(500).json({ success: false, message: "An error occurred" });
    }

    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: "Username does not exist" });
    }

    bcrypt.hash(password, 10, (err, hash) => {
      if (err) {
        return res.status(500).json({ success: false, message: "An error occurred" });
      }

      pool.query("UPDATE auth SET password = $1 WHERE username = $2", [hash, username], (err) => {
        if (err) {
          return res.status(500).json({ success: false, message: "An error occurred" });
        }

        return res.status(200).json({ success: true, message: "Password Updated Successfully" });
      });
    });
  });
});


// VOTER SETTING PAGE ROUTE
app.get("/voter/setting", (req, res) => {
  if (!req.session.userId) {
    return res.redirect("/login");
  }

  // Check Redis cache for user data and unread notifications count
  redis.get(`user:${req.session.userId}`, (err, cachedUserData) => {
    if (cachedUserData) {
      const user = JSON.parse(cachedUserData);

      redis.get(`unreadCount:${user.username}`, (err, cachedUnreadCount) => {
        if (cachedUnreadCount) {
          const unreadCount = parseInt(cachedUnreadCount);
          const profilePicture = req.session.profilePicture;

          return res.render("voter-setting", {
            unreadCount,
            profilePicture,
            user,
          });
        }
      });
    } else {
      const sql = `
        SELECT users.*, roles.role, auth.username
        FROM users
        JOIN roles ON users.role_id = roles.id
        JOIN auth ON users.id = auth.user_id
        WHERE users.id = $1
      `;

      pool.query(sql, [req.session.userId], (err, result) => {
        if (err) {
          return res.status(500).send("An error occurred");
        }

        if (!result.rows.length) {
          return res.status(404).send("User not found");
        }

        const user = result.rows[0];

        // Cache user data in Redis
        redis.setex(`user:${user.id}`, 3600, JSON.stringify(user));

        pool.query(
          "SELECT COUNT(*) AS unreadCount FROM notifications WHERE username = $1 AND is_read = 0",
          [user.username],
          (err, countResult) => {
            if (err) {
              return res.status(500).send("Error fetching unread notifications count");
            }

            const unreadCount = parseInt(countResult.rows[0].unreadcount);

            // Cache unread notification count in Redis
            redis.setex(`unreadCount:${user.username}`, 3600, unreadCount);

            const profilePicture = req.session.profilePicture;

            res.render("voter-setting", {
              unreadCount,
              profilePicture,
              user,
            });
          }
        );
      });
    }
  });
});



// POST ROUTE FOR UPDATING THE USER PASSWORD FROM THE SEETING PAGE
app.post("/setting/forget-password", (req, res) => {
  const { username, password, passwordConfirm } = req.body;

  if (password !== passwordConfirm) {
    return res.status(400).json({ success: false, message: "Passwords do not match" });
  }

  pool.query("SELECT * FROM auth WHERE username = $1 AND user_id = $2", [username, req.session.userId], (err, result) => {
    if (err) {
      return res.status(500).send("An error occurred");
    }

    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: "Invalid username." });
    }

    const user = result.rows[0];

    if (user.username !== username) {
      return res.status(403).json({ success: false, message: "You are not authorized to change this password" });
    }

    bcrypt.hash(password, 10, (err, hash) => {
      if (err) {
        return res.status(500).json({ success: false, message: "An error occurred" });
      }

      pool.query(
        "UPDATE auth SET password = $1 WHERE username = $2 AND user_id = $3",
        [hash, username, req.session.userId],
        (err) => {
          if (err) {
            return res.status(500).json({ success: false, message: "An error occurred" });
          }

          res.status(200).json({ success: true, message: "Password updated successfully" });
        }
      );
    });
  });
});


// ROUTE FOR UPDATING THE USERNAME
app.post("/setting/change/username", upload.none(), (req, res) => {
  const { username, Newusername, password } = req.body;

  pool.query("SELECT * FROM auth WHERE user_id = $1", [req.session.userId], (err, result) => {
    if (err) {
      return res.status(500).json({ success: false, message: "Internal server error" });
    }

    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: "User does not exist" });
    }

    const user = result.rows[0];

    if (user.username !== username) {
      return res.status(403).json({ success: false, message: "You are not authorized to change this username" });
    }

    bcrypt.compare(password, user.password, (err, match) => {
      if (!match) {
        return res.status(400).json({ success: false, message: "Incorrect password" });
      }

      pool.query(
        "UPDATE auth SET username = $1 WHERE username = $2 AND user_id = $3",
        [Newusername, username, req.session.userId],
        (err) => {
          if (err) {
            return res.status(500).json({ success: false, message: "Internal server error" });
          }

          res.status(200).json({ success: true, message: "Username updated successfully!" });
        }
      );
    });
  });
});


//========================== ELECTION BEGINS ==========================================

//============================ ELECTION GET ROUTE =================================
app.get("/create/election", (req, res) => {
  if (!req.session.userId || req.session.userRole !== "Super Admin") {
    return res.redirect("/login");
  }

  const profilePicture = req.session.profilePicture;

  // Check Redis for user role cache
  redis.get(`userRole:${req.session.userId}`, (err, cachedUserRole) => {
    if (cachedUserRole) {
      const userRole = JSON.parse(cachedUserRole);

      // Check Redis for elections data cache
      redis.get("electionsData", (err, cachedElections) => {
        if (cachedElections) {
          const elections = JSON.parse(cachedElections);

          // Check Redis for unread notifications count cache
          redis.get(`unreadCount:${req.session.userId}`, (err, cachedUnreadCount) => {
            if (cachedUnreadCount) {
              const unreadCount = parseInt(cachedUnreadCount);

              // Check Redis for user data cache
              redis.get(`userData:${req.session.userId}`, (err, cachedUserData) => {
                if (cachedUserData) {
                  const userData = JSON.parse(cachedUserData);
                  return res.render("election", {
                    profilePicture,
                    role: userRole.role,
                    elections,
                    user: userData,
                    unreadCount,
                  });
                } else {
                  // Fetch user data if not in cache
                  pool.query(
                    `SELECT * FROM users WHERE id = $1`,
                    [req.session.userId],
                    (err, userDataResult) => {
                      if (err) {
                        return res.status(500).send("Error fetching user data");
                      }

                      if (!userDataResult.rows.length) {
                        return res.status(404).send("User data not found");
                      }

                      const userData = userDataResult.rows[0];
                      // Cache the user data in Redis for future requests
                      redis.setex(`userData:${req.session.userId}`, 3600, JSON.stringify(userData));

                      res.render("election", {
                        profilePicture,
                        role: userRole.role,
                        elections,
                        user: userData,
                        unreadCount,
                      });
                    }
                  );
                }
              });
            } else {
              // Fetch unread notifications count from database if not cached
              pool.query(
                `SELECT COUNT(*) AS unreadCount 
                 FROM notifications 
                 WHERE username = $1 AND is_read = 0`,
                [req.session.username],
                (err, countResult) => {
                  if (err) {
                    return res
                      .status(500)
                      .send("Error fetching unread notifications count");
                  }

                  const unreadCount = parseInt(countResult.rows[0].unreadcount);

                  // Cache the unread notifications count in Redis
                  redis.setex(`unreadCount:${req.session.userId}`, 3600, unreadCount);

                  res.render("election", {
                    profilePicture,
                    role: userRole.role,
                    elections,
                    user: userDataResult.rows[0],
                    unreadCount,
                  });
                }
              );
            }
          });
        } else {
          // Fetch elections data if not cached
          pool.query(
            `SELECT elections.*, election_settings.*
             FROM elections
             JOIN election_settings ON elections.id = election_settings.election_id`,
            [],
            (err, electionsResult) => {
              if (err) {
                return res.status(500).send("Error fetching elections");
              }

              const elections = electionsResult.rows;
              // Cache the elections data in Redis
              redis.setex("electionsData", 3600, JSON.stringify(elections));

              // Check Redis for unread notifications count cache
              redis.get(`unreadCount:${req.session.userId}`, (err, cachedUnreadCount) => {
                if (cachedUnreadCount) {
                  const unreadCount = parseInt(cachedUnreadCount);

                  pool.query(
                    `SELECT * FROM users WHERE id = $1`,
                    [req.session.userId],
                    (err, userDataResult) => {
                      if (err) {
                        return res.status(500).send("Error fetching user data");
                      }

                      if (!userDataResult.rows.length) {
                        return res.status(404).send("User data not found");
                      }

                      res.render("election", {
                        profilePicture,
                        role: userRole.role,
                        elections,
                        user: userDataResult.rows[0],
                        unreadCount,
                      });
                    }
                  );
                }
              });
            }
          );
        }
      });
    } else {
      // Fetch user role from database if not cached
      pool.query(
        `SELECT users.role_id, roles.role 
         FROM users
         JOIN roles ON users.role_id = roles.id 
         WHERE users.id = $1`,
        [req.session.userId],
        (err, userRoleResult) => {
          if (err) {
            return res.status(500).send("Error fetching user role");
          }

          // Cache the user role in Redis
          redis.setex(`userRole:${req.session.userId}`, 3600, JSON.stringify(userRoleResult.rows[0]));

          // Continue with the remaining logic
          pool.query(
            `SELECT elections.*, election_settings.*
             FROM elections
             JOIN election_settings ON elections.id = election_settings.election_id`,
            [],
            (err, electionsResult) => {
              if (err) {
                return res.status(500).send("Error fetching elections");
              }

              pool.query(
                `SELECT username FROM auth WHERE user_id = $1`,
                [req.session.userId],
                (err, userResult) => {
                  if (err) {
                    return res.status(500).send("Error fetching user");
                  }

                  if (!userResult.rows.length) {
                    return res.status(404).send("User not found");
                  }

                  const elections = electionsResult.rows;
                  const username = userResult.rows[0].username;

                  // Fetch unread notifications count
                  pool.query(
                    `SELECT COUNT(*) AS unreadCount 
                     FROM notifications 
                     WHERE username = $1 AND is_read = 0`,
                    [username],
                    (err, countResult) => {
                      if (err) {
                        return res
                          .status(500)
                          .send("Error fetching unread notifications count");
                      }

                      pool.query(
                        `SELECT * FROM users WHERE id = $1`,
                        [req.session.userId],
                        (err, userDataResult) => {
                          if (err) {
                            return res
                              .status(500)
                              .send("Error fetching user from the users table");
                          }

                          if (!userDataResult.rows.length) {
                            return res.status(404).send("User data not found");
                          }

                          res.render("election", {
                            profilePicture,
                            role: userRoleResult.rows[0].role,
                            elections,
                            user: userDataResult.rows[0],
                            unreadCount: countResult.rows[0].unreadcount,
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
  });
});



//============================== ELECTION POST ROUTE ===============================

app.post("/create/election", async (req, res) => {


  const {
    election,
    start_time,
    end_time,
    voter_age_eligibility,
    registration_start_time,
    registration_end_time,
  } = req.body;

  console.log(req.body);

  const electionID = uuidv4();

  try {
    // Begin transaction
    await pool.query('BEGIN');
    
    // Insert into elections table
    const insertElectionQuery = `
      INSERT INTO elections (id, election, voter_age_eligibility)
      VALUES ($1, $2, $3)
    `;
    await pool.query(insertElectionQuery, [
      electionID,
      election,
      voter_age_eligibility
    ]);

    // Insert into election_settings table
    const insertElectionSettingsQuery = `
      INSERT INTO election_settings (id, start_time, end_time, registration_start_time, registration_end_time, election_id)
      VALUES ($1, $2, $3, $4, $5, $6)
    `;
    await pool.query(insertElectionSettingsQuery, [
      uuidv4(),
      start_time,
      end_time,
      registration_start_time,
      registration_end_time,
      electionID
    ]);

    // Commit the transaction
    await pool.query('COMMIT');

    // Send success response
    res.status(200).json({
      success: true,
      message: `${election}, successfully created`,
    });

  } catch (err) {
    // In case of error, rollback the transaction
    await pool.query('ROLLBACK');

    console.log("Error: ", err);
    res.status(500).json({
      success: false,
      message: "An error occurred while creating the election or its settings",
    });
  }
});


app.post("/update/election", upload.none(), (req, res) => {
  const {
    id,
    election,
    startTime,
    endTime,
    voter_age_eligibilities,
    RegistrationStartTime,
    RegistrationEndTime,
  } = req.body;

  console.log(req.body);

  pool.query(
    "UPDATE elections SET election = $1, voter_age_eligibility = $2 WHERE id = $3",
    [election, voter_age_eligibilities, id],
    function (err) {
      if (err) {
        console.error(err.message);
        return res.status(500).send("Error updating election");
      }

      pool.query(
        "UPDATE election_settings SET start_time = $1, end_time = $2, registration_start_time = $3, registration_end_time = $4 WHERE election_id = $5",
        [startTime, endTime, RegistrationStartTime, RegistrationEndTime, id],
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

  pool.query(`DELETE FROM elections WHERE id = $1`, [id], function (err) {
    if (err) {
      console.error("Error deleting election:", err.message);
      return res.send("Error Deleting Election");
    }

    pool.query(
      `DELETE FROM election_settings WHERE election_id = $1`,
      [id],
      function (err) {
        if (err) {
          console.error("Error deleting election settings:", err.message);
          return res.send("Error Deleting Election");
        }

        res.redirect("/create/election");
      }
    );
  });
});


app.get("/vote/analysis", (req, res) => {
  if (!req.session.userId) {
    return res.redirect("/login");
  }

  // Redis caching for current user data
  redis.get(`user:${req.session.userId}:data`, (err, cachedUserData) => {
    if (err) {
      console.error("Error fetching user data from Redis:", err);
    }

    if (cachedUserData) {
      console.log("User data retrieved from Redis.");
      const currentUser = JSON.parse(cachedUserData);
      fetchCandidatesData(currentUser);
    } else {
      pool.query(
        "SELECT * FROM users WHERE id = $1",
        [req.session.userId],
        (err, currentUserResult) => {
          if (err) {
            console.error("Error fetching current user data:", err);
            return res.status(500).send("Error fetching current user data");
          }

          if (!currentUserResult.rows.length) {
            return res.status(404).send("User not found");
          }

          const currentUser = currentUserResult.rows[0];

          // Cache the user data in Redis for faster access next time
          redis.setex(
            `user:${req.session.userId}:data`, 
            3600,  // Cache for 1 hour
            JSON.stringify(currentUser)
          );
          fetchCandidatesData(currentUser);
        }
      );
    }

    function fetchCandidatesData(currentUser) {
      const positionsQuery = `
        SELECT positions.position, candidates.first_name, candidates.middle_name, 
               candidates.last_name, COALESCE(SUM(votes.vote), 0) AS vote
        FROM candidates
        JOIN positions ON candidates.position_id = positions.id
        LEFT JOIN votes ON candidates.id = votes.candidate_id
        WHERE candidates.election_id = $1
        GROUP BY positions.position, candidates.id
        ORDER BY positions.position, candidates.last_name
      `;

      pool.query(positionsQuery, [currentUser.election_id], (err, candidatesResult) => {
        if (err) {
          console.error("Error fetching candidates data:", err);
          return res.status(500).send("Error fetching candidates data");
        }

        const groupedData = {};

        candidatesResult.rows.forEach((candidate) => {
          const position = candidate.position.trim().replace(/\s+/g, ' ');
          const candidateName = `${candidate.first_name} ${candidate.middle_name || ""} ${candidate.last_name}`.trim();

          if (!groupedData[position]) {
            groupedData[position] = { labels: [], votes: [] };
          }

          groupedData[position].labels.push(candidateName);
          groupedData[position].votes.push(candidate.vote);
        });

        // Emit real-time updates with socket.io
        io.emit('voteUpdate', { groupedData });

        pool.query(
          "SELECT users.role_id, roles.role FROM users JOIN roles ON users.role_id = roles.id WHERE users.id = $1",
          [req.session.userId],
          (err, userRoleResult) => {
            if (err) {
              return res.status(500).send("Error fetching user role");
            }

            pool.query(
              "SELECT username FROM auth WHERE user_id = $1",
              [req.session.userId],
              (err, userResult) => {
                if (err) {
                  return res.status(500).send("Error fetching user");
                }

                if (!userResult.rows.length) {
                  return res.status(404).send("User not found");
                }

                const username = userResult.rows[0].username;

                pool.query(
                  "SELECT COUNT(*) AS unreadCount FROM notifications WHERE username = $1 AND is_read = 0",
                  [username],
                  (err, countResult) => {
                    if (err) {
                      return res.status(500).send("Error fetching unread notifications count");
                    }

                    pool.query(
                      "SELECT * FROM users WHERE id = $1",
                      [req.session.userId],
                      (err, userDataResult) => {
                        if (err) {
                          return res.status(500).send("Error fetching user from the user table");
                        }

                        if (!userDataResult.rows.length) {
                          return res.status(404).send("User data not found");
                        }

                        res.render("vote-analysis", {
                          groupedData: JSON.stringify(groupedData),
                          profilePicture: req.session.profilePicture,
                          role: userRoleResult.rows[0].role,
                          unreadCount: countResult.rows[0].unreadcount,
                          user: userDataResult.rows[0],
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
  });
});





// POST route to create notification
app.post("/create/notification", async (req, res) => {
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

  try {
    // Fetch users for the election
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
          [notificationID, user.username, election, sanitizedMessage, title, currentTime],
          (err) => {
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


app.get("/create/notification", async (req, res) => {
  if (
    !req.session.userId ||
    (req.session.userRole !== "Super Admin" && req.session.userRole !== "Admin")
  ) {
    return res.redirect("/login");
  }

  try {
    // Fetch current user's data
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

    user.profile_picture = user.profile_picture.toString("base64");

    // Fetch all users
    const allUsersSql = `
      SELECT users.*, roles.role, auth.username
      FROM users
      JOIN roles ON users.role_id = roles.id
      JOIN auth ON users.id = auth.user_id
      ORDER BY users.id DESC
    `;
    const allUsersResult = await pool.query(allUsersSql);
    const users = allUsersResult.rows;

    // Encode profile pictures for all users
    users.forEach((user) => {
      if (user.profile_picture) {
        user.profile_picture = user.profile_picture.toString("base64");
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

    // Fetch roles
    const rolesSql = `SELECT * FROM roles`;
    const rolesResult = await pool.query(rolesSql);
    const roles = rolesResult.rows;

    // Fetch username from auth table
    const userAuthSql = `
      SELECT username 
      FROM auth 
      WHERE user_id = $1
    `;
    const userAuthResult = await pool.query(userAuthSql, [req.session.userId]);
    const username = userAuthResult.rows[0].username;

    // Check Redis cache for unread notifications count
    const cachedUnreadCount = await redis.get(`unreadCount:${username}`);
    let unreadCount = cachedUnreadCount;

    if (!unreadCount) {
      // Fetch unread notifications count from DB if not cached
      const unreadCountSql = `
        SELECT COUNT(*) AS unreadCount 
        FROM notifications 
        WHERE username = $1 AND is_read = 0
      `;
      const unreadCountResult = await pool.query(unreadCountSql, [username]);
      unreadCount = unreadCountResult.rows[0].unreadCount;

      // Cache the result in Redis for 1 hour
      await redis.setex(`unreadCount:${username}`, 3600, unreadCount);
    }

    // Fetch user profile
    const userProfileSql = `SELECT * FROM users WHERE id = $1`;
    const userProfileResult = await pool.query(userProfileSql, [req.session.userId]);
    const profilePicture = req.session.profilePicture;

    // Fetch elections data
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
    const userElectionDataResult = await pool.query(userElectionDataSql, [req.session.userId]);
    const userElectionData = userElectionDataResult.rows;

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
    return res.status(500).send("An error occurred");
  }
});

app.get("/notifications", (req, res) => {
  // Ensure the user is logged in
  if (!req.session.userId) {
    return res.redirect("/login");
  }

  // Fetch the user's username
  pool.query(
    "SELECT username FROM auth WHERE user_id = $1",
    [req.session.userId],
    (err, userResult) => {
      if (err) {
        console.log('USER ERROR', err);
        return res.status(500).send("Error fetching user");
      }

      if (userResult.rows.length === 0) {
        return res.status(404).send("User not found");
      }

      const user = userResult.rows[0];  // Extracting user data from the result

      // Fetch notifications for the current user
      pool.query(
        "SELECT * FROM notifications WHERE username = $1 ORDER BY created_at DESC",
        [user.username],
        (err, notificationsResult) => {
          if (err) {
            return res.status(500).send("Error fetching notifications");
          }
          const notifications = notificationsResult.rows;

          // Reset unread count to zero
          pool.query(
            "UPDATE notifications SET is_read = 1 WHERE username = $1 AND is_read = 0",
            [user.username],
            (err) => {
              if (err) {
                return res
                  .status(500)
                  .send("Error updating notification status");
              }

              // Fetch the unread notifications count from Redis cache
              redis.get(`unreadCount:${user.username}`, (err, cachedUnreadCount) => {
                if (err) {
                  return res.status(500).send("Error fetching unread notifications count from cache");
                }

                let unreadCount = cachedUnreadCount;

                if (!unreadCount) {
                  // Fetch unread notifications count from DB if not cached
                  pool.query(
                    "SELECT COUNT(*) AS unreadCount FROM notifications WHERE username = $1 AND is_read = 0",
                    [user.username],
                    (err, countResult) => {
                      if (err) {
                        return res
                          .status(500)
                          .send("Error fetching unread notifications count");
                      }

                      unreadCount = countResult.rows[0].unreadCount;

                      // Cache the result in Redis for 1 hour
                      redis.setex(`unreadCount:${user.username}`, 3600, unreadCount);

                      // Fetch user profile information
                      pool.query(
                        "SELECT * FROM users WHERE id = $1",
                        [req.session.userId],
                        (err, userDataResult) => {
                          if (err) {
                            return res
                              .status(500)
                              .send("Error fetching user from the user table");
                          }

                          const userData = userDataResult.rows[0];

                          // Render the notifications page
                          res.render("notification", {
                            username: user.username,
                            userId: req.session.userId,
                            notifications,
                            profilePicture: req.session.profilePicture,
                            userData,
                            unreadCount: unreadCount,
                          });
                        }
                      );
                    }
                  );
                } else {
                  // Fetch user profile information
                  pool.query(
                    "SELECT * FROM users WHERE id = $1",
                    [req.session.userId],
                    (err, userDataResult) => {
                      if (err) {
                        return res
                          .status(500)
                          .send("Error fetching user from the user table");
                      }

                      const userData = userDataResult.rows[0];

                      // Render the notifications page
                      res.render("notification", {
                        username: user.username,
                        userId: req.session.userId,
                        notifications,
                        profilePicture: req.session.profilePicture,
                        userData,
                        unreadCount: unreadCount,
                      });
                    }
                  );
                }
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
   pool.query(
      "SELECT username FROM auth WHERE user_id = $1",
      [userId],
      (err, user) => {
        if (err || !user) {
          console.error("Error fetching user:", err);
          return;
        }

        socket.join(user.username);

        // Emit the count of unread notifications from Redis cache
       redis.get(`unreadCount:${user.username}`, (err, cachedUnreadCount) => {
         if (err) {
           console.error("Error fetching unread notifications count:", err);
           return;
         }

         if (!cachedUnreadCount) {
           // Fetch unread notifications count from DB if not cached
           pool.query(
             "SELECT COUNT(*) AS unreadCount FROM notifications WHERE username = $1 AND is_read = 0",
             [user.username],
             (err, countResult) => {
               if (err) {
                 console.error("Error fetching unread notifications count:", err);
                 return;
               }

               const unreadCount = countResult.rows[0].unreadCount;

               // Cache the result in Redis for 1 hour
               redis.setex(`unreadCount:${user.username}`, 3600, unreadCount);

               io.to(user.username).emit(
                 "unread-notifications-count",
                 unreadCount
               );
             }
           );
         } else {
           io.to(user.username).emit(
             "unread-notifications-count",
             cachedUnreadCount
           );
         }
       });
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

  if (token !== secretSavedToken) {
    return res.status(403).send("Access Denied");
  } else {
    // Check if elections data is in Redis
    redis.get("elections", (err, electionsCache) => {
      if (err) {
        console.error("Error fetching elections from Redis:", err);
        return res.status(500).send("Error fetching elections data");
      }

      if (electionsCache) {
        // If elections data is cached in Redis, parse and send it
        const electionResult = JSON.parse(electionsCache);

        // Check if roles data is in Redis
        redis.get("roles", (err, rolesCache) => {
          if (err) {
            console.error("Error fetching roles from Redis:", err);
            return res.status(500).send("Error fetching roles data");
          }

          if (rolesCache) {
            // If roles data is cached in Redis, parse and send it
            const roleResult = JSON.parse(rolesCache);
            res.render("createUser", {
              roles: roleResult, 
              elections: electionResult, 
            });
          } else {
            // Fetch roles from the database if not in Redis
            pool.query("SELECT * FROM roles", [], (err, roleResult) => {
              if (err) {
                return res.status(500).send("Internal Server Error");
              }

              // Cache roles data in Redis
              redis.set("roles", JSON.stringify(roleResult.rows));

              res.render("createUser", {
                roles: roleResult.rows, 
                elections: electionResult, 
              });
            });
          }
        });
      } else {
        // Fetch elections from the database if not in Redis
        pool.query("SELECT * FROM elections", [], (err, electionResult) => {
          if (err) {
            return res.status(500).send("Error Fetching elections");
          }

          // Cache elections data in Redis
          redis.set("elections", JSON.stringify(electionResult.rows));

          // Now check for roles data in Redis
          redis.get("roles", (err, rolesCache) => {
            if (err) {
              console.error("Error fetching roles from Redis:", err);
              return res.status(500).send("Error fetching roles data");
            }

            if (rolesCache) {
              // If roles data is cached in Redis, parse and send it
              const roleResult = JSON.parse(rolesCache);
              res.render("createUser", {
                roles: roleResult, 
                elections: electionResult.rows, 
              });
            } else {
              // Fetch roles from the database if not in Redis
              pool.query("SELECT * FROM roles", [], (err, roleResult) => {
                if (err) {
                  return res.status(500).send("Internal Server Error");
                }

                // Cache roles data in Redis
                redis.set("roles", JSON.stringify(roleResult.rows));

                res.render("createUser", {
                  roles: roleResult.rows, 
                  elections: electionResult.rows, 
                });
              });
            }
          });
        });
      }
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

    pool.query(
      "SELECT election FROM elections WHERE id = $1",
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

        pool.query(
          "INSERT INTO users(id, first_name, middle_name, last_name, DOB, profile_picture, role_id, election_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
          [userID, firstname, middlename, lastname, dob, photo, role, election],
          function (err) {
            if (err) {
              console.error(err.message);
              return res.status(500).json({
                success: false,
                message: "Error inserting into users error",
              });
            }

            pool.query(
              "INSERT INTO auth(id, username, password, user_id, election_id) VALUES ($1,$2,$3,$4,$5)",
              [uuidv4(), username, hashedPassword, userID, election],
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

                pool.query(
                  `INSERT INTO notifications (id, username, election, message, title, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
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

function getVotePercentage(positionId, electionId, callback) {
  const queryTotalVotes = `
      SELECT candidates.id, candidates.first_name, candidates.middle_name, candidates.last_name, 
             COALESCE(SUM(votes.vote), 0) AS vote_count
      FROM candidates
      LEFT JOIN votes ON candidates.id = votes.candidate_id
      WHERE candidates.position_id = $1 AND candidates.election_id = $2
      GROUP BY candidates.id;
  `;

  pool.query(queryTotalVotes, [positionId, electionId], (err, result) => {
      if (err) {
          console.error('Error fetching votes:', err);
          return callback(err, null);
      }

      const rows = result.rows;
      const totalVotes = rows.reduce((sum, candidate) => sum + Number(candidate.vote_count), 0);

      console.log("The totalVotes", totalVotes);


      if (totalVotes === 0) {
          return callback(null, rows.map(candidate => ({
              id: candidate.id,
              name: `${candidate.first_name} ${candidate.middle_name} ${candidate.last_name}`,
              votes: 0,
              percentage: "00.00"
          })));
      }

      // Compute vote percentages
      const results = rows.map(candidate => ({
          id: candidate.id,
          name: `${candidate.first_name} ${candidate.middle_name} ${candidate.last_name}`,
          votes: candidate.vote_count,
          percentage: ((candidate.vote_count / totalVotes) * 100).toFixed(2)
      }));

      callback(null, results);
  });
}




app.get("/party-dashboard", async (req, res) => {
  if (!req.session.userId || req.session.userRole !== "Candidate") {
      return res.redirect("/login");
  }

  try {
    // Check if the current user data is cached
    const cachedUserData = await redis.get(`user:${req.session.userId}`);
    
    if (cachedUserData) {
      const currentUser = JSON.parse(cachedUserData);
      console.log("Current Logged-in candidate (from Redis)", currentUser);
      
      // Get other cached data (e.g., roles, elections)
      const cachedRoles = await redis.get("roles");
      const cachedElections = await redis.get("elections");
      const cachedUnreadCount = await redis.get(`unreadCount:${req.session.userId}`);

      // Use cached data if available
      if (cachedRoles && cachedElections && cachedUnreadCount) {
        const roleResult = JSON.parse(cachedRoles);
        const electionsResult = JSON.parse(cachedElections);
        const unreadCount = JSON.parse(cachedUnreadCount);

        // Continue with rendering
        renderDashboard(res, currentUser, roleResult, electionsResult, unreadCount);
        return;
      }
    }

    // Query the current user if not in Redis
    pool.query("SELECT * FROM candidates WHERE user_id = $1", [req.session.userId], (err, currentUserResult) => {
        if (err) {
            console.error("Error fetching current user:", err);
            return res.status(500).send("An error occurred");
        }

        if (currentUserResult.rows.length === 0) {
            return res.status(404).send("User not found");
        }

        const currentUser = currentUserResult.rows[0];
        console.log("Current Logged-in candidate", currentUser);

        // Cache current user data in Redis
        redis.set(`user:${req.session.userId}`, JSON.stringify(currentUser));

        pool.query(
            `SELECT candidates.*, parties.*, users.*
            FROM candidates
            JOIN parties ON candidates.party_id = parties.id
            JOIN users ON candidates.user_id = users.id
            WHERE candidates.election_id = $1 AND candidates.user_id = $2`,
            [currentUser.election_id, currentUser.user_id],
            (err, userResult) => {
                if (err) {
                    console.error(`Error fetching current candidate for election_id ${currentUser.election_id}:`, err);
                    return res.status(500).send("An error occurred while fetching candidate data.");
                }

                if (userResult.rows.length === 0) {
                    return res.status(404).send("Candidate not found for the specified election.");
                }

                const user = userResult.rows[0];
                user.photo = user.photo ? user.photo.toString("base64") : null;
                user.logo = user.logo ? user.logo.toString("base64") : null;

                console.log("Current Candidate Data", user);

                pool.query(
                    `SELECT candidates.*, parties.*, positions.position, votes.*
                    FROM candidates
                    JOIN parties ON candidates.party_id = parties.id
                    JOIN positions ON candidates.position_id = positions.id
                    LEFT JOIN votes ON candidates.id = votes.candidate_id
                    WHERE candidates.party_id = $1 AND candidates.election_id = $2`,
                    [user.party_id, user.election_id],
                    (err, allCandidatesResult) => {
                        if (err) {
                            console.error("Error fetching all candidates:", err);
                            return res.status(500).send("An error occurred while fetching all candidates");
                        }

                        const users = allCandidatesResult.rows;

                        users.forEach((user) => {
                            if (user.photo) {
                                user.photo = user.photo.toString("base64");
                            }

                            if (user.logo) {
                                user.logo = user.logo.toString("base64");
                            }
                        });

                        // Get vote percentages for each position and candidate
                        let votePercentageData = {};
                        async.each(users, (user, callback) => {
                            getVotePercentage(user.position_id, user.election_id, (err, percentages) => {
                                if (err) {
                                    console.error('Error getting vote percentages:', err);
                                    return callback(err);
                                }
                                votePercentageData[user.position_id] = percentages;
                                callback();
                            });
                        }, async (err) => {
                            if (err) {
                                console.error('Error processing vote percentages:', err);
                                return res.status(500).send("Error processing vote percentages.");
                            }

                            // Cache vote percentages temporarily in Redis
                            await redis.set(`votePercentage:${currentUser.election_id}`, JSON.stringify(votePercentageData));

                            // Check for user roles, notifications, and elections data
                            pool.query(
                                "SELECT users.role_id, roles.role FROM users JOIN roles ON users.role_id = roles.id WHERE users.id = $1",
                                [req.session.userId],
                                (err, userRoleResult) => {
                                    if (err) {
                                        return res.status(500).send("Error fetching user role");
                                    }

                                    const userRole = userRoleResult.rows[0];

                                    pool.query("SELECT * FROM roles", (err, rolesResult) => {
                                        if (err) {
                                            return res.status(500).send("internal server error");
                                        }

                                        // Cache roles in Redis
                                        redis.set("roles", JSON.stringify(rolesResult.rows));

                                        pool.query(
                                            "SELECT COUNT(*) AS unreadCount FROM notifications WHERE username = $1 AND is_read = 0",
                                            [user.username],
                                            (err, countResult) => {
                                                if (err) {
                                                    return res.status(500).send("Error fetching unread notifications count");
                                                }

                                                const profilePicture = req.session.profilePicture;

                                                pool.query(
                                                    "SELECT * FROM elections",
                                                    (err, electionsResult) => {
                                                        if (err) {
                                                            return res.status(500).send("There was an error getting the elections data");
                                                        }

                                                        // Cache elections data
                                                        redis.set("elections", JSON.stringify(electionsResult.rows));

                                                        pool.query(
                                                            `SELECT users.*, elections.election AS election_name
                                                            FROM users
                                                            JOIN elections ON users.election_id = elections.id
                                                            WHERE users.id = $1`,
                                                            [req.session.userId],
                                                            (err, userElectionDataResult) => {
                                                                if (err) {
                                                                    console.error("Error getting the user election name:", err);
                                                                    return res.send("Error getting the userElectionName");
                                                                }

                                                                const elections = electionsResult.rows;
                                                                const userElectionData = userElectionDataResult.rows;

                                                                // Render the dashboard with cached data
                                                                renderDashboard(res, currentUser, userRole, rolesResult.rows, countResult.rows[0].unreadcount, user, elections, userElectionData, votePercentageData);
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
                    }
                );
            }
        );
    });
  } catch (err) {
    console.error("Error with Redis or querying:", err);
    return res.status(500).send("Internal Server Error");
  }
});

function renderDashboard(res, currentUser, userRole, roles, unreadCount, user, elections, userElectionData, votePercentageData) {
    res.render("party-dashboard", {
        users: user,
        profilePicture: req.session.profilePicture,
        voteStatus: user.has_voted ? "Voted" : "Not Voted",
        role: userRole.role,
        roles: roles,
        unreadCount: unreadCount,
        user: user,
        elections: elections,
        userElectionData: userElectionData,
        votePercentageData: votePercentageData
    });
}







// Downloading registered voters and election results list
// Voters record route
app.get("/voters-record", (req, res) => {
  if (
    !req.session.userId ||
    (req.session.userRole !== "Super Admin" &&
      req.session.userRole !== "Admin" &&
      req.session.userRole !== "Candidate")
  ) {
    return res.redirect("/login");
  }

  // Check Redis cache for voters data
  redis.get('votersData', (err, cachedData) => {
    if (cachedData) {
      console.log("Serving from cache");
      const data = JSON.parse(cachedData);
      return res.render("voters-record", {
        allVotersData: data.allVotersData,
        role: data.role,
        roles: data.roles,
        unreadCount: data.unreadCount,
        user: data.user,
        profilePicture: data.profilePicture,
      });
    }

    // If not in cache, query the database
    pool.query(
      "SELECT users.role_id, roles.role FROM users JOIN roles ON users.role_id = roles.id WHERE users.id = $1",
      [req.session.userId],
      (err, userRole) => {
        if (err) {
          return res.status(500).send("Error fetching user role");
        }

        pool.query("SELECT * FROM roles", [], (err, roles) => {
          if (err) {
            return res.status(500).send("Internal server error");
          }

          pool.query(
            "SELECT * FROM users WHERE id = $1",
            [req.session.userId],
            (err, currentUser) => {
              if (err) {
                console.error("Error fetching current user:", err);
                return res.status(500).send("An error occurred");
              }
              if (currentUser.rows.length === 0) {
                return res.status(404).send("User not found");
              }

              pool.query(
                `SELECT auth.*, users.*, elections.election 
                FROM auth
                JOIN users ON auth.user_id = users.id
                JOIN elections ON users.election_id = elections.id
                WHERE users.election_id = $1`,
                [currentUser.rows[0].election_id],
                (err, allVotersData) => {
                  if (err) {
                    console.error("Error fetching voters:", err);
                    return res.status(500).send("An error occurred");
                  }

                  pool.query(
                    "SELECT users.* FROM users WHERE users.election_id = $1 AND users.id = $2",
                    [currentUser.rows[0].election_id, currentUser.rows[0].id],
                    (err, user) => {
                      if (err) {
                        console.error(`Error fetching current candidate:`, err);
                        return res
                          .status(500)
                          .send("An error occurred while fetching candidate data.");
                      }

                      if (user.rows.length === 0) {
                        return res
                          .status(404)
                          .send("Candidate not found for the specified election.");
                      }

                      pool.query(
                        "SELECT COUNT(*) AS unreadCount FROM notifications WHERE username = $1 AND is_read = 0",
                        [user.rows[0].username],
                        (err, countResult) => {
                          if (err) {
                            return res
                              .status(500)
                              .send("Error fetching unread notifications count");
                          }
                          const profilePicture = req.session.profilePicture;

                          // Cache the response in Redis for 10 minutes
                          const responseData = {
                            allVotersData: allVotersData.rows,
                            role: userRole.rows[0].role,
                            roles: roles.rows,
                            unreadCount: countResult.rows[0].unreadCount,
                            user: user.rows[0],
                            profilePicture,
                          };
                          redis.setex('votersData', 600, JSON.stringify(responseData));

                          // Return the response
                          res.render("voters-record", responseData);
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


// Download CSV route
app.get("/download/csv", (req, res) => {
  if (
    !req.session.userId ||
    (req.session.userRole !== "Super Admin" &&
      req.session.userRole !== "Admin" &&
      req.session.userRole !== "Candidate")
  ) {
    return res.redirect("/login");
  }

  pool.query(
    "SELECT * FROM users WHERE id = $1",
    [req.session.userId],
    (err, currentUser) => {
      if (err) {
        console.error("Error fetching current user:", err);
        return res.status(500).send("An error occurred");
      }
      if (currentUser.rows.length === 0) {
        return res.status(404).send("User not found");
      }

      pool.query(
        `SELECT auth.*, users.*, COALESCE(elections.election, 'No Election') AS election
        FROM auth
        JOIN users ON auth.user_id = users.id
        LEFT JOIN elections ON users.election_id = elections.id
        WHERE auth.user_id IN (SELECT id FROM users WHERE election_id = $1);
        `,
        [currentUser.rows[0].election_id],
        (err, rows) => {
          if (err) {
            console.error("Error fetching voters:", err);
            return res.status(500).send("An error occurred");
          }

          if (rows.rows.length === 0) {
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
            const csv = parser.parse(rows.rows);

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

// Election result route
app.get("/election-record", (req, res) => {
  if (
    !req.session.userId ||
    (req.session.userRole !== "Super Admin" &&
      req.session.userRole !== "Admin" &&
      req.session.userRole !== "Candidate")
  ) {
    return res.redirect("/login");
  }

  redis.get('electionData', (err, cachedData) => {
    if (cachedData) {
      console.log("Serving election data from cache");
      const data = JSON.parse(cachedData);
      return res.render("election-record", {
        allCandidateData: data.allCandidateData,
        role: data.role,
        roles: data.roles,
        unreadCount: data.unreadCount,
        user: data.user,
        profilePicture: data.profilePicture,
      });
    }

    pool.query(
      "SELECT users.role_id, roles.role FROM users JOIN roles ON users.role_id = roles.id WHERE users.id = $1",
      [req.session.userId],
      (err, userRole) => {
        if (err) {
          return res.status(500).send("Error fetching user role");
        }

        pool.query("SELECT * FROM roles", [], (err, roles) => {
          if (err) {
            return res.status(500).send("Internal server error");
          }

          pool.query(
            "SELECT * FROM users WHERE id = $1",
            [req.session.userId],
            (err, currentUser) => {
              if (err) {
                console.error("Error fetching current user:", err);
                return res.status(500).send("Error fetching current user:");
              }
              if (currentUser.rows.length === 0) {
                return res.status(404).send("User not found");
              }

              pool.query(
                `SELECT candidates.*, COALESCE(votes.vote, 0) AS vote, positions.position, parties.party
                FROM candidates
                LEFT JOIN votes ON candidates.id = votes.candidate_id
                LEFT JOIN positions ON candidates.position_id = positions.id
                LEFT JOIN parties ON candidates.party_id = parties.id
                WHERE candidates.election_id = $1`,
                [currentUser.rows[0].election_id],
                (err, allCandidateData) => {
                  if (err) {
                    console.error("Error fetching candidate info:", err);
                    return res.status(500).send("Error fetching candidate info:");
                  }

                  pool.query(
                    "SELECT users.* FROM users WHERE users.election_id = $1 AND users.id = $2",
                    [currentUser.rows[0].election_id, currentUser.rows[0].id],
                    (err, user) => {
                      if (err) {
                        console.error(`Error fetching current candidate:`, err);
                        return res
                          .status(500)
                          .send("An error occurred while fetching candidate data.");
                      }

                      if (user.rows.length === 0) {
                        return res
                          .status(404)
                          .send("Candidate not found for the specified election.");
                      }

                      pool.query(
                        "SELECT COUNT(*) AS unreadCount FROM notifications WHERE username = $1 AND is_read = 0",
                        [user.rows[0].username],
                        (err, countResult) => {
                          if (err) {
                            return res
                              .status(500)
                              .send("Error fetching unread notifications count");
                          }
                          const profilePicture = req.session.profilePicture;

                          // Cache the response in Redis for 10 minutes
                          const responseData = {
                            allCandidateData: allCandidateData.rows,
                            role: userRole.rows[0].role,
                            roles: roles.rows,
                            unreadCount: countResult.rows[0].unreadCount,
                            user: user.rows[0],
                            profilePicture,
                          };
                          redis.setex('electionData', 600, JSON.stringify(responseData));

                          res.render("election-record", responseData);
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

// Election result download CSV route
app.get("/election/download/csv", (req, res) => {
  if (
    !req.session.userId ||
    (req.session.userRole !== "Super Admin" &&
      req.session.userRole !== "Admin" &&
      req.session.userRole !== "Candidate")
  ) {
    return res.redirect("/login");
  }

  pool.query(
    "SELECT * FROM users WHERE id = $1",
    [req.session.userId],
    (err, currentUser) => {
      if (err) {
        console.error("Error fetching current user:", err);
        return res.status(500).send("An error occurred");
      }
      if (currentUser.rows.length === 0) {
        return res.status(404).send("User not found");
      }

      pool.query(
        `SELECT candidates.*, COALESCE(votes.vote, 0) AS vote, positions.position, parties.party
        FROM candidates
        LEFT JOIN votes ON candidates.id = votes.candidate_id
        LEFT JOIN positions ON candidates.position_id = positions.id
        LEFT JOIN parties ON candidates.party_id = parties.id
        WHERE candidates.election_id = $1`,
        [currentUser.rows[0].election_id],
        (err, rows) => {
          if (err) {
            console.error("Error fetching candidates:", err);
            return res.status(500).send("An error occurred");
          }

          if (rows.rows.length === 0) {
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
            const csv = parser.parse(rows.rows);

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

app.get("/create-election", (req, res) => {
  const token = req.query.token;

  if (token !== secretSavedToken) {
    return res.status(403).send("Access Denied");
  } else {
    res.render("createElection", {});
  }
});
app.get("/create-role", (req, res) => {
  const token = req.query.token;

  if (token !== secretSavedToken) {
    return res.status(403).send("Access Denied");
  } else {
    res.render("createRole", {});
  }
});
app.post("/create-role", (req, res) => {
  console.log("Received data:", req.body); // Debugging log
  
  const { role } = req.body;
  
  if (!role) {
    return res.status(400).json({ success: false, message: "Role is required" });
  }

  const roleID = uuidv4();
  
  pool.query(
    "INSERT INTO roles (id, role) VALUES($1, $2)",
    [roleID, role],
    (err, result) => {
      if (err) {
        console.error("Database error:", err); // Log the actual error
        return res.status(500).json({ success: false, message: "Error inserting role", error: err.message });
      }
      return res.status(201).json({ success: true, message: "Role added successfully", roleID });
    }
  );
});

//     }
//   );
// });

app.listen(port, () => {
  console.log(`App is listening to port ${port}`);
});