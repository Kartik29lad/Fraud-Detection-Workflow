import { Router } from 'express';
import * as sql from 'mssql';
import * as crypto from 'crypto';
import { getPool } from '../../db/pool';
import { validateDecision, generateExpiryToken, verifyExpiryToken, generateOTP } from '../../middleware';
import logger from '../../logger';

export const managerRouter = Router();

// GET /fraud-review/action
managerRouter.get('/action', async (req, res) => {
  try {
    const { reviewId, decision, token, expires } = req.query;

    if (!reviewId || !decision || !token || !expires) {
      return res.status(400).send('Critical error: Missing validation parameters in link.');
    }

    if (!validateDecision(decision as string)) {
      return res.status(400).send('Invalid decision. Allowed: approve_block, false_positive');
    }

    const expiresTimestamp = parseInt(expires as string, 10);
    const isValidToken     = verifyExpiryToken(reviewId as string, token as string, expiresTimestamp);

    if (!isValidToken) {
      return res.status(403).send(`
        <div style="font-family: sans-serif; padding: 40px; text-align: center; color: #d9534f;">
          <h2>🚨 Link Expired or Invalid</h2>
          <p>For security, manager action links expire after 30 minutes.</p>
          <p>Please log in to the dashboard to action this case manually.</p>
        </div>
      `);
    }

    const pool = await getPool();

    // Replay attack protection
    const tokenHash = crypto.createHash('sha256').update(token as string).digest('hex');
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
    } catch (insertErr: any) {
      logger.error('Failed to save used token', { error: insertErr.message });
    }

    // Generate OTP
    const otp       = generateOTP();
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

// POST /fraud-review/verify-otp
managerRouter.post('/verify-otp', async (req, res) => {
  try {
    const { reviewId, decision, otpCode } = req.body;

    if (!reviewId || !decision || !otpCode) return res.status(400).send('Missing parameters.');
    if (!validateDecision(decision))        return res.status(400).send('Invalid decision.');

    const pool = await getPool();

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

    await pool.request()
      .input('otpId', sql.UniqueIdentifier, otpCheck.recordset[0].otp_id)
      .query(`UPDATE dbo.manager_otps SET used = 1 WHERE otp_id = @otpId`);

    const newStatus = decision === 'approve_block' ? 'blocked'
                    : decision === 'reinstate'      ? 'confirmed'
                    : 'confirmed';

    const notes = decision === 'approve_block' ? 'Manager approved block'
                : decision === 'reinstate'      ? 'Manager reinstated — false positive, agent reactivated'
                : 'Manager marked as false positive';

    await pool.request()
      .input('reviewId', sql.UniqueIdentifier, reviewId)
      .input('notes',    sql.Text,             notes)
      .query(`
        UPDATE dbo.fraud_reviews
        SET reviewed_at = SYSDATETIMEOFFSET(),
            reviewed_by = 'manager_email_action',
            notes       = @notes
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

    // Reinstate agent if needed
    if (decision === 'reinstate') {
      const reviewData = await pool.request()
        .input('reviewId', sql.UniqueIdentifier, reviewId)
        .query(`SELECT agent_id FROM dbo.fraud_reviews WHERE review_id = @reviewId`);

      if (reviewData.recordset.length > 0) {
        const agentId = reviewData.recordset[0].agent_id;

        await pool.request()
          .input('agentId', sql.UniqueIdentifier, agentId)
          .query(`
            UPDATE dbo.agents
            SET status     = 'active',
                updated_at = SYSDATETIMEOFFSET()
            WHERE source_id = @agentId
          `);

        await pool.request()
          .input('agentId',  sql.UniqueIdentifier, agentId)
          .input('reviewId', sql.UniqueIdentifier, reviewId)
          .query(`
            INSERT INTO dbo.agent_suspension_log
              (agent_id, event_type, triggered_by, trigger_review_id,
               reason, performed_by, event_at)
            VALUES
              (@agentId, 'reinstated', 'manual', @reviewId,
               'Manager reviewed and reinstated — false positive',
               'manager_email_action', SYSDATETIMEOFFSET())
          `);

        logger.info('Agent reinstated by manager', { agentId, reviewId });
      }
    }

    // Notify n8n if blocked
    if (decision === 'approve_block') {
      try {
        const emailData = await pool.request()
          .input('reviewId', sql.UniqueIdentifier, reviewId)
          .query(`
            SELECT
              a.email       AS agent_email,
              a.full_name   AS agent_name,
              b.guest_email AS guest_email,
              b.booking_id,
              b.check_in,
              b.check_out
            FROM dbo.fraud_reviews r
            JOIN dbo.bookings b ON b.fraud_review_id = r.review_id
            JOIN dbo.agents a   ON a.source_id = r.agent_id
            WHERE r.review_id = @reviewId
          `);

        if (emailData.recordset.length > 0) {
          const row      = emailData.recordset[0];
          const http     = require('http');
          const postData = JSON.stringify({
            type:       'block_notification',
            agentEmail: row.agent_email,
            agentName:  row.agent_name,
            guestEmail: row.guest_email,
            bookingId:  row.booking_id,
            checkIn:    row.check_in,
            checkOut:   row.check_out,
            reviewId,
          });

          const options = {
            hostname: '127.0.0.1',
            port:     5678,
            path:     '/webhook/block-notification',
            method:   'POST',
            headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
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

    logger.info('Manager action completed via OTP', { reviewId, decision });

    return res.send(`
      <div style="font-family: sans-serif; padding: 40px; text-align: center;">
        <h2>✅ Success!</h2>
        <p>The booking has been marked as: <strong>${
          decision === 'approve_block' ? 'Blocked' :
          decision === 'reinstate'     ? 'Reinstated — Agent Reactivated' :
          'False Positive — Confirmed'
        }</strong>.</p>
        <p>Identity verified. Database updated. You can close this window.</p>
      </div>
    `);

  } catch (err: any) {
    return res.status(500).send(`Error: ${err.message}`);
  }
});