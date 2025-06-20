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
const PDFDocument = require('pdfkit');
const fs = require("fs");
const { Parser } = require("json2csv");
const nodemailer = require("nodemailer");
const cors = require("cors");
const { Pool } = require("pg");

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

// app.use(bodyParser.urlencoded({ extended: true }));
// app.use(express.urlencoded({ extended: true }));
// app.use(express.json());
// {/* <option value="dfbf036d-2bda-4c20-ae8e-8d8d238d9565">About to hack your system</option> */}
// app.use(bodyParser.json());
app.use(express.urlencoded({ extended: true })); 
app.use(express.json());

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

const pool = new Pool({
  user: "avnadmin",
  host: process.env.DATABASE_HOST,
  database: "defaultdb",
  password: process.env.DATABASE_PASS,
  port: 15368,
  ssl: {
    rejectUnauthorized: false,
  },
});


pool
  .connect()
  .then(() =>
    console.log("Connected to aiven PostgreSQL database successfully!")
  )
  .catch((err) =>
    console.error("Error connecting to aiven PostgreSQL database:", err)
  );

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

  pool.query(
    "SELECT * FROM auth WHERE username = $1",
    [username],
    (err, result) => {
      if (err) {
        return res.status(500).send("Internal Server Error");
      }

      const user = result.rows[0]; // Extract the first user from the result set
      if (!user) {
        return res.render("login", {
          errorMessage: "Invalid voterID or password",
        });
      }

      bcrypt.compare(password, user.password, (err, isMatch) => {
        if (err) {
          return res.status(500).send("Internal Server Error");
        }
        if (!isMatch) {
          return res.render("login", {
            errorMessage: "Invalid voterID or password",
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
    }
  );
});

app.get("/dashboard", async (req, res) => {
  if (!req.session.userId) {
    return res.redirect("/login");
  }

  try {
    const electionId = req.query.electionId || null;

    // Get the election ID associated with the user
    const userElectionQuery = await pool.query(
      "SELECT election_id FROM users WHERE id = $1",
      [req.session.userId]
    );

    const userElectionId = electionId || userElectionQuery.rows[0]?.election_id;

    if (!userElectionId) {
      return res.status(404).send("Election not selected or registered");
    }

    // Fetch candidates and votes
    const sqlCandidates = `
      SELECT candidates.*, parties.party, parties.logo, positions.position, 
             COALESCE(SUM(votes.vote), 0) AS vote
      FROM candidates
      JOIN parties ON candidates.party_id = parties.id
      JOIN positions ON candidates.position_id = positions.id
      LEFT JOIN votes ON candidates.id = votes.candidate_id
      WHERE candidates.election_id = $1
      GROUP BY candidates.id, parties.party, parties.logo, positions.position
    `;

    const sqlTotalVotesPerPosition = `
      SELECT positions.position, COALESCE(SUM(votes.vote), 0) AS totalVotes
      FROM candidates
      JOIN positions ON candidates.position_id = positions.id
      LEFT JOIN votes ON candidates.id = votes.candidate_id
      WHERE candidates.election_id = $1
      GROUP BY positions.position
    `;
    const sqlTotalVotes = `
    SELECT COALESCE(SUM(votes.vote), 0) AS totalVotes
    FROM candidates
    LEFT JOIN votes ON candidates.id = votes.candidate_id
    WHERE candidates.election_id = $1
  `;

    // Fetch total users
    const totalUsersQuery = await pool.query(
      `SELECT COUNT(*) AS totalUsers 
       FROM auth 
       JOIN users ON auth.user_id = users.id 
       WHERE users.election_id = $1`,
      [userElectionId]
    );

    const totalUsers = totalUsersQuery.rows[0].totalusers;

    // Fetch total votes per position
    const totalVotesPerPositionQuery = await pool.query(
      sqlTotalVotesPerPosition,
      [userElectionId]
    );

    const totalVotesMap = {};
    totalVotesPerPositionQuery.rows.forEach((row) => {
      totalVotesMap[row.position] = row.totalvotes || 0;
    });

    // Fetch candidates
    const candidatesQuery = await pool.query(sqlCandidates, [userElectionId]);

    let candidates = candidatesQuery.rows.map((candidate) => ({
      ...candidate,
      photo: candidate.photo ? candidate.photo.toString("base64") : null,
      logo: candidate.logo ? candidate.logo.toString("base64") : null,
      votePercentage:
        totalVotesMap[candidate.position] > 0
          ? (candidate.vote / totalVotesMap[candidate.position]) * 100
          : 0,
    }));

    // Calculate total votes
    const totalVotesQuery = await pool.query(sqlTotalVotes, [userElectionId]);
    const totalVotes = totalVotesQuery.rows[0].totalvotes || 0;

    // Group candidates by position
    const groupedCandidates = candidates.reduce((acc, candidate) => {
      if (!acc[candidate.position]) {
        acc[candidate.position] = [];
      }
      acc[candidate.position].push(candidate);
      return acc;
    }, {});

    // Fetch user role
    const userRoleQuery = await pool.query(
      "SELECT users.role_id, roles.role FROM users JOIN roles ON users.role_id = roles.id WHERE users.id = $1",
      [req.session.userId]
    );

    // Fetch user data
    const userQuery = await pool.query(
      "SELECT username FROM auth WHERE user_id = $1",
      [req.session.userId]
    );

    if (userQuery.rows.length === 0) {
      return res.status(404).send("User not found");
    }

    const username = userQuery.rows[0].username;

    // Fetch unread notifications count
    const unreadCountQuery = await pool.query(
      "SELECT COUNT(*) AS unreadCount FROM notifications WHERE username = $1 AND is_read = 0",
      [username]
    );

    // Fetch user details
    const userDetailsQuery = await pool.query(
      "SELECT * FROM users WHERE id = $1",
      [req.session.userId]
    );

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

  let user = userResult.rows[0];
  user.profile_picture = user.profile_picture
    ? Buffer.from(user.profile_picture).toString("base64")
    : null;
    // Fetch election settings
    const electionSettingsSql = `SELECT * FROM election_settings WHERE election_id = $1`;
    const electionSettingsResult = await pool.query(electionSettingsSql, [
      user.election_id,
    ]);

    const registrationTiming = electionSettingsResult.rows[0];
    console.log("Registration Timing:", registrationTiming);

    const currentTime = new Date().toLocaleTimeString("en-US", {
      hour12: false,
    });
    const electionStartTime = registrationTiming.start_time;
    // const electionEndTime = registrationTiming.end_time;
    const electionEndTime = registrationTiming.end_time;
    const adminEndTime = registrationTiming.admin_end_time;

    const currentDate = electionStartTime.split("T")[0];
    const fullCurrentTime = `${currentDate}T${currentTime}`;

    const end = new Date(electionEndTime);
    const start = new Date(electionStartTime);
    const admin_end = new Date(adminEndTime);
    const current = new Date(fullCurrentTime);

    // Fetch all elections
    const electionsQuery = await pool.query("SELECT * FROM elections");

    const profilePicture = req.session.profilePicture;
    console.log("TotalVotes", totalVotes);
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
      profilePicture,
      current: new Date().toISOString(),
      admin_end: new Date(admin_end).toISOString(), 
      end: new Date(end).toISOString(),
      start: new Date(start).toISOString(),
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Internal Server Error");
  }
});

// ============================ VOTERS GET ROUTE ================================

app.get("/voters", async (req, res) => {
  if (
    !req.session.userId ||
    (req.session.userRole !== "Super Admin" && req.session.userRole !== "Admin")
  ) {
    return res.redirect("/login");
  }

  try {
    // Fetch the current user's data
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

    let user = userResult.rows[0];
    user.profile_picture = user.profile_picture
      ? Buffer.from(user.profile_picture).toString("base64")
      : null;

    // Fetch election settings
    const electionSettingsSql = `SELECT * FROM election_settings WHERE election_id = $1`;
    const electionSettingsResult = await pool.query(electionSettingsSql, [
      user.election_id,
    ]);

    const registrationTiming = electionSettingsResult.rows[0];
    console.log("Registration Timing:", registrationTiming);

    // Fetch all users
    const allUsersSql = `
      SELECT users.*, roles.role, auth.username, elections.election
      FROM users 
      JOIN roles ON users.role_id = roles.id
      JOIN elections ON users.election_id = elections.id
      JOIN auth ON users.id = auth.user_id
    `;
    const usersResult = await pool.query(allUsersSql);
    let users = usersResult.rows;

    users.forEach((user) => {
      if (user.profile_picture) {
        user.profile_picture = Buffer.from(user.profile_picture).toString(
          "base64"
        );
      }
    });

    const voteStatus = user.has_voted ? "Voted" : "Not Voted";

    // Fetch user role
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
    const usernameResult = await pool.query(
      "SELECT username FROM auth WHERE user_id = $1",
      [req.session.userId]
    );
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
    const currentUserDataResult = await pool.query(
      "SELECT * FROM users WHERE id = $1",
      [req.session.userId]
    );
    const currentUser = currentUserDataResult.rows[0];

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

// =============================== VOTERS POST ROUTE ==================================
app.post("/voters", upload.single("photo"), async (req, res) => {
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
    return res
      .status(400)
      .json({
        success: false,
        message: "First Name or Last Name must be at least 3 characters",
      });
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
      return res
        .status(400)
        .json({
          success: false,
          message: `The username '${username}' is already taken.`,
        });
    }

    // Get election age eligibility
    const electionResult = await pool.query(
      "SELECT * FROM elections WHERE id = $1",
      [election]
    );
    const electionEligibility = electionResult.rows[0];

    if (!electionEligibility) {
      return res
        .status(400)
        .json({ success: false, message: "Election eligibility not found" });
    }

    const voterAgeEligibility = electionEligibility.voter_age_eligibility;

    // Calculate user's age
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

    if (age < voterAgeEligibility) {
      return res
        .status(400)
        .json({
          success: false,
          message: `You must be at least ${voterAgeEligibility} years old to register.`,
        });
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
    const userInsertResult = await pool.query(insertUserQuery, [
      votersID,
      firstname,
      middlename,
      lastname,
      dob,
      photo,
      role,
      election,
    ]);

    if (userInsertResult.rowCount === 0) {
      throw new Error("User insertion failed");
    }

    // Insert into auth table
    const authID = uuidv4();
    const insertAuthQuery = `
      INSERT INTO auth(id, username, password, user_id, election_id) 
      VALUES ($1, $2, $3, $4, $5)
    `;
    const authInsertResult = await pool.query(insertAuthQuery, [
      authID,
      username,
      hashedPassword,
      votersID,
      election,
    ]);

    if (authInsertResult.rowCount === 0) {
      throw new Error("Auth insertion failed");
    }

    // Insert notification
    const notificationMessage = `Hi ${firstname} ${middlename} ${lastname} (${username}), you have successfully registered for ${electionEligibility.election}!`;
    await pool.query(
      "INSERT INTO notifications (id, username, election, message, title, created_at) VALUES ($1, $2, $3, $4, $5, NOW())",
      [
        uuidv4(),
        username,
        election,
        notificationMessage,
        "Registration Successful",
      ]
    );

    // Commit transaction if everything is successful
    await pool.query("COMMIT");

    // Emit notification
    io.to(username).emit("new-notification", {
      message: notificationMessage,
      title: "Registration Successful",
      created_at: new Date(),
    });

    res
      .status(201)
      .json({
        success: true,
        message: `${username} has successfully been registered`,
      });
  } catch (err) {
    // Rollback transaction if an error occurs
    await pool.query("ROLLBACK");
    console.error("Error processing request:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Delete user
app.post("/delete/users", (req, res) => {
  let { voterIds } = req.body;

  try {
      voterIds = JSON.parse(voterIds); // Parse JSON string to array
  } catch (error) {
      return res.redirect("/voters?error=Invalid voter data");
  }

  if (!Array.isArray(voterIds) || voterIds.length === 0) {
    return res.redirect("/voters?error=No voter selected");
  }

  const placeholders = voterIds.map((_, i) => `$${i + 1}`).join(", ");

  pool.query(`DELETE FROM users WHERE id IN (${placeholders})`, voterIds, function (err) {
      if (err) {
          console.error("Error deleting users:", err.message);
          return res.redirect("/voters?error=Error Deleting voter");
      }

      pool.query(`DELETE FROM auth WHERE user_id IN (${placeholders})`, voterIds, function (err) {
          if (err) {
              console.error("Error deleting auth records:", err.message);
              return res.redirect("/voters?error=Error Deleting voter");
          }

          pool.query(`DELETE FROM candidates WHERE user_id IN (${placeholders})`, voterIds, function (err) {
              if (err) {
                  console.error("Error deleting candidates:", err.message);
                  return res.redirect("/voters?error=Error Deleting voter");
              }

              pool.query(`DELETE FROM user_votes WHERE user_id IN (${placeholders})`, voterIds, function (err) {
                  if (err) {
                      console.error("Error deleting user votes:", err.message);
                      return res.redirect("/voters?error=Error Deleting voter");
                  }
                  return res.redirect("/voters?success=Voter Deleted successfully");
              });
          });
      });
  });
});



// Mark user as voted
app.post("/voted/users", (req, res) => {
  let { voterIds } = req.body;

  try {
      voterIds = JSON.parse(voterIds); // Parse JSON string to array
  } catch (error) {
      return res.redirect("/voters?error=Invalid voter data");
  }

  if (!Array.isArray(voterIds) || voterIds.length === 0) {
    return res.redirect("/voters?error=No voter selected");
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
          return res.redirect("/voters?success=Users marked as voted successfully!");
      });
  });
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

app.post("/admin/delete/users", (req, res) => {
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

  pool.query(`DELETE FROM users WHERE id IN (${placeholders})`, voterIds, function (err) {
      if (err) {
          console.error("Error deleting users:", err.message);
          return res.redirect("/admin/voters?error=Error Deleting voter");
      }

      pool.query(`DELETE FROM auth WHERE user_id IN (${placeholders})`, voterIds, function (err) {
          if (err) {
              console.error("Error deleting auth records:", err.message);
              return res.redirect("/admin/voters?error=Error Deleting voter");
          }

          pool.query(`DELETE FROM candidates WHERE user_id IN (${placeholders})`, voterIds, function (err) {
              if (err) {
                  console.error("Error deleting candidates:", err.message);
                  return res.redirect("/admin/voters?error=Error Deleting voter");
              }

              pool.query(`DELETE FROM user_votes WHERE user_id IN (${placeholders})`, voterIds, function (err) {
                  if (err) {
                      console.error("Error deleting user votes:", err.message);
                      return res.redirect("/admin/voters?error=Error Deleting voter");
                  }
                  return res.redirect("/admin/voters?success=Voter Deleted successfully");
              });
          });
      });
  });
});

app.post("/admin/voted/users", (req, res) => {
  let { voterIds } = req.body;

  try {
      voterIds = JSON.parse(voterIds); // Parse JSON string to array
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
          return res.redirect("/admin/voters?success=Users marked as voted successfully!");
      });
  });

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
      (req.session.userRole !== "Super Admin" &&
        req.session.userRole !== "Admin")
    ) {
      return res.redirect("/login");
    }

    // Fetch all parties with election names
    const partiesResult = await pool.query(
      `SELECT parties.*, elections.election 
       FROM parties 
       JOIN elections ON parties.election_id = elections.id`
    );

    const parties = partiesResult.rows.map((party) => {
      if (party.logo) {
        party.logo = party.logo.toString("base64");
      }
      return party;
    });

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
app.post("/delete/party", (req, res) => {
  let { voterIds } = req.body;

  if (!voterIds) {
      return res.redirect("/create/party?error=No party selected");
  }

  try {
      voterIds = JSON.parse(voterIds);
  } catch (error) {
      return res.redirect("/create/party?error=Invalid party data");
  }

  if (!Array.isArray(voterIds) || voterIds.length === 0) {
      return res.redirect("/create/party?error=No party selected");
  }

  const placeholders = voterIds.map((_, i) => `$${i + 1}`).join(", ");

  pool.query(`DELETE FROM parties WHERE id IN (${placeholders})`, voterIds, function (err) {
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
      (req.session.userRole !== "Super Admin" &&
        req.session.userRole !== "Admin")
    ) {
      return res.redirect("/login");
    }

    const profilePicture = req.session.profilePicture;

    // Fetch all positions with election names
    const positionsResult = await pool.query(
      `SELECT positions.*, elections.election
       FROM positions 
       JOIN elections ON positions.election_id = elections.id`
    );
    const positions = positionsResult.rows;

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

    // Fetch all elections
    const electionsResult = await pool.query("SELECT * FROM elections");
    const elections = electionsResult.rows;

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
    console.log("Received Data:", req.body); // Debugging

    const {
      election,
      position,
      position_description,
      candidate_age_eligibility,
    } = req.body;
    if (
      !election ||
      !position ||
      !position_description ||
      !candidate_age_eligibility
    ) {
      return res
        .status(400)
        .json({ success: false, message: "All fields are required." });
    }

    const positionID = uuidv4();

    await pool.query(
      "INSERT INTO positions (id, election_id, position, position_description, candidate_age_eligibility) VALUES ($1, $2, $3, $4, $5)",
      [
        positionID,
        election,
        position,
        position_description,
        candidate_age_eligibility,
      ]
    );

    res
      .status(200)
      .json({
        success: true,
        message: `${position} Position created successfully`,
      });
  } catch (error) {
    console.error("Database Insert Error:", error);
    res.status(500).json({ success: false, message: "Database insert failed" });
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

app.post("/delete/position", async (req, res) => {
  let { voterIds } = req.body;

  if (!voterIds) {
      return res.redirect("/add/position?error=No position selected");
  }

  try {
      voterIds = JSON.parse(voterIds);
  } catch (error) {
      return res.redirect("/add/position?error=Invalid position data");
  }

  if (!Array.isArray(voterIds) || voterIds.length === 0) {
      return res.redirect("/add/position?error=No position selected");
  }

  const placeholders = voterIds.map((_, i) => `$${i + 1}`).join(", ");

  pool.query(`DELETE FROM positions WHERE id IN (${placeholders})`, voterIds, function (err) {
      if (err) {
          console.error("Error deleting position:", err.message);
          return res.redirect("/add/position?error=Error deleting position");
      }
      res.redirect("/add/position?success=Position Deleted Successfully!");
  });
});

//======================== CANDIDATE REGISTRATION ROUTES =============================

app.get("/candidate/registration", async (req, res) => {
  try {
    if (
      !req.session.userId ||
      (req.session.userRole !== "Super Admin" &&
        req.session.userRole !== "Admin")
    ) {
      return res.redirect("/login");
    }

    // Fetch parties
    const { rows: parties } = await pool.query("SELECT * FROM parties");

    // Fetch second role (LIMIT 1 OFFSET 1 gets the second role)
    const { rows: roles } = await pool.query(
      "SELECT * FROM roles LIMIT 1 OFFSET 1"
    );
    if (roles.length === 0) {
      return res.status(404).send("Second role not found");
    }
    const secondRole = roles[0];

    // Fetch positions
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


    // Fetch unread notifications count
    const { rows: unreadNotifications } = await pool.query(
      "SELECT COUNT(*) AS unreadCount FROM notifications WHERE username = $1 AND is_read = 0",
      [user.username]
    );
    const unreadCount = unreadNotifications[0].unreadcount;

    // Fetch candidates
    let { rows: candidates } = await pool.query(`
      SELECT candidates.*, parties.party, parties.logo, positions.position, votes.vote AS vote, elections.election AS candidate_election
      FROM candidates
      JOIN parties ON candidates.party_id = parties.id 
      JOIN positions ON candidates.position_id = positions.id
      LEFT JOIN votes ON candidates.id = votes.candidate_id
      JOIN elections ON candidates.election_id = elections.id
      ORDER BY candidates.first_name
    `);

    // Convert images to base64
    candidates = candidates.map((candidate) => ({
      ...candidate,
      photo: candidate.photo ? candidate.photo.toString("base64") : null,
      logo: candidate.logo ? candidate.logo.toString("base64") : null,
    }));

    // Fetch user details from users table
    const { rows: userTableData } = await pool.query(
      "SELECT * FROM users WHERE id = $1",
      [req.session.userId]
    );
    const userTable = userTableData[0];

    // Fetch parties for Admin based on election_id
    const { rows: Adminparties } = await pool.query(
      "SELECT * FROM parties WHERE election_id = $1",
      [userTable.election_id]
    );

    // Fetch positions for Admin based on election_id
    const { rows: Adminpositions } = await pool.query(
      "SELECT * FROM positions WHERE election_id = $1",
      [userTable.election_id]
    );

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
    let { rows: Admincandidates } = await pool.query(
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

    // Convert Admin candidates images to base64
    Admincandidates = Admincandidates.map((candidate) => ({
      ...candidate,
      photo: candidate.photo ? candidate.photo.toString("base64") : null,
      logo: candidate.logo ? candidate.logo.toString("base64") : null,
    }));

    console.log("User Election Data:", userElectionData);

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
      userTable
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

    res.redirect(
      "/candidate/registration?success=Candidate record updated successfully!"
    );
  } catch (err) {
    console.error("Error updating candidate:", err.message);
    res.redirect(
      "/candidate/registration?error=Error updating candidate record"
    );
  }
});

// DELETE Candidate
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

    res.redirect(
      "/candidate/registration?success=Candidate record deleted successfully!"
    );
  } catch (err) {
    await pool.query("ROLLBACK"); // Rollback transaction in case of an error
    console.error("Error deleting candidate:", err.message);
    res.redirect(
      "/candidate/registration?error=Error deleting candidate record"
    );
  }
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

      const candidateAgeEligibility =
        positionResult.rows[0].candidate_age_eligibility;

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

      const electionName =
        electionResult.rows.length > 0
          ? electionResult.rows[0].election
          : "the election";

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
        ]
      );

      // Send notification
      const currentTime = new Date();
      const notificationMessage = `Hi ${firstname} ${middlename} ${lastname} (${username}), congratulations on successfully registering for ${electionName} using our online election voting system! Your vote is powerful and can shape the future. Stay tuned for any important updates regarding the election process.`;
      const notificationTitle = "Registration Successful";

      await pool.query(
        `INSERT INTO notifications (id, username, election, message, title, created_at) 
       VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          uuidv4(),
          username,
          election,
          notificationMessage,
          notificationTitle,
          currentTime,
        ]
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
        message:
          "There was a problem registering the candidate. Please try again later.",
      });
    }
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
    console.log("profile user data", user);

    const DOB = new Date(user.dob);

    const formattedDOB = DOB.toISOString().split("T")[0];

    console.log("Profile new dob", formattedDOB);

    user.profile_picture = user.profile_picture.toString("base64");

    // Check if the user has voted
    const voteStatus = user.has_voted ? "Voted" : "Not Voted";

    pool.query(
      "SELECT COUNT(*) AS unreadCount FROM notifications WHERE username = $1 AND is_read = 0",
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
          unreadCount: countResult.rows[0].unreadCount,
          profilePicture,
          formattedDOB,
        });
      }
    );
  });
});

app.get("/vote", (req, res) => {
  if (!req.session.userId) {
    return res.redirect("/login");
  }

  pool.query(
    `SELECT * FROM users WHERE id = $1`,
    [req.session.userId],
    (err, user) => {
      if (err) {
        return res.status(500).send("Error retrieving user data");
      }

      const ElectionId = user.rows[0].election_id;

      const sql = `
        SELECT candidates.id, candidates.first_name, candidates.last_name, candidates.middle_name, candidates.photo, positions.position, parties.party, COALESCE(votes.vote, 0) AS vote
        FROM candidates
        JOIN positions ON candidates.position_id = positions.id
        JOIN parties ON candidates.party_id = parties.id
        LEFT JOIN votes ON candidates.id = votes.candidate_id
        WHERE candidates.election_id = $1
      `;

      pool.query(sql, [ElectionId], (err, candidates) => {
        if (err) {
          return res.status(500).send("Error fetching candidates data");
        }

        const profilePicture = req.session.profilePicture;

        candidates.rows = candidates.rows.map((candidate) => {
          return {
            ...candidate,
            photo: candidate.photo.toString("base64"),
          };
        });

        pool.query(
          `SELECT users.role_id, roles.role 
           FROM users 
           JOIN roles ON users.role_id = roles.id 
           WHERE users.id = $1`,
          [req.session.userId],
          (err, userRole) => {
            if (err) {
              return res.status(500).send("Error fetching user role");
            }

            pool.query(
              `SELECT username FROM auth WHERE user_id = $1`,
              [req.session.userId],
              (err, user) => {
                if (err) {
                  return res.status(500).send("Error fetching user data");
                }

                if (!user.rows.length) {
                  return res.status(404).send("User not found");
                }

                const groupedCandidates = candidates.rows.reduce(
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

                pool.query(
                  `SELECT election_id FROM users WHERE id = $1`,
                  [userId],
                  (err, userElection) => {
                    if (err) {
                      return res.status(500).send("Error fetching election ID");
                    }

                    if (!userElection.rows.length) {
                      return res.status(404).send("Election ID not found");
                    }

                    const userElectionId = userElection.rows[0].election_id;

                    pool.query(
                      `SELECT * FROM candidates WHERE election_id = $1`,
                      [userElectionId],
                      (err, candidates) => {
                        if (err) {
                          return res
                            .status(500)
                            .send("Error fetching candidates");
                        }

                        pool.query(
                          `SELECT COUNT(*) AS unreadCount FROM notifications WHERE username = $1 AND is_read = 0`,
                          [user.rows[0].username],
                          (err, countResult) => {
                            if (err) {
                              return res
                                .status(500)
                                .send(
                                  "Error fetching unread notifications count"
                                );
                            }

                            pool.query(
                              `SELECT * FROM users WHERE id = $1`,
                              [req.session.userId],
                              (err, users) => {
                                if (err) {
                                  return res
                                    .status(500)
                                    .send("Error fetching user data");
                                }
                                if (!users.rows.length) {
                                  return res.send("User data not found");
                                }

                                const userElectionID =
                                  users.rows[0].election_id;

                                pool.query(
                                  `SELECT * FROM users WHERE id = $1`,
                                  [req.session.userId],
                                  (err, user) => {
                                    if (err) {
                                      return res
                                        .status(500)
                                        .send("Error fetching user data");
                                    }

                                    pool.query(
                                      `SELECT * FROM election_settings WHERE election_id = $1`,
                                      [user.rows[0].election_id],
                                      (err, electionTiming) => {
                                        if (err) {
                                          return res
                                            .status(500)
                                            .send(
                                              "Error fetching election timing"
                                            );
                                        }

                                        const currentTime =
                                          new Date().toISOString();

                                        const startTime =
                                          electionTiming.rows[0].start_time;
                                        const endTime =
                                          electionTiming.rows[0].end_time;

                                        const adminStartTime =
                                        electionTiming.rows[0].admin_start_time;
                                      const adminEndTime =
                                        electionTiming.rows[0].admin_end_time;

                                        const start = new Date(startTime).getTime();
                                        const end = new Date(endTime).getTime();
                                        const admin_start = new Date(adminStartTime).getTime();
                                        const admin_end = new Date(adminEndTime).getTime();
                                        const current = new Date(currentTime).getTime();
                                        
                                        res.render("vote", {
                                          candidates: candidates.rows,
                                          role: userRole.rows[0].role,
                                          profilePicture,
                                          unreadCount:
                                            countResult.rows[0].unreadcount,
                                          user: user.rows[0],
                                          groupedCandidates,
                                          userElectionID,
                                          start,
                                          end,
                                          current,
                                          admin_start,
                                          admin_end,
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
app.post("/local-vote-count", upload.none(), async (req, res) => {
  const { votes } = req.body;

  try {
    const voteEntries = Object.entries(votes);

    for (const [candidate_id, count] of voteEntries) {
      await pool.query(
        `INSERT INTO votes (candidate_id, vote)
         VALUES ($1, $2)
         ON CONFLICT (candidate_id)
         DO UPDATE SET vote = votes.vote + EXCLUDED.vote`,
        [candidate_id, parseInt(count)]
      );
    }

    res.status(201).json({ message: "Votes incremented successfully." });
  } catch (err) {
    console.error("Error incrementing votes:", err);
    res.status(500).json({ error: "Failed to process votes." });
  }
});



app.post("/vote", upload.none(), async (req, res) => {
  const { electionID } = req.body;
  const userId = req.session.userId;
  const positions = Object.keys(req.body);
  const userVotesID = uuidv4();
  try {
    const client = await pool.connect(); 
    await client.query("BEGIN"); 

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
      userVotesID,
      userId,
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
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    const username = userResult.rows[0].username;
    const currentTime = new Date();
    const notificationMessage = `Thank you ${username}, for casting your vote. It has been successfully counted.`;
    const notificationTitle = "Vote Counted";

    // Insert a notification
    await client.query(
      `INSERT INTO notifications (id,username, election, message, title, created_at) 
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        userVotesID,
        username,
        electionID,
        notificationMessage,
        notificationTitle,
        currentTime,
      ]
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
  if (!req.session.userId || req.session.userRole !== "Super Admin") {
    return res.redirect("/login");
  }
  res.render("forget-password");
});

app.post("/forget-password", (req, res) => {
  const { voter_id, password, passwordConfirm } = req.body;

  if (password !== passwordConfirm) {
    return res
      .status(400)
      .json({ success: false, message: "Passwords do not match" });
  }

  pool.query(
    "SELECT * FROM auth WHERE username = $1",
    [voter_id],
    (err, result) => {
      if (err) {
        return res
          .status(500)
          .json({ success: false, message: `An error occurred, ${err}` });
      }

      if (!result.rows.length) {
        return res
          .status(404)
          .json({ success: false, message: "VoterID does not exist" });
      }

      bcrypt.hash(password, 10, (err, hash) => {
        if (err) {
          return res
            .status(500)
            .json({ success: false, message: "An error occurred" });
        }

        pool.query(
          "UPDATE auth SET password = $1 WHERE username = $2",
          [hash, voter_id],
          (err) => {
            if (err) {
              return res
                .status(500)
                .json({ success: false, message: "An error occurred" });
            }

            return res
              .status(200)
              .json({
                success: true,
                message: "Password Updated Successfully",
              });
          }
        );
      });
    }
  );
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

    pool.query(
      "SELECT COUNT(*) AS unreadCount FROM notifications WHERE username = $1 AND is_read = 0",
      [user.username],
      (err, countResult) => {
        if (err) {
          return res
            .status(500)
            .send("Error fetching unread notifications count");
        }

        const unreadCount = parseInt(countResult.rows[0].unreadcount);
        const profilePicture = req.session.profilePicture;

        res.render("voter-setting", {
          unreadCount,
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

  pool.query(
    "SELECT * FROM auth WHERE username = $1 AND user_id = $2",
    [username, req.session.userId],
    (err, result) => {
      if (err) {
        return res.status(500).send("An error occurred");
      }

      if (!result.rows.length) {
        return res
          .status(404)
          .json({ success: false, message: "Invalid username." });
      }

      const user = result.rows[0];

      if (user.username !== username) {
        return res
          .status(403)
          .json({
            success: false,
            message: "You are not authorized to change this password",
          });
      }

      bcrypt.hash(password, 10, (err, hash) => {
        if (err) {
          return res
            .status(500)
            .json({ success: false, message: "An error occurred" });
        }

        pool.query(
          "UPDATE auth SET password = $1 WHERE username = $2 AND user_id = $3",
          [hash, username, req.session.userId],
          (err) => {
            if (err) {
              return res
                .status(500)
                .json({ success: false, message: "An error occurred" });
            }

            res
              .status(200)
              .json({
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

  pool.query(
    "SELECT * FROM auth WHERE user_id = $1",
    [req.session.userId],
    (err, result) => {
      if (err) {
        return res
          .status(500)
          .json({ success: false, message: "Internal server error" });
      }

      if (!result.rows.length) {
        return res
          .status(404)
          .json({ success: false, message: "User does not exist" });
      }

      const user = result.rows[0];

      if (user.username !== username) {
        return res
          .status(403)
          .json({
            success: false,
            message: "You are not authorized to change this username",
          });
      }

      bcrypt.compare(password, user.password, (err, match) => {
        if (!match) {
          return res
            .status(400)
            .json({ success: false, message: "Incorrect password" });
        }

        pool.query(
          "UPDATE auth SET username = $1 WHERE username = $2 AND user_id = $3",
          [Newusername, username, req.session.userId],
          (err) => {
            if (err) {
              return res
                .status(500)
                .json({ success: false, message: "Internal server error" });
            }

            res
              .status(200)
              .json({
                success: true,
                message: "Username updated successfully!",
              });
          }
        );
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
                 WHERE username = $1 AND is_read = 0`, // Changed `0` to `false`
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
    admin_start_time,
    admin_end_time,
  } = req.body;

  console.log(req.body);

  const electionID = uuidv4();

  try {
    // Begin transaction
    await pool.query("BEGIN");

    // Insert into elections table
    const insertElectionQuery = `
      INSERT INTO elections (id, election, voter_age_eligibility)
      VALUES ($1, $2, $3)
    `;
    await pool.query(insertElectionQuery, [
      electionID,
      election,
      voter_age_eligibility,
    ]);

    // Insert into election_settings table
    const insertElectionSettingsQuery = `
      INSERT INTO election_settings (id, start_time, end_time, registration_start_time, registration_end_time, election_id, admin_start_time, admin_end_time)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `;
    await pool.query(insertElectionSettingsQuery, [
      uuidv4(),
      start_time,
      end_time,
      registration_start_time,
      registration_end_time,
      electionID,
      admin_start_time,
      admin_end_time,
    ]);

    // Commit the transaction
    await pool.query("COMMIT");

    // Send success response
    res.status(200).json({
      success: true,
      message: `${election}, successfully created`,
    });
  } catch (err) {
    // In case of error, rollback the transaction
    await pool.query("ROLLBACK");

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
    adminStartTime,
    adminEndTime,
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
        "UPDATE election_settings SET start_time = $1, end_time = $2, registration_start_time = $3, registration_end_time = $4, admin_start_time = $5, admin_end_time = $6 WHERE election_id = $7",
        [startTime, endTime, RegistrationStartTime, RegistrationEndTime, adminStartTime, adminEndTime, id],
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
      console.log("Current user data", currentUser.election_id);

      const positionsQuery = `
  SELECT positions.position, candidates.first_name, candidates.middle_name, 
         candidates.last_name, candidates.photo, COALESCE(SUM(votes.vote), 0) AS vote
  FROM candidates
  JOIN positions ON candidates.position_id = positions.id
  LEFT JOIN votes ON candidates.id = votes.candidate_id
  WHERE candidates.election_id = $1
  GROUP BY positions.position, candidates.id
  ORDER BY positions.position, candidates.last_name
`;

      pool.query(
        positionsQuery,
        [currentUser.election_id],
        (err, candidatesResult) => {
          if (err) {
            console.error("Error fetching candidates data:", err);
            return res.status(500).send("Error fetching candidates data");
          }

          const groupedData = {};

          candidatesResult.rows.forEach((candidate) => {
            // Normalize position by trimming spaces and replacing multiple spaces with a single one
            const position = candidate.position.trim().replace(/\s+/g, " ");

            // Log the position for debugging
            console.log(`Processing position: "${position}"`);

            const candidateName = `${candidate.first_name} ${
              candidate.middle_name || ""
            } ${candidate.last_name}`.trim();

            // Log the candidate name for debugging
            console.log(`Candidate Name: "${candidateName}"`);

            // Ensure position exists in groupedData
            if (!groupedData[position]) {
              groupedData[position] = { candidates: [] };

            }


            // Add candidate to the corresponding position
       groupedData[position].candidates.push({
  name: candidateName,
  vote: candidate.vote,
 photo: Buffer.isBuffer(candidate.photo)
  ? `data:image/jpeg;base64,${candidate.photo.toString('base64')}`
  : (typeof candidate.photo === "string" ? candidate.photo : "")

});



          });

          // Log groupedData to verify the result
          console.log(groupedData);

          // Proceed with rendering or further processing the groupedData

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

                  // Fetch unread notifications count
                  pool.query(
                    "SELECT COUNT(*) AS unreadCount FROM notifications WHERE username = $1 AND is_read = 0",
                    [username],
                    (err, countResult) => {
                      if (err) {
                        return res
                          .status(500)
                          .send("Error fetching unread notifications count");
                      }

                      pool.query(
                        "SELECT * FROM users WHERE id = $1",
                        [req.session.userId],
                        (err, userDataResult) => {
                          if (err) {
                            return res
                              .status(500)
                              .send("Error fetching user from the user table");
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
        }
      );
    }
  );
});

// GET route to create notification
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
    const currentUserResult = await pool.query(currentUserSql, [
      req.session.userId,
    ]);
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

    // Fetch unread notifications count
    const unreadCountSql = `
      SELECT COUNT(*) AS unreadCount 
      FROM notifications 
      WHERE username = $1 AND is_read = 0
    `;
    const unreadCountResult = await pool.query(unreadCountSql, [username]);
    const unreadCount = unreadCountResult.rows[0].unreadcount;

    // Fetch user profile
    const userProfileSql = `SELECT * FROM users WHERE id = $1`;
    const userProfileResult = await pool.query(userProfileSql, [
      req.session.userId,
    ]);
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
    const userElectionDataResult = await pool.query(userElectionDataSql, [
      req.session.userId,
    ]);
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

// Helper function for time ago
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


// Notifications route
app.get("/notifications", (req, res) => {
  if (!req.session.userId) {
    return res.redirect("/login");
  }
console.log("Session user", req.session.userId)
  pool.query(
    "SELECT username FROM auth WHERE user_id = $1",
    [req.session.userId],
    (err, userResult) => {
      if (err) {
        console.error("USER ERROR", err);
        return res.status(500).send("Error fetching user");
      }
      console.log("user result", userResult);

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
                    [req.session.userId],
                    (err, userDataResult) => {
                      if (err) {
                        return res.status(500).send("Error fetching user data");
                      }

                      const userData = userDataResult.rows[0];

                      res.render("notification", {
                        username,
                        userId: req.session.userId,
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

// Socket.IO connection
io.on("connection", (socket) => {
  console.log("A user connected");

  socket.on("join", (userId) => {
    pool.query(
      "SELECT username FROM auth WHERE user_id = $1",
      [userId],
      (err, userResult) => {
        if (err || !userResult.rows.length) {
          console.error("Error fetching user:", err);
          return;
        }

        const username = userResult.rows[0].username;
        socket.join(username);

        pool.query(
          "SELECT COUNT(*) AS unreadCount FROM notifications WHERE username = $1 AND is_read = 0",
          [username],
          (err, countResult) => {
            if (err) {
              console.error("Error fetching unread notifications count:", err);
              return;
            }

            const unreadCount = parseInt(countResult.rows[0].unreadcount, 10) || 0;
            io.to(username).emit("unread-notifications-count", unreadCount);
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

  if (token !== secretSavedToken) {
    return res.status(403).send("Access Denied");
  } else {
    pool.query("SELECT * FROM elections", [], (err, electionResult) => {
      if (err) {
        return res.status(500).send("Error Fetching elections");
      }
      pool.query("SELECT * FROM roles", [], (err, roleResult) => {
        if (err) {
          return res.status(500).send("Internal Server Error");
        }

        res.render("createUser", {
          roles: roleResult.rows,
          elections: electionResult.rows,
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

    pool.query(
  "SELECT election FROM elections WHERE id = $1",
  [election],
  (err, result) => {
    if (err) {
      console.error("Error fetching election name:", err);
      return res.status(500).json({
        success: false,
        message: "Error fetching election",
      });
    }

    const electionName = result.rows[0]?.election || "the election";
    console.log("Election name:", electionName);

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

app.get("/party-dashboard", async (req, res) => {
  if (!req.session.userId || req.session.userRole !== "Candidate") {
    return res.redirect("/login");
  }

  try {
    const currentUserResult = await pool.query(
      "SELECT * FROM candidates WHERE user_id = $1",
      [req.session.userId]
    );

    if (currentUserResult.rows.length === 0) {
      return res.status(404).send("User not found");
    }

    const currentUser = currentUserResult.rows[0];

    const userResult = await pool.query(
      `SELECT candidates.*, parties.*, users.*
       FROM candidates
       JOIN parties ON candidates.party_id = parties.id
       JOIN users ON candidates.user_id = users.id
       WHERE candidates.election_id = $1 AND candidates.user_id = $2`,
      [currentUser.election_id, currentUser.user_id]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).send("Candidate not found for the specified election.");
    }

    const user = userResult.rows[0];
    user.photo = user.photo ? user.photo.toString("base64") : null;
    user.logo = user.logo ? user.logo.toString("base64") : null;


    const samePartyCandidatesResult = await pool.query(
      `SELECT 
        candidates.*, 
        parties.*, 
        users.*, 
        positions.position, 
        COALESCE(votes.vote, 0) AS vote_count
       FROM candidates
       JOIN parties ON candidates.party_id = parties.id
       JOIN users ON candidates.user_id = users.id
       JOIN positions ON candidates.position_id = positions.id
       LEFT JOIN votes ON candidates.id = votes.candidate_id
       WHERE candidates.party_id = $1 AND candidates.election_id = $2
       ORDER BY positions.id`,
      [user.party_id, user.election_id]
    );
    
    const partyCandidates = samePartyCandidatesResult.rows;

    partyCandidates.forEach(candidate => {
      candidate.photo = candidate.photo ? candidate.photo.toString("base64") : null;
      candidate.logo = candidate.logo ? candidate.logo.toString("base64") : null;
    });
    
    

    const allCandidatesResult = await pool.query(
      `SELECT 
        candidates.id AS candidate_id,
        candidates.position_id,
        users.first_name, 
        users.middle_name, 
        users.last_name, 
        COALESCE(votes.vote, 0) AS vote_count
       FROM candidates
       JOIN users ON candidates.user_id = users.id
       LEFT JOIN votes ON candidates.id = votes.candidate_id
       WHERE candidates.election_id = $1`,
      [user.election_id]
    );
    
    const allCandidates = allCandidatesResult.rows;
    
    // const users = allCandidatesResult.rows;


    allCandidates.forEach(u => {
      u.photo = u.photo ? u.photo.toString("base64") : null;
      u.logo = u.logo ? u.logo.toString("base64") : null;
    });

    const voteStatus = user.has_voted ? "Voted" : "Not Voted";

    const userRoleResult = await pool.query(
      "SELECT users.role_id, roles.role FROM users JOIN roles ON users.role_id = roles.id WHERE users.id = $1",
      [req.session.userId]
    );
    const userRole = userRoleResult.rows[0];

    const rolesResult = await pool.query("SELECT * FROM roles");

    const countResult = await pool.query(
      "SELECT COUNT(*) AS unreadCount FROM notifications WHERE username = $1 AND is_read = 0",
      [user.username]
    );

    const profilePicture = req.session.profilePicture;

    const electionsResult = await pool.query("SELECT * FROM elections");

    const userElectionDataResult = await pool.query(
      `SELECT users.*, elections.election AS election_name
       FROM users
       JOIN elections ON users.election_id = elections.id
       WHERE users.id = $1`,
      [req.session.userId]
    );

    const elections = electionsResult.rows;
    const userElectionData = userElectionDataResult.rows;

    const voteCounts = {};
    const totalVotesByPosition = {};
    
    // Use all candidates for vote calculations
    allCandidates.forEach(candidate => {
      const fullName = `${candidate.first_name} ${candidate.middle_name} ${candidate.last_name}`;
      const positionId = candidate.position_id;
      const voteCount = parseInt(candidate.vote_count) || 0;
    
      if (!voteCounts[positionId]) {
        voteCounts[positionId] = [];
        totalVotesByPosition[positionId] = 0;
      }
    
      voteCounts[positionId].push({ name: fullName, votes: voteCount });
      totalVotesByPosition[positionId] += voteCount;
    });
    
    const votePercentageData = {};
    for (let positionId in voteCounts) {
      const candidates = voteCounts[positionId];
      const totalVotes = totalVotesByPosition[positionId];
    
      votePercentageData[positionId] = candidates.map(candidate => ({
        name: candidate.name,
        votes: candidate.votes,
        percentage: totalVotes > 0
          ? ((candidate.votes / totalVotes) * 100).toFixed(2)
          : "0.00"
      }));
    }
    
    console.log("Vote Percentage Record: ", votePercentageData);
    res.render("party-dashboard", {
      users: partyCandidates,
      votePercentageData,
      profilePicture,
      voteStatus,
      role: userRole.role,
      roles: rolesResult.rows,
      unreadCount: countResult.rows[0].unreadcount,
      user,
      elections,
      userElectionData,
      // votePercentageData
    });

  } catch (err) {
    console.error("Server error:", err);
    res.status(500).send("Internal server error");
  }
});






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
                      console.error(
                        `Error fetching current candidate for election_id ${currentUser.rows[0].election_id}:`,
                        err
                      );
                      return res
                        .status(500)
                        .send(
                          "An error occurred while fetching candidate data."
                        );
                    }

                    if (user.rows.length === 0) {
                      return res
                        .status(404)
                        .send(
                          "Candidate not found for the specified election."
                        );
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
                        res.render("voters-record", {
                          allVotersData: allVotersData.rows,
                          role: userRole.rows[0].role,
                          roles: roles.rows,
                          unreadCount: countResult.rows[0].unreadCount,
                          user: user.rows[0],
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
                      console.error(
                        `Error fetching current candidate for election_id ${currentUser.rows[0].election_id}:`,
                        err
                      );
                      return res
                        .status(500)
                        .send(
                          "An error occurred while fetching candidate data."
                        );
                    }

                    if (user.rows.length === 0) {
                      return res
                        .status(404)
                        .send(
                          "Candidate not found for the specified election."
                        );
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
                        res.render("election-record", {
                          allCandidateData: allCandidateData.rows,
                          role: userRole.rows[0].role,
                          roles: roles.rows,
                          unreadCount: countResult.rows[0].unreadCount,
                          user: user.rows[0],
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



// =========== Election Records PDF Downloads +===============
app.get("/download/voters/pdf", (req, res) => {
  if (
    !req.session.userId ||
    !["Super Admin", "Admin", "Candidate"].includes(req.session.userRole)
  ) {
    return res.redirect("/login");
  }

  pool.query("SELECT * FROM users WHERE id = $1", [req.session.userId], (err, currentUser) => {
    if (err || currentUser.rows.length === 0) {
      return res.status(500).send("Error fetching user");
    }

    const electionId = currentUser.rows[0].election_id;

    pool.query(
      `SELECT auth.*, users.*, COALESCE(elections.election, 'No Election') AS election
       FROM auth
       JOIN users ON auth.user_id = users.id
       LEFT JOIN elections ON users.election_id = elections.id
       WHERE auth.user_id IN (SELECT id FROM users WHERE election_id = $1)`,
      [electionId],
      (err, voters) => {
        if (err || voters.rows.length === 0) {
          return res.status(500).send("Error fetching voter data");
        }

        const doc = new PDFDocument({ size: "A4", margin: 50 });
        const filename = "voters-record.pdf";

        res.setHeader("Content-disposition", `attachment; filename="${filename}"`);
        res.setHeader("Content-type", "application/pdf");

        doc.pipe(res);

        // Title
        doc
        .fontSize(18)
        .text(voters.rows[0].election || "Election", { align: "center" })
        .moveDown(0.5)
        .text("Voters Record", { align: "center", underline: true });

        doc.moveDown(1.5);

        // Table headers
        const tableTop = 100;
        const rowHeight = 25;
        const colWidths = [50, 120, 120, 120, 100];
        const colTitles = ["#", "First Name", "Middle Name", "Last Name"];

        let startY = tableTop;

        // Draw Header Row
        colTitles.forEach((title, i) => {
          doc
            .font("Helvetica-Bold")
            .fontSize(12)
            .text(title, 50 + colWidths.slice(0, i).reduce((a, b) => a + b, 0), startY, {
              width: colWidths[i],
              align: "center",
            });
        });

        startY += rowHeight;

        // Draw Rows
        voters.rows.forEach((voter, index) => {
          const row = [
            index + 1,
            voter.first_name,
            voter.middle_name || "-",
            voter.last_name,
          ];

          row.forEach((val, i) => {
            doc
              .font("Helvetica")
              .fontSize(11)
              .text(String(val), 50 + colWidths.slice(0, i).reduce((a, b) => a + b, 0), startY, {
                width: colWidths[i],
                align: "center",
              });
          });

          startY += rowHeight;

          // Avoid overflowing the page
          if (startY > 750) {
            doc.addPage();
            startY = tableTop;
          }
        });

        doc.end();
      }
    );
  });
});

app.get("/download/election/results/pdf", (req, res) => {
  if (
    !req.session.userId ||
    !["Super Admin", "Admin", "Candidate"].includes(req.session.userRole)
  ) {
    return res.redirect("/login");
  }

  pool.query("SELECT * FROM users WHERE id = $1", [req.session.userId], (err, currentUser) => {
    if (err || currentUser.rows.length === 0) {
      return res.status(500).send("Error fetching user");
    }

    const electionId = currentUser.rows[0].election_id;

    pool.query(
      `SELECT candidates.*, COALESCE(votes.vote, 0) AS vote, 
              positions.position, parties.party, 
              elections.election 
       FROM candidates
       LEFT JOIN votes ON candidates.id = votes.candidate_id
       LEFT JOIN positions ON candidates.position_id = positions.id
       LEFT JOIN parties ON candidates.party_id = parties.id
       LEFT JOIN elections ON candidates.election_id = elections.id
       WHERE candidates.election_id = $1`,
      [electionId],
      (err, candidates) => {
        if (err || candidates.rows.length === 0) {
          return res.status(500).send("Error fetching candidate data");
        }

        const doc = new PDFDocument({ margin: 40 });
        const filename = "election-results.pdf";

        res.setHeader("Content-disposition", `attachment; filename="${filename}"`);
        res.setHeader("Content-type", "application/pdf");

        doc.pipe(res);

        // Title
        doc
          .fontSize(18)
          .text(candidates.rows[0].election || "Election", { align: "center" })
          .moveDown(0.5)
          .text("Election Results", { align: "center", underline: true });

        doc.moveDown(1);

        // Column Headers
        doc.fontSize(12).font("Helvetica-Bold");
        const tableTop = doc.y;
        const colWidths = [40, 130, 100, 100, 60];

        doc.text("No", 50, tableTop);
        doc.text("Candidate", 90, tableTop);
        doc.text("Position", 230, tableTop);
        doc.text("Party", 330, tableTop);
        doc.text("Votes", 430, tableTop);


        // Table Rows
        doc.font("Helvetica").moveDown(0.5);
        candidates.rows.forEach((candidate, index) => {
          const y = doc.y;

          const fullName = `${candidate.first_name} ${candidate.middle_name || ""} ${candidate.last_name}`;
          doc.text(index + 1, 50, y);
          doc.text(fullName.trim(), 90, y, { width: 130 });
          doc.text(candidate.position, 230, y, { width: 100 });
          doc.text(candidate.party, 330, y, { width: 100 });
          doc.text(candidate.vote.toString(), 430, y, { width: 60 });

          doc.moveDown(2.5); 
        });

        doc.end();
      }
    );
  });
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
    return res
      .status(400)
      .json({ success: false, message: "Role is required" });
  }

  const roleID = uuidv4();

  pool.query(
    "INSERT INTO roles (id, role) VALUES($1, $2)",
    [roleID, role],
    (err, result) => {
      if (err) {
        console.error("Database error:", err); // Log the actual error
        return res
          .status(500)
          .json({
            success: false,
            message: "Error inserting role",
            error: err.message,
          });
      }
      return res
        .status(201)
        .json({ success: true, message: "Role added successfully", roleID });
    }
  );
});

//     }
//   );
// });

app.listen(port, () => {
  console.log(`App is listening to port ${port}`);
});
