import { Router } from 'express';
import * as sql from 'mssql';
import { getPool } from '../../db/pool';
import { generateExpiryToken } from '../../middleware';

export const fraudQueueRouter = Router();

// GET /api/fraud-queue
fraudQueueRouter.get('/', async (req, res) => {
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

    const casesWithTokens = result.recordset.map((review: any) => {
      const expiresAt   = Date.now() + 1800000;
      const secureToken = generateExpiryToken(review.review_id, expiresAt);
      return { ...review, link_token: secureToken, link_expires: expiresAt };
    });

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
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/fraud-queue/unactioned
fraudQueueRouter.get('/unactioned', async (req, res) => {
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
      const expiresAt   = Date.now() + 1800000;
      const secureToken = generateExpiryToken(review.review_id, expiresAt);
      return { ...review, link_token: secureToken, link_expires: expiresAt };
    });

    return res.json({ cases: casesWithTokens });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/fraud-review/notified
fraudQueueRouter.post('/notified', async (req, res) => {
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