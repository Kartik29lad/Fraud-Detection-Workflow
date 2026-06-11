import * as sql from 'mssql';
import { FraudReviewResult } from './types';

export async function persistFraudResult(
  result:   FraudReviewResult,
  pool:     sql.ConnectionPool,
  reviewId: string,
): Promise<void> {

  const bookingStatus = actionToStatus(result.actionTaken);
  const shouldReview  = result.totalScore >= 40;

  // 1. Update booking
  await pool.request()
    .input('score',     sql.Int,              result.totalScore)
    .input('status',    sql.VarChar(20),      bookingStatus)
    .input('bookingId', sql.UniqueIdentifier, result.bookingId)
    .query(`
      UPDATE dbo.bookings
      SET risk_score = @score,
          status     = @status
      WHERE booking_id = @bookingId
    `);

  // 2. Insert fraud signals
  for (const signal of result.firedSignals) {
    console.log('INSERTING SIGNAL:', signal.signalType);
    await pool.request()
      .input('bookingId',    sql.UniqueIdentifier,  result.bookingId)
      .input('agentId',      sql.UniqueIdentifier,  result.agentId)
      .input('signalType',   sql.VarChar(50),       signal.signalType)
      .input('signalValue',  sql.NVarChar(sql.MAX), JSON.stringify({ reason: signal.reason, ...signal.detail }))
      .input('scoreContrib', sql.Int,               signal.scoreContrib)
      .query(`
        INSERT INTO dbo.fraud_signals
          (signal_id, booking_id, agent_id, signal_type, signal_value, score_contrib, fired_at)
        VALUES
          (NEWID(), @bookingId, @agentId, @signalType, @signalValue, @scoreContrib, SYSDATETIMEOFFSET())
      `);
  }

  // 3. Insert fraud review
  if (shouldReview) {
    await pool.request()
      .input('reviewId',       sql.UniqueIdentifier,  reviewId)
      .input('bookingId',      sql.UniqueIdentifier,  result.bookingId)
      .input('agentId',        sql.UniqueIdentifier,  result.agentId)
      .input('totalScore',     sql.Int,               result.totalScore)
      .input('riskLevel',      sql.VarChar(20),       result.riskLevel)
      .input('triggeredRules', sql.NVarChar(sql.MAX), JSON.stringify(result.firedSignals.map(s => s.signalType)))
      .input('actionTaken',    sql.VarChar(30),       result.actionTaken)
      .query(`
        INSERT INTO dbo.fraud_reviews
          (review_id, booking_id, agent_id, total_score, risk_level,
           triggered_rules, action_taken, created_at)
        VALUES
          (@reviewId, @bookingId, @agentId, @totalScore, @riskLevel,
           @triggeredRules, @actionTaken, SYSDATETIMEOFFSET())
      `);
  }

  // 3b. Link review back to booking
 await pool.request()
  .input('score',     sql.Int,              result.totalScore)
  .input('status',    sql.VarChar(20),      bookingStatus)
  .input('reviewId',  sql.UniqueIdentifier, shouldReview ? reviewId : null)
  .input('bookingId', sql.UniqueIdentifier, result.bookingId)
  .query(`
    UPDATE dbo.bookings
    SET risk_score      = @score,
        status          = @status,
        fraud_review_id = @reviewId
    WHERE booking_id = @bookingId
  `);

 // 4b. Update agent status
if (result.actionTaken === 'auto_suspend') {
  await pool.request()
    .input('agentId', sql.UniqueIdentifier, result.agentId)
    .query(`
      UPDATE dbo.agents
      SET status     = 'suspended',
          updated_at = SYSDATETIMEOFFSET()
      WHERE source_id = @agentId
    `);
} else if (result.actionTaken === 'hold') {
  await pool.request()
    .input('agentId', sql.UniqueIdentifier, result.agentId)
    .query(`
      UPDATE dbo.agents
      SET status     = 'identity_verification',
          updated_at = SYSDATETIMEOFFSET()
      WHERE source_id = @agentId
    `);
} else if (result.actionTaken === 'block') {
  await pool.request()
    .input('agentId', sql.UniqueIdentifier, result.agentId)
    .query(`
      UPDATE dbo.agents
      SET status     = 'under_review',
          updated_at = SYSDATETIMEOFFSET()
      WHERE source_id = @agentId
    `);
}

  // 4. Insert suspension log
  if (result.actionTaken === 'auto_suspend') {
    await pool.request()
      .input('agentId',   sql.UniqueIdentifier, result.agentId)
      .input('bookingId', sql.UniqueIdentifier, result.bookingId)
      .input('reviewId',  sql.UniqueIdentifier, shouldReview ? reviewId : null)
      .input('score',     sql.Int,              result.totalScore)
      .input('reason',    sql.NVarChar(500),    result.primaryReason)
      .query(`
        INSERT INTO dbo.agent_suspension_log
          (suspension_id, agent_id, event_type, triggered_by,
           trigger_booking_id, trigger_review_id,
           risk_score_at_event, reason, performed_by, event_at)
        VALUES
          (NEWID(), @agentId, 'suspended', 'system',
           @bookingId, @reviewId,
           @score, @reason, 'system', SYSDATETIMEOFFSET())
      `);
  }

  // 5. Audit log
  await pool.request()
    .input('bookingId', sql.UniqueIdentifier,  result.bookingId)
    .input('action',    sql.VarChar(50),       `fraud_scored_${result.actionTaken}`)
    .input('newValue',  sql.NVarChar(sql.MAX), JSON.stringify({
      totalScore:    result.totalScore,
      riskLevel:     result.riskLevel,
      actionTaken:   result.actionTaken,
      signalCount:   result.firedSignals.length,
      comboCount:    result.firedCombos.length,
      primaryReason: result.primaryReason,
    }))
    .query(`
      INSERT INTO dbo.audit_log
        (entity_type, entity_id, action, new_value, performed_by, performed_at)
      VALUES
        ('booking', @bookingId, @action, @newValue, 'fraud_scorer', SYSDATETIMEOFFSET())
    `);
}

function actionToStatus(action: string): string {
  switch (action) {
    case 'auto_suspend':  return 'blocked';
    case 'hold':          return 'held';
    case 'block':         return 'blocked';
    case 'flag_review':   return 'flagged';
    default:              return 'confirmed';
  }
}