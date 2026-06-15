  import express from "express";
  import cors from 'cors';
  import { getPool } from "./db";
  import { evaluateBookingFraud } from "./fraudEngine";
  import { BookingInput } from "./types";
  import { randomUUID } from "crypto";
  import * as sql from 'mssql';
  import * as dotenv from 'dotenv';
  import rateLimit from 'express-rate-limit';
  import logger from './logger';

  import { requireApiKey, validateDecision, generateExpiryToken, verifyExpiryToken, validateBookingSource, generateOTP } from './middleware';
  const app = express();
  app.use(cors({
    origin: 'http://localhost:3001',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-api-key', 'x-booking-source'],
  }));

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  // Rate limiter — max 10 requests per 15 minutes per IP
  const scoreLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10,
    message: {
      error: 'Too Many Requests',
      message: 'Max 10 booking score requests per 15 minutes. Try again later.'
    },
    standardHeaders: true,
    legacyHeaders: false,
  });

  app.use('/api/booking/score', scoreLimiter);

  // Apply API key to all /api routes
  app.use('/api', requireApiKey);

  // Health check
  // Health check
  app.get("/", async (req, res) => {
    try {
      const pool = await getPool();
      await pool.request().query('SELECT 1 AS db_check');
      return res.json({
        status: "healthy",
        api: "running",
        db: "connected",
        timestamp: new Date().toISOString()
      });
    } catch (err: any) {
      return res.status(503).json({
        status: "unhealthy",
        api: "running",
        db: "disconnected",
        error: err.message,
        timestamp: new Date().toISOString()
      });
    }
  });

  // Fraud queue endpoint for n8n
  app.get("/api/fraud-queue", async (req, res) => {
    try {
      const pool = await getPool();
      const result = await pool.request().query(`
        SELECT TOP 10
          r.review_id,
          r.booking_id,
          r.agent_id,
          r.total_score,
          r.risk_level,
          r.action_taken,
          r.triggered_rules,
          (DATEDIFF(day, b.check_in, b.check_out) * b.amount_per_night) AS total_amount
        FROM dbo.fraud_reviews r
        JOIN dbo.bookings b ON r.booking_id = b.booking_id
        WHERE r.reviewed_at IS NULL
          AND r.notified_at IS NULL
        ORDER BY r.total_score DESC
      `);

      

      // --- NEW TOKEN LOGIC START ---
      // Attach a 30-minute self-destruct token to each case
      const casesWithTokens = result.recordset.map((review: any) => {
        // 30 minutes in milliseconds (30 * 60 * 1000 = 1800000)
        const expiresAt = Date.now() + 1800000; 
        const secureToken = generateExpiryToken(review.review_id, expiresAt);

        return {
          ...review,
          link_token: secureToken,
          link_expires: expiresAt
        };
      });

    // Mark all fetched cases as notified immediately
      for (const review of result.recordset) {
        await pool.request()
          .input('reviewId', sql.UniqueIdentifier, review.review_id)
          .query(`
            UPDATE dbo.fraud_reviews
            SET notified_at = SYSDATETIMEOFFSET()
            WHERE review_id = @reviewId
              AND notified_at IS NULL
          `);
      }

      return res.json({ cases: casesWithTokens });
      // --- NEW TOKEN LOGIC END ---

    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });
  // Main scoring endpoint
  app.post("/api/booking/score", validateBookingSource, async (req, res) => {
    try {
      const {
  agentId,
  propertyId,
  guestNationality,
  checkIn,
  checkOut,
  amountPerNight,
  guestEmail,
  passengerName,
  roomCount,
  guestPhone,
  passportNumber,   
  visaNumber,       
  docExpiry,        
} = req.body;;

      if (
        !agentId ||
        !propertyId ||
        !guestNationality ||
        !checkIn ||
        !checkOut ||
        !amountPerNight
      ) {
        return res.status(400).json({
          error: "Missing required fields",
          required: [
            "agentId",
            "propertyId",
            "guestNationality",
            "checkIn",
            "checkOut",
            "amountPerNight",
          ],
        });
      }

 const booking: BookingInput = {
  bookingId:        randomUUID(),
  agentId,
  propertyId,
  guestNationality,
  guestEmail:       guestEmail || null,
  checkIn:          new Date(checkIn),
  checkOut:         new Date(checkOut),
  amountPerNight:   Number(amountPerNight),
  bookedAt:         new Date(),
  passengerName:    passengerName || '',
  roomCount:        Number(roomCount) || 1,
  guestPhone:       guestPhone || '',
  ipAddress:        (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
                    || req.socket.remoteAddress
                    || null,
  sessionId:        req.headers['x-session-id'] as string || null,
  passportNumber:   passportNumber || null,
  visaNumber:       visaNumber || null,
  docExpiry:        docExpiry ? new Date(docExpiry) : null,

};

const pool = await getPool();

      // Verify agent exists
  const agentCheck = await pool.request()
    .input('agentId', sql.UniqueIdentifier, booking.agentId)
    .query(`SELECT source_id, status FROM dbo.agents WHERE source_id = @agentId`);

  if (agentCheck.recordset.length === 0) {
    return res.status(400).json({
      error: 'Invalid Agent',
      message: `Agent ID ${booking.agentId} does not exist`
    });
  }

  if (agentCheck.recordset[0].status !== 'active') {
    return res.status(403).json({
      error: 'Agent Not Active',
      message: `Agent is ${agentCheck.recordset[0].status} — booking rejected`
    });
  }

  // Verify property exists
  const propertyCheck = await pool.request()
    .input('propertyId', sql.UniqueIdentifier, booking.propertyId)
    .query(`SELECT property_id FROM dbo.properties WHERE property_id = @propertyId AND is_active = 1`);

  if (propertyCheck.recordset.length === 0) {
    return res.status(404).json({
      error: 'Property Not Found',
      message: `Property ID ${booking.propertyId} does not exist or is inactive`
    });
  }

  // Insert booking into DB first
  await pool.request()
    .input('bookingId',        sql.UniqueIdentifier, booking.bookingId)
    .input('agentId',          sql.UniqueIdentifier, booking.agentId)
    .input('propertyId',       sql.UniqueIdentifier, booking.propertyId)
    .input('guestNationality', sql.Char(2),          booking.guestNationality)
    .input('checkIn',          sql.Date,             booking.checkIn)
    .input('checkOut',         sql.Date,             booking.checkOut)
    .input('amountPerNight',   sql.Decimal(10,2),    booking.amountPerNight)
    .input('bookedAt',         sql.DateTimeOffset,   booking.bookedAt)
    .input('guestEmail',       sql.NVarChar(150),    booking.guestEmail)
    .input('passportNumber',   sql.NVarChar(50),     booking.passportNumber)
    .input('visaNumber',       sql.NVarChar(50),     booking.visaNumber)
    .input('docExpiry',        sql.Date,             booking.docExpiry)
    .query(`
      INSERT INTO dbo.bookings
        (booking_id, agent_id, property_id, guest_nationality,
         check_in, check_out, amount_per_night, booked_at,
         status, risk_score, guest_email,
         passport_number, visa_number, doc_expiry)
      VALUES
        (@bookingId, @agentId, @propertyId, @guestNationality,
         @checkIn, @checkOut, @amountPerNight, @bookedAt,
         'pending', 0, @guestEmail,
         @passportNumber, @visaNumber, @docExpiry)
    `);

  // Now score it
  const result = await evaluateBookingFraud(booking, pool, {
    skipPersist: false,
  });

      // Send to n8n webhook
      try {
        const http = require("http");
        const postData = JSON.stringify({
          bookingId: result.bookingId,
          score: result.totalScore,
          riskLevel: result.riskLevel,
          action: result.actionTaken,
          nights: result.nights,
          totalAmount: result.totalAmount,
          primaryReason: result.primaryReason,
          recommendation: result.recommendation,
          signalsFired: result.firedSignals.length,
        });

        const options = {
          hostname: "127.0.0.1",
          port: 5678,
          path: "/webhook-test/fraud-alert",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(postData),
          },
        };

        const req2 = http.request(options, (res2: any) => {
          res2.on("data", () => {});
          res2.on("end", () => logger.info('n8n notified', { bookingId: result.bookingId }));
        });
        req2.on("error", (e: any) => logger.warn('n8n webhook error', { error: e.message }));
        req2.write(postData);
        req2.end();
      } catch (e: any) {
    logger.warn('n8n webhook error', { error: e.message });
  }

      return res.json({
        bookingId: result.bookingId,
        score: result.totalScore,
        riskLevel: result.riskLevel,
        action: result.actionTaken,
        nights: result.nights,
        totalAmount: result.totalAmount,
        primaryReason: result.primaryReason,
        signalsFired: result.firedSignals.length,
        combosFired: result.firedCombos.length,
        signals: result.firedSignals.map((s) => ({
          type: s.signalType,
          score: s.scoreContrib,
          reason: s.reason,
        })),
        recommendation: result.recommendation,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // Get booking status — polled by frontend
app.get('/api/booking/:bookingId/status', async (req, res) => {
  try {
    const { bookingId } = req.params;
    const pool = await getPool();
    const result = await pool.request()
      .input('bookingId', sql.UniqueIdentifier, bookingId)
      .query(`SELECT status FROM dbo.bookings WHERE booking_id = @bookingId`);

    if (result.recordset.length === 0) return res.status(404).json({ error: 'Booking not found' });
    return res.json({ status: result.recordset[0].status });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Mark case as notified � called by n8n after sending email
app.post('/api/fraud-review/notified', async (req, res) => {
  try {
    const { reviewId } = req.body;
    const pool = await getPool();
    
    await pool.request()
      .input('reviewId', sql.UniqueIdentifier, reviewId)
      .query(`
        UPDATE dbo.fraud_reviews
        SET notified_at = SYSDATETIMEOFFSET()
        WHERE review_id = @reviewId
      `);
    return res.json({ success: true, reviewId });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

  // Recalculate agent baselines — called by n8n nightly
  app.post('/api/baseline/recalculate', async (req, res) => {
    try {
      const pool = await getPool();
      await pool.request().query(`EXEC dbo.usp_RecalculateAgentBaseline`);
      logger.info('Agent baselines recalculated');
      return res.json({ success: true, recalculatedAt: new Date().toISOString() });
    } catch (err: any) {
      logger.error('Baseline recalculation failed', { error: err.message });
      return res.status(500).json({ error: err.message });
    }
  });

  // Send OTP to manager — called when manager clicks email link
  app.post('/api/manager/send-otp', async (req, res) => {
    try {
      const { reviewId, decision, token, expires } = req.body;

      if (!reviewId || !decision || !token || !expires) {
        return res.status(400).json({ error: 'Missing parameters' });
      }

      if (!validateDecision(decision)) {
        return res.status(400).json({ error: 'Invalid decision' });
      }

      const expiresTimestamp = parseInt(expires, 10);
      const isValidToken = verifyExpiryToken(reviewId, token, expiresTimestamp);
      if (!isValidToken) {
        return res.status(403).json({ error: 'Link expired or invalid' });
      }

      const pool = await getPool();
      const otp = generateOTP();
      const otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

      // Save OTP to DB
      await pool.request()
        .input('reviewId',  sql.UniqueIdentifier, reviewId)
        .input('otpCode',   sql.VarChar(6),       otp)
        .input('expiresAt', sql.DateTimeOffset,   otpExpiry)
        .query(`
          INSERT INTO dbo.manager_otps (review_id, otp_code, expires_at)
          VALUES (@reviewId, @otpCode, @expiresAt)
        `);

      logger.info('OTP generated for manager', { reviewId });

      // TODO: Send OTP via email (integrate with your email provider)
      // For now log it for testing
      logger.info('OTP CODE FOR TESTING', { otp, reviewId });

      return res.json({ success: true, message: 'OTP sent to manager email' });

    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // Manager Action Endpoint (Clicked from Email)
  app.get("/fraud-review/action", async (req, res) => {
    try {
      // 1. Extract token and expires from the URL query
      const { reviewId, decision, token, expires } = req.query;
      
      // 2. Check if anything is missing
      if (!reviewId || !decision || !token || !expires) {
        return res.status(400).send("Critical error: Missing validation parameters in link.");
      }

      // 3. Whitelist check (You already did this!)
      if (!validateDecision(decision as string)) {
        return res.status(400).send("Invalid decision. Allowed: approve_block, false_positive");
      }

      // --- NEW TOKEN SECURITY CHECK START ---
      // 4. Verify the link hasn't expired and hasn't been tampered with
      const expiresTimestamp = parseInt(expires as string, 10);
      const isValidToken = verifyExpiryToken(reviewId as string, token as string, expiresTimestamp);

      if (!isValidToken) {
        return res.status(403).send(`
          <div style="font-family: sans-serif; padding: 40px; text-align: center; color: #d9534f;">
            <h2>🚨 Link Expired or Invalid</h2>
            <p>For security, manager action links expire after 30 minutes.</p>
            <p>Please log in to the dashboard to action this case manually.</p>
          </div>
        `);
      }
      // --- NEW TOKEN SECURITY CHECK END ---

      // const pool = await getPool();
      // let newStatus = decision === 'approve_block' ? 'blocked' : 'confirmed';
      // let notes = decision === 'approve_block' ? 'Manager approved block' : 'Manager marked as false positive';

      // --- NEW TOKEN SECURITY CHECK END ---

      const pool = await getPool();
  logger.info('Reached pool — about to check replay', { reviewId, token });

      // --- REPLAY ATTACK PROTECTION START ---

      // --- REPLAY ATTACK PROTECTION START ---
      const tokenHash = require('crypto')
        .createHash('sha256')
        .update(token as string)
        .digest('hex');

      const tokenCheck = await pool.request()
        .input('tokenHash', sql.VarChar(64), tokenHash)
        .query(`SELECT token_hash FROM dbo.used_tokens WHERE token_hash = @tokenHash`);

      if (tokenCheck.recordset.length > 0) {
        return res.status(403).send(`
          <div style="font-family: sans-serif; padding: 40px; text-align: center; color: #d9534f;">
            <h2>🚨 Link Already Used</h2>
            <p>This action link has already been used.</p>
            <p>Please log in to the dashboard to action this case manually.</p>
          </div>
        `);
      }

      // const expiresDate = new Date(expiresTimestamp);
      // await pool.request()
      //   .input('tokenHash', sql.VarChar(64),     tokenHash)
      //   .input('reviewId',  sql.UniqueIdentifier, reviewId)
      //   .input('expiresAt', sql.DateTimeOffset,   expiresDate)
      //   .query(`
      //     INSERT INTO dbo.used_tokens (token_hash, review_id, expires_at)
      //     VALUES (@tokenHash, @reviewId, @expiresAt)
      //   `);

      const expiresDate = new Date(expiresTimestamp);
      try {
        await pool.request()
          .input('tokenHash', sql.VarChar(64),      tokenHash)
          .input('reviewId',  sql.UniqueIdentifier,  reviewId)
          .input('expiresAt', sql.DateTimeOffset,    expiresDate)
          .query(`
            INSERT INTO dbo.used_tokens (token_hash, review_id, expires_at)
            VALUES (@tokenHash, @reviewId, @expiresAt)
          `);
        logger.info('Token marked as used', { tokenHash, reviewId });
      } catch (insertErr: any) {
        logger.error('Failed to save used token', { error: insertErr.message });
      }
    // --- REPLAY ATTACK PROTECTION END ---

      // Generate OTP and show form
      const otp = generateOTP();
      const otpExpiry = new Date(Date.now() + 10 * 60 * 1000);

      await pool.request()
        .input('reviewId',  sql.UniqueIdentifier, reviewId)
        .input('otpCode',   sql.VarChar(6),       otp)
        .input('expiresAt', sql.DateTimeOffset,   otpExpiry)
        .query(`
          INSERT INTO dbo.manager_otps (review_id, otp_code, expires_at)
          VALUES (@reviewId, @otpCode, @expiresAt)
        `);

      logger.info('OTP generated for manager action', { reviewId, otp });

      return res.send(`
        <div style="font-family: sans-serif; padding: 40px; max-width: 400px; margin: 0 auto;">
          <h2>🔐 Verify Your Identity</h2>
          <p>A 6-digit OTP has been sent to your email.</p>
          <p style="color: #888; font-size: 13px;">Check server logs for OTP (testing mode).</p>
          <form method="POST" action="/fraud-review/verify-otp">
            <input type="hidden" name="reviewId" value="${reviewId}" />
            <input type="hidden" name="decision" value="${decision}" />
            <input type="text" name="otpCode" placeholder="Enter 6-digit OTP"
              style="width:100%; padding:10px; font-size:24px; margin:10px 0; text-align:center; letter-spacing:8px; border:1px solid #ccc; border-radius:5px;" maxlength="6" />
            <button type="submit"
              style="width:100%; padding:12px; background:#d9534f; color:white; border:none; font-size:16px; cursor:pointer; border-radius:5px; margin-top:10px;">
              Confirm Action
            </button>
          </form>
        </div>
      `);

    } catch (err: any) {
      return res.status(500).send(`Error: ${err.message}`);
    }
  });

  // OTP verification — manager submits OTP form
  app.post('/fraud-review/verify-otp', async (req, res) => {
    try {
      const { reviewId, decision, otpCode } = req.body;

      if (!reviewId || !decision || !otpCode) {
        return res.status(400).send('Missing parameters.');
      }

      if (!validateDecision(decision)) {
        return res.status(400).send('Invalid decision.');
      }

      const pool = await getPool();

      // Check OTP valid and not expired and not used
      const otpCheck = await pool.request()
        .input('reviewId', sql.UniqueIdentifier, reviewId)
        .input('otpCode',  sql.VarChar(6),       otpCode)
        .query(`
          SELECT otp_id FROM dbo.manager_otps
          WHERE review_id = @reviewId
            AND otp_code  = @otpCode
            AND used      = 0
            AND expires_at > SYSDATETIMEOFFSET()
        `);

      if (otpCheck.recordset.length === 0) {
        return res.status(403).send(`
          <div style="font-family: sans-serif; padding: 40px; text-align: center; color: #d9534f;">
            <h2>❌ Invalid or Expired OTP</h2>
            <p>OTP is wrong or has expired. Please request a new link.</p>
          </div>
        `);
      }

      // Mark OTP as used
      await pool.request()
        .input('otpId', sql.UniqueIdentifier, otpCheck.recordset[0].otp_id)
        .query(`UPDATE dbo.manager_otps SET used = 1 WHERE otp_id = @otpId`);

      // Execute action
      const newStatus = decision === 'approve_block' ? 'blocked' : 'confirmed';
      const notes = decision === 'approve_block' ? 'Manager approved block' : 'Manager marked as false positive';

      await pool.request()
        .input('reviewId', sql.UniqueIdentifier, reviewId)
        .input('notes',    sql.Text,             notes)
        .query(`
          UPDATE dbo.fraud_reviews
          SET reviewed_at = SYSDATETIMEOFFSET(),
              reviewed_by = 'manager_email_action',
              notes = @notes
          WHERE review_id = @reviewId
        `);

      await pool.request()
        .input('reviewId', sql.UniqueIdentifier, reviewId)
        .input('status',   sql.VarChar(20),      newStatus)
        .query(`
          UPDATE dbo.bookings
          SET status = @status
          WHERE fraud_review_id = @reviewId
        `);

    logger.info('Manager action completed via OTP', { reviewId, decision });

      // Send notifications if booking blocked
      if (decision === 'approve_block') {
        try {
          // Fetch agent email and guest email
          const emailData = await pool.request()
            .input('reviewId', sql.UniqueIdentifier, reviewId)
            .query(`
              SELECT 
                a.email        AS agent_email,
                a.full_name    AS agent_name,
                b.guest_email  AS guest_email,
                b.booking_id,
                b.check_in,
                b.check_out
              FROM dbo.fraud_reviews r
              JOIN dbo.bookings b ON b.fraud_review_id = r.review_id
              JOIN dbo.agents a   ON a.source_id = r.agent_id
              WHERE r.review_id = @reviewId
            `);

          if (emailData.recordset.length > 0) {
            const row = emailData.recordset[0];

            // Send to n8n for email delivery
            const http = require('http');
            const postData = JSON.stringify({
              type:        'block_notification',
              agentEmail:  row.agent_email,
              agentName:   row.agent_name,
              guestEmail:  row.guest_email,
              bookingId:   row.booking_id,
              checkIn:     row.check_in,
              checkOut:    row.check_out,
              reviewId:    reviewId,
            });

            const options = {
              hostname: '127.0.0.1',
              port:     5678,
              path:     '/webhook/block-notification',
              method:   'POST',
              headers:  {
                'Content-Type':   'application/json',
                'Content-Length': Buffer.byteLength(postData),
              },
            };

            const req2 = http.request(options);
            req2.on('error', (e: any) => logger.warn('n8n block notification error', { error: e.message }));
            req2.write(postData);
            req2.end();

            logger.info('Block notification sent to n8n', { reviewId });
          }
        } catch (notifyErr: any) {
          logger.warn('Failed to send block notifications', { error: notifyErr.message });
        }
      }

      return res.send(`
        <div style="font-family: sans-serif; padding: 40px; text-align: center;">
          <h2>✅ Success!</h2>
          <p>The booking has been marked as: <strong>${decision}</strong>.</p>
          <p>Identity verified. Database updated. You can close this window.</p>
        </div>
      `);

    } catch (err: any) {
      return res.status(500).send(`Error: ${err.message}`);
    }
  });

  // ── Rule 14: Log failed booking attempt ──────────────────
app.post('/api/failures/booking', async (req, res) => {
  try {
    const { agentId, bookingId, failureReason } = req.body;

    if (!agentId) {
      return res.status(400).json({ error: 'agentId required' });
    }

    const pool = await getPool();
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
               || req.socket.remoteAddress
               || null;

    await pool.request()
      .input('agentId',       sql.UniqueIdentifier, agentId)
      .input('bookingId',     sql.UniqueIdentifier, bookingId || null)
      .input('failureReason', sql.NVarChar(300),    failureReason || null)
      .input('ip',            sql.VarChar(45),      ip)
      .query(`
        INSERT INTO dbo.booking_failures
          (agent_id, booking_id, failure_reason, ip_address, failed_at)
        VALUES
          (@agentId, @bookingId, @failureReason, @ip, SYSDATETIMEOFFSET())
      `);

    logger.info('Booking failure logged', { agentId, failureReason });
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Rule 51: Log failed payment attempt ──────────────────
app.post('/api/failures/payment', async (req, res) => {
  try {
    const { agentId, bookingId, amount, failureReason } = req.body;

    if (!agentId) {
      return res.status(400).json({ error: 'agentId required' });
    }

    const pool = await getPool();
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
               || req.socket.remoteAddress
               || null;

    await pool.request()
      .input('agentId',       sql.UniqueIdentifier, agentId)
      .input('bookingId',     sql.UniqueIdentifier, bookingId || null)
      .input('amount',        sql.Decimal(10,2),    amount || null)
      .input('failureReason', sql.NVarChar(300),    failureReason || null)
      .input('ip',            sql.VarChar(45),      ip)
      .query(`
        INSERT INTO dbo.payment_failures
          (agent_id, booking_id, amount, failure_reason, ip_address, failed_at)
        VALUES
          (@agentId, @bookingId, @amount, @failureReason, @ip, SYSDATETIMEOFFSET())
      `);

    logger.info('Payment failure logged', { agentId, failureReason });
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Rule 28: Add IP to blacklist ─────────────────────────
app.post('/api/ip-blacklist/add', async (req, res) => {
  try {
    const { ipAddress, reason, source } = req.body;

    if (!ipAddress) {
      return res.status(400).json({ error: 'ipAddress required' });
    }

    const pool = await getPool();

    await pool.request()
      .input('ip',     sql.VarChar(45),   ipAddress)
      .input('reason', sql.NVarChar(300), reason || null)
      .input('source', sql.VarChar(50),   source || 'manual')
      .query(`
        INSERT INTO dbo.ip_blacklist
          (ip_address, reason, source, is_active, added_at)
        VALUES
          (@ip, @reason, @source, 1, SYSDATETIMEOFFSET())
      `);

    logger.info('IP blacklisted', { ipAddress, reason });
    return res.json({ success: true, ipAddress });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});
 // Unactioned cases — for reminder workflow
  app.get('/api/fraud-queue/unactioned', async (req, res) => {
    try {
      const pool = await getPool();
      const result = await pool.request().query(`
        SELECT TOP 10
          r.review_id,
          r.booking_id,
          r.agent_id,
          r.total_score,
          r.risk_level,
          r.action_taken,
          r.triggered_rules,
          r.notified_at,
          DATEDIFF(HOUR, r.notified_at, SYSDATETIMEOFFSET()) AS hours_since_notified,
          (DATEDIFF(day, b.check_in, b.check_out) * b.amount_per_night) AS total_amount
        FROM dbo.fraud_reviews r
        JOIN dbo.bookings b ON r.booking_id = b.booking_id
        WHERE r.reviewed_at IS NULL
          AND r.notified_at IS NOT NULL
          AND DATEDIFF(HOUR, r.notified_at, SYSDATETIMEOFFSET()) >= 4
        ORDER BY r.total_score DESC
      `);

     const casesWithTokens = result.recordset.map((review: any) => {
  const expiresAt = Date.now() + 1800000;
  const secureToken = generateExpiryToken(review.review_id, expiresAt);
  return {
    ...review,
    link_token: secureToken,
    link_expires: expiresAt
  };
});

return res.json({ cases: casesWithTokens });
} catch (err: any) {
  return res.status(500).json({ error: err.message });
}
});

// ── Admin: Log chargeback (Rule 53) ──────────────────────
app.post('/api/admin/chargeback', async (req, res) => {
  try {
    const { agentId, bookingId, amount, reason } = req.body;

    if (!agentId) {
      return res.status(400).json({ error: 'agentId required' });
    }

    const pool = await getPool();

    await pool.request()
      .input('agentId',   sql.UniqueIdentifier, agentId)
      .input('bookingId', sql.UniqueIdentifier, bookingId || null)
      .input('amount',    sql.Decimal(10,2),    amount    || null)
      .input('reason',    sql.NVarChar(300),    reason    || null)
      .query(`
        INSERT INTO dbo.chargebacks
          (agent_id, booking_id, amount, reason, status, reported_at)
        VALUES
          (@agentId, @bookingId, @amount, @reason, 'open', SYSDATETIMEOFFSET())
      `);

    logger.info('Chargeback logged', { agentId, reason });
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});
  const PORT = 3000;
  app.listen(PORT, async () => {
    await getPool();
  logger.info(`Fraud Detection API running on http://localhost:${PORT}`);
  });


 