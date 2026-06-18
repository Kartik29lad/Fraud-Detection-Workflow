import { Router } from 'express';
import * as sql from 'mssql';
import { getPool } from '../../db/pool';
import logger from '../../logger';

export const adminRouter = Router();

// POST /api/failures/booking
adminRouter.post('/failures/booking', async (req, res) => {
  try {
    const { agentId, bookingId, failureReason } = req.body;
    if (!agentId) return res.status(400).json({ error: 'agentId required' });

    const pool = await getPool();
    const ip   = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
                 || req.socket.remoteAddress || null;

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

// POST /api/failures/payment
adminRouter.post('/failures/payment', async (req, res) => {
  try {
    const { agentId, bookingId, amount, failureReason } = req.body;
    if (!agentId) return res.status(400).json({ error: 'agentId required' });

    const pool = await getPool();
    const ip   = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
                 || req.socket.remoteAddress || null;

    await pool.request()
      .input('agentId',       sql.UniqueIdentifier, agentId)
      .input('bookingId',     sql.UniqueIdentifier, bookingId || null)
      .input('amount',        sql.Decimal(10, 2),   amount || null)
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

// POST /api/ip-blacklist/add
adminRouter.post('/ip-blacklist/add', async (req, res) => {
  try {
    const { ipAddress, reason, source } = req.body;
    if (!ipAddress) return res.status(400).json({ error: 'ipAddress required' });

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

// POST /api/admin/chargeback
adminRouter.post('/chargeback', async (req, res) => {
  try {
    const { agentId, bookingId, amount, reason } = req.body;
    if (!agentId) return res.status(400).json({ error: 'agentId required' });

    const pool = await getPool();

    await pool.request()
      .input('agentId',   sql.UniqueIdentifier, agentId)
      .input('bookingId', sql.UniqueIdentifier, bookingId || null)
      .input('amount',    sql.Decimal(10, 2),   amount || null)
      .input('reason',    sql.NVarChar(300),    reason || null)
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

// POST /api/baseline/recalculate
adminRouter.post('/baseline/recalculate', async (req, res) => {
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