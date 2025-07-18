const express = require("express");
const path = require("path");
const http = require("http");
const socketIo = require("socket.io");
const bodyParser = require("body-parser");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const multer = require("multer");
const dotenv = require("dotenv");
const cors = require("cors");
const nodemailer = require("nodemailer");

// Load environment variables
dotenv.config();

const db = require("./db");

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const port = process.env.PORT || 3000;

// Attach io instance to requests
app.set("io", io);

// Socket.IO setup
io.on("connection", (socket) => {

  socket.on("join", (userId) => {
    socket.join(userId);
    io.to(userId).emit("unread-notifications-count", 0);
  });

  socket.on("disconnect", () => {
  });
});

const isProduction = process.env.NODE_ENV === 'production';
app.set("trust proxy", 1);

// ✅ PostgreSQL-based session store
app.use(session({
  store: new pgSession({
    pool: db,          
    tableName: 'session' 
  }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: isProduction,
    maxAge: 3 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
  }
}));

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));
app.set("view engine", "ejs");
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Multer setup
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Inject io into requests
app.use((req, res, next) => {
  req.io = io;
  next();
});

// Home route
app.get("/", (req, res) => {
  res.render("index");
});

// Nodemailer setup
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// Contact form email handler
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
      return res.status(500).json({ success: false, message: "Failed to send email" });
    }
    res.status(200).json({ success: true, message: "Email sent successfully" });
  });
});

// Route imports
const dashboardRoute = require("./routes/dashboardRoute");
const candidateRoute = require("./routes/candidateRoute");
const adminVotersRoute = require("./routes/adminVotersRoute");
const createElectionRoute = require("./routes/createElectionRoute");
const createNotificationRoute = require("./routes/createNotificationRoute");
const createUserRoute = require("./routes/createUserRoute");
const electionResultRecordRoute = require("./routes/electionResultRecordRoute");
const forgetPasswordRoute = require("./routes/forgetPasswordRoute");
const loginRoute = require("./routes/loginRoute");
const logoutRoute = require("./routes/logoutRoute");
const notLoginRoute = require("./routes/notLoginRoute");
const partyDashboardRoute = require("./routes/partyDashboardRoute");
const partyRoute = require("./routes/partyRoute");
const positionRoute = require("./routes/positionRoute");
const profileRoute = require("./routes/profileRoute");
const userSettingRoute = require("./routes/userSetting");
const voteAnalysisRoute = require("./routes/voteAnalysis");
const voterNotificationRoute = require("./routes/voterNotificationRoute");
const voteRoute = require("./routes/voteRoute");
const voterRecordRoute = require("./routes/voterRecordRoute");
const votersRoute = require("./routes/votersRoute");
const apiRoutes = require("./routes/api");

// Use routes
app.use("/", dashboardRoute);
app.use("/", candidateRoute);
app.use("/", adminVotersRoute);
app.use("/", createElectionRoute);
app.use("/", createNotificationRoute);
app.use("/", createUserRoute);
app.use("/", electionResultRecordRoute);
app.use("/", forgetPasswordRoute);
app.use("/", loginRoute);
app.use("/", logoutRoute);
app.use("/", notLoginRoute);
app.use("/", partyDashboardRoute);
app.use("/", partyRoute);
app.use("/", positionRoute);
app.use("/", profileRoute);
app.use("/", userSettingRoute);
app.use("/", voteAnalysisRoute);
app.use("/", voterNotificationRoute);
app.use("/", voteRoute);
app.use("/", voterRecordRoute);
app.use("/", votersRoute);
app.use("/api", apiRoutes);

// Start server
server.listen(port, () => {
  console.log(`✅ Server is running on http://localhost:${port}`);
});
