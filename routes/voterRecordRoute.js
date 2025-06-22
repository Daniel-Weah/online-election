const { Router } = require("express");
const router = Router();
const pool = require("../db");
const { Parser } = require("json2csv");
const PDFDocument = require("pdfkit");

// Route: GET /voters-record
router.get("/voters-record", async (req, res) => {
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

    // 4. Get all voters from the same election
    const votersResult = await pool.query(
      `SELECT auth.*, users.*, elections.election 
       FROM auth
       JOIN users ON auth.user_id = users.id
       JOIN elections ON users.election_id = elections.id
       WHERE users.election_id = $1`,
      [user.election_id]
    );
    const allVotersData = votersResult.rows;

    // 5. Get unread notifications count
    const unreadResult = await pool.query(
      "SELECT COUNT(*) AS unreadCount FROM notifications WHERE username = $1 AND is_read = 0",
      [user.username]
    );
    const unreadCount = unreadResult.rows[0]?.unreadcount || 0;

    // 6. Render view
    res.render("voters-record", {
      allVotersData,
      role,
      roles,
      unreadCount,
      user,
      profilePicture
    });
  } catch (err) {
    console.error("Error in /voters-record:", err);
    res.status(500).send("An error occurred while loading voter records.");
  }
});

router.get("/download/csv", async (req, res) => {
  const { userId, userRole } = req.session;

  if (!userId || !["Super Admin", "Admin", "Candidate"].includes(userRole)) {
    return res.redirect("/login");
  }

  try {
    // Get current user
    const userResult = await pool.query("SELECT * FROM users WHERE id = $1", [userId]);

    if (userResult.rows.length === 0) {
      return res.status(404).send("User not found");
    }

    const electionId = userResult.rows[0].election_id;

    // Fetch voters for the same election
    const votersResult = await pool.query(
      `SELECT auth.username, users.first_name, users.middle_name, users.last_name, 
              COALESCE(elections.election, 'No Election') AS election
       FROM auth
       JOIN users ON auth.user_id = users.id
       LEFT JOIN elections ON users.election_id = elections.id
       WHERE users.election_id = $1`,
      [electionId]
    );

    if (votersResult.rows.length === 0) {
      return res.status(404).send("No voter records found.");
    }

    // Define CSV fields
    const fields = ["username", "first_name", "middle_name", "last_name", "election"];
    const parser = new Parser({ fields });
    const csv = parser.parse(votersResult.rows);

    // Set headers and send CSV
    res.header("Content-Type", "text/csv");
    res.attachment("voters-data.csv");
    res.send(csv);
  } catch (error) {
    console.error("Error generating CSV:", error);
    res.status(500).send("An error occurred while generating the CSV.");
  }
});

router.get("/download/voters/pdf", async (req, res) => {
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

    const voterResult = await pool.query(
      `SELECT auth.*, users.*, COALESCE(elections.election, 'No Election') AS election
       FROM auth
       JOIN users ON auth.user_id = users.id
       LEFT JOIN elections ON users.election_id = elections.id
       WHERE users.election_id = $1`,
      [electionId]
    );

    const voters = voterResult.rows;
    if (voters.length === 0) {
      return res.status(404).send("No voter data found");
    }

    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const filename = "voters-record.pdf";

    res.setHeader("Content-disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-type", "application/pdf");

    doc.pipe(res);

    // Title
    doc
      .fontSize(18)
      .text(voters[0].election, { align: "center" })
      .moveDown(0.5)
      .text("Voters Record", { align: "center", underline: true });

    doc.moveDown(1.5);

    // Table headers
    const tableTop = doc.y;
    const rowHeight = 25;
    const colTitles = ["#", "First Name", "Middle Name", "Last Name"];
    const colWidths = [40, 130, 130, 130];

    colTitles.forEach((title, i) => {
      doc
        .font("Helvetica-Bold")
        .fontSize(12)
        .text(title, 50 + colWidths.slice(0, i).reduce((a, b) => a + b, 0), tableTop, {
          width: colWidths[i],
          align: "center",
        });
    });

    let y = tableTop + rowHeight;

    voters.forEach((voter, index) => {
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
          .text(String(val), 50 + colWidths.slice(0, i).reduce((a, b) => a + b, 0), y, {
            width: colWidths[i],
            align: "center",
          });
      });

      y += rowHeight;

      // If close to page bottom, add new page
      if (y > 750) {
        doc.addPage();
        y = 50;
      }
    });

    doc.end();
  } catch (err) {
    console.error("Error generating voters PDF:", err);
    return res.status(500).send("An error occurred while generating the PDF.");
  }
});

module.exports = router