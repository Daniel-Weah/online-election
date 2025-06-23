const { Router } = require("express");
const router = Router();
const pool = require("../db");
const { Parser } = require("json2csv");
const PDFDocument = require("pdfkit");
const path = require("path");


router.get("/election-record", async (req, res) => {
  const { userId, userRole, profilePicture } = req.session;

  if (!userId || !["Super Admin", "Admin", "Candidate"].includes(userRole)) {
    return res.redirect("/login");
  }

  try {
    // 1. Get user role
    const roleResult = await pool.query(
      `SELECT roles.role FROM users JOIN roles ON users.role_id = roles.id WHERE users.id = $1`,
      [userId]
    );
    if (roleResult.rows.length === 0) {
      return res.status(404).send("User role not found");
    }
    const role = roleResult.rows[0].role;

    // 2. Get all roles
    const rolesResult = await pool.query("SELECT * FROM roles");
    const roles = rolesResult.rows;

    // 3. Get current user
    const userResult = await pool.query("SELECT * FROM users WHERE id = $1", [userId]);
    if (userResult.rows.length === 0) {
      return res.status(404).send("User not found");
    }
    const user = userResult.rows[0];

    // 4. Get all candidate data for user's election
    const candidatesResult = await pool.query(
      `SELECT candidates.*, COALESCE(votes.vote, 0) AS vote, 
              positions.position, parties.party
       FROM candidates
       LEFT JOIN votes ON candidates.id = votes.candidate_id
       LEFT JOIN positions ON candidates.position_id = positions.id
       LEFT JOIN parties ON candidates.party_id = parties.id
       WHERE candidates.election_id = $1`,
      [user.election_id]
    );
    const allCandidateData = candidatesResult.rows;

    // 5. Get unread notifications
    const unreadResult = await pool.query(
      `SELECT COUNT(*) AS unreadCount FROM notifications WHERE username = $1 AND is_read = 0`,
      [user.username]
    );
    const unreadCount = unreadResult.rows[0]?.unreadcount || 0;

    // 6. Render the election-record view
    res.render("election-record", {
      allCandidateData,
      role,
      roles,
      unreadCount,
      user,
      profilePicture,
    });
  } catch (err) {
    console.error("Error in /election-record:", err);
    res.status(500).send("An error occurred while loading election records.");
  }
});


router.get("/election/download/csv", async (req, res) => {
  const { userId, userRole } = req.session;

  if (!userId || !["Super Admin", "Admin", "Candidate"].includes(userRole)) {
    return res.redirect("/login");
  }

  try {
    // Get current user
    const currentUserResult = await pool.query("SELECT * FROM users WHERE id = $1", [userId]);
    if (currentUserResult.rows.length === 0) {
      return res.status(404).send("User not found");
    }

    const electionId = currentUserResult.rows[0].election_id;

    // Get candidate data for the user's election
    const candidateResult = await pool.query(
      `SELECT candidates.first_name, candidates.middle_name, candidates.last_name, 
              positions.position, parties.party, COALESCE(votes.vote, 0) AS vote
       FROM candidates
       LEFT JOIN votes ON candidates.id = votes.candidate_id
       LEFT JOIN positions ON candidates.position_id = positions.id
       LEFT JOIN parties ON candidates.party_id = parties.id
       WHERE candidates.election_id = $1`,
      [electionId]
    );

    const candidates = candidateResult.rows;

    if (candidates.length === 0) {
      return res.status(404).send("No candidate records found.");
    }

    // Generate CSV
    const fields = ["first_name", "middle_name", "last_name", "position", "party", "vote"];
    const parser = new Parser({ fields });
    const csv = parser.parse(candidates);

    // Send CSV
    res.header("Content-Type", "text/csv");
    res.attachment("election-data.csv");
    res.send(csv);

  } catch (err) {
    console.error("Error generating election CSV:", err);
    return res.status(500).send("An error occurred while generating the CSV.");
  }
});


router.get("/download/election/results/pdf", async (req, res) => {
  const { userId, userRole } = req.session;

  if (!userId || !["Super Admin", "Admin", "Candidate"].includes(userRole)) {
    return res.redirect("/login");
  }

  try {
    const userResult = await pool.query("SELECT * FROM users WHERE id = $1", [userId]);
    if (userResult.rows.length === 0) {
      return res.status(404).send("User not found");
    }

    const electionId = userResult.rows[0].election_id;

    const result = await pool.query(
      `SELECT candidates.first_name, candidates.middle_name, candidates.last_name,
              positions.position, parties.party, COALESCE(votes.vote, 0) AS vote,
              COALESCE(elections.election, 'Election') AS election
       FROM candidates
       LEFT JOIN votes ON candidates.id = votes.candidate_id
       LEFT JOIN positions ON candidates.position_id = positions.id
       LEFT JOIN parties ON candidates.party_id = parties.id
       LEFT JOIN elections ON candidates.election_id = elections.id
       WHERE candidates.election_id = $1`,
      [electionId]
    );

    const candidates = result.rows;
    if (candidates.length === 0) {
      return res.status(404).send("No candidate data found");
    }

    const doc = new PDFDocument({ margin: 40 });
    const filename = "election-results.pdf";
    const logoPath = path.join(__dirname, "../public/images/votewiseLogo.png");

    res.setHeader("Content-disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-type", "application/pdf");

    doc.pipe(res);

    // === Custom Header Function ===
    function drawHeader() {
      // Left and right logos
      doc.image(logoPath, 50, 30, { width: 50, height: 50 });
      doc.image(logoPath, doc.page.width - 100, 30, { width: 50, height: 50 });

      // Header text
      doc
        .font("Helvetica-Bold")
        .fontSize(16)
        .text("Votewise Online Election", 0, 35, { align: "center" })
        .font("Helvetica")
        .fontSize(11)
        .text("Empowering Transparent & Secure Digital Voting", 0, 55, { align: "center" });

      doc.moveDown(3);
    }

    // Draw initial header
    drawHeader();

    // Election title
    doc
      .fontSize(18)
      .text(candidates[0].election, { align: "center" })
      .moveDown(0.5)
      .text("Election Results", { align: "center", underline: true });

    doc.moveDown(1);

    // Table headers
    doc.fontSize(12).font("Helvetica-Bold");
    const tableTop = doc.y;

    doc.text("No", 50, tableTop);
    doc.text("Candidate", 90, tableTop);
    doc.text("Position", 240, tableTop);
    doc.text("Party", 340, tableTop);
    doc.text("Votes", 440, tableTop);

    doc.font("Helvetica").fontSize(11);

    let y = tableTop + 20;

    candidates.forEach((c, index) => {
      const fullName = `${c.first_name} ${c.middle_name || ""} ${c.last_name}`.trim();

      doc.text(index + 1, 50, y);
      doc.text(fullName, 90, y, { width: 140 });
      doc.text(c.position, 240, y, { width: 100 });
      doc.text(c.party, 340, y, { width: 100 });
      doc.text(c.vote.toString(), 440, y, { width: 60 });

      y += 25;

      // If close to bottom, add new page and redraw header and table header
      if (y > 750) {
        doc.addPage();
        drawHeader();

        // Re-draw table header
        const newTop = doc.y;

        doc.fontSize(12).font("Helvetica-Bold");
        doc.text("No", 50, newTop);
        doc.text("Candidate", 90, newTop);
        doc.text("Position", 240, newTop);
        doc.text("Party", 340, newTop);
        doc.text("Votes", 440, newTop);

        doc.font("Helvetica").fontSize(11);
        y = newTop + 20;
      }
    });

    doc.end();
  } catch (err) {
    console.error("Error generating results PDF:", err);
    return res.status(500).send("An error occurred while generating the PDF.");
  }
});



module.exports = router