import { Router } from 'express';
import * as sql from 'mssql';
import { randomUUID } from 'crypto';
import { getPool } from '../../db/pool';
import { evaluateBookingFraud } from '../../scoring/engine';
import { BookingInput } from '../../types';
import { validateBookingSource, generateExpiryToken } from '../../middleware';
import logger from '../../logger';

export const bookingRouter = Router();

// POST /api/booking/score
bookingRouter.post('/score', validateBookingSource, async (req, res) => {
  try {
    const {
      agentId, propertyId, guestNationality,
      checkIn, checkOut, amountPerNight,
      guestEmail, passengerName, roomCount,
      guestPhone, passportNumber, visaNumber, docExpiry,
    } = req.body;

    if (!agentId || !propertyId || !guestNationality || !checkIn || !checkOut || !amountPerNight) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['agentId', 'propertyId', 'guestNationality', 'checkIn', 'checkOut', 'amountPerNight'],
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

    // Verify agent exists and is active
    const agentCheck = await pool.request()
      .input('agentId', sql.UniqueIdentifier, booking.agentId)
      .query(`SELECT source_id, status FROM dbo.agents WHERE source_id = @agentId`);

    if (agentCheck.recordset.length === 0) {
      return res.status(400).json({ error: 'Invalid Agent', message: `Agent ID ${booking.agentId} does not exist` });
    }
    if (agentCheck.recordset[0].status !== 'active') {
      return res.status(403).json({ error: 'Agent Not Active', message: `Agent is ${agentCheck.recordset[0].status} — booking rejected` });
    }

    // Verify property exists
    const propertyCheck = await pool.request()
      .input('propertyId', sql.UniqueIdentifier, booking.propertyId)
      .query(`SELECT property_id FROM dbo.properties WHERE property_id = @propertyId AND is_active = 1`);

    if (propertyCheck.recordset.length === 0) {
      return res.status(404).json({ error: 'Property Not Found', message: `Property ID ${booking.propertyId} does not exist or is inactive` });
    }

    // Insert booking
    await pool.request()
      .input('bookingId',        sql.UniqueIdentifier, booking.bookingId)
      .input('agentId',          sql.UniqueIdentifier, booking.agentId)
      .input('propertyId',       sql.UniqueIdentifier, booking.propertyId)
      .input('guestNationality', sql.Char(2),          booking.guestNationality)
      .input('checkIn',          sql.Date,             booking.checkIn)
      .input('checkOut',         sql.Date,             booking.checkOut)
      .input('amountPerNight',   sql.Decimal(10, 2),   booking.amountPerNight)
      .input('bookedAt',         sql.DateTimeOffset,   booking.bookedAt)
      .input('guestEmail',       sql.NVarChar(150),    booking.guestEmail)
      .input('passportNumber',   sql.NVarChar(50),     booking.passportNumber)
      .input('visaNumber',       sql.NVarChar(50),     booking.visaNumber)
      .input('docExpiry',        sql.Date,             booking.docExpiry)
      .input('guestPhone',       sql.NVarChar(50),     booking.guestPhone)
      .query(`
        INSERT INTO dbo.bookings
          (booking_id, agent_id, property_id, guest_nationality,
           check_in, check_out, amount_per_night, booked_at,
           status, risk_score, guest_email,
           passport_number, visa_number, doc_expiry, guest_phone)
        VALUES
          (@bookingId, @agentId, @propertyId, @guestNationality,
           @checkIn, @checkOut, @amountPerNight, @bookedAt,
           'pending', 0, @guestEmail,
           @passportNumber, @visaNumber, @docExpiry, @guestPhone)
      `);

    // Score it
    const result = await evaluateBookingFraud(booking, pool, { skipPersist: false });

    // Notify n8n
    try {
      const http = require('http');
      const expiresAt = Date.now() + 1800000;

      const reviewRow = await pool.request()
        .input('bookingId', sql.UniqueIdentifier, result.bookingId)
        .query(`SELECT fraud_review_id FROM dbo.bookings WHERE booking_id = @bookingId`);

      const actualReviewId = reviewRow.recordset[0]?.fraud_review_id;
      const linkToken      = generateExpiryToken(actualReviewId, expiresAt);

      const postData = JSON.stringify({
        bookingId:      result.bookingId,
        agentId:        result.agentId,
        score:          result.totalScore,
        riskLevel:      result.riskLevel,
        action:         result.actionTaken,
        nights:         result.nights,
        totalAmount:    result.totalAmount,
        primaryReason:  result.primaryReason,
        recommendation: result.recommendation,
        signalsFired:   result.firedSignals.length,
        review_id:      actualReviewId,
        link_token:     linkToken,
        link_expires:   expiresAt,
      });

      const options = {
        hostname: '127.0.0.1',
        port:     5678,
        path:     '/webhook-test/fraud-alert',
        method:   'POST',
        headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
      };

      const req2 = http.request(options, (res2: any) => {
        res2.on('data', () => {});
        res2.on('end', () => logger.info('n8n notified', { bookingId: result.bookingId }));
      });
      req2.on('error', (e: any) => logger.warn('n8n webhook error', { error: e.message }));
      req2.write(postData);
      req2.end();
    } catch (e: any) {
      logger.warn('n8n webhook error', { error: e.message });
    }

    return res.json({
      bookingId:     result.bookingId,
      score:         result.totalScore,
      riskLevel:     result.riskLevel,
      action:        result.actionTaken,
      nights:        result.nights,
      totalAmount:   result.totalAmount,
      primaryReason: result.primaryReason,
      signalsFired:  result.firedSignals.length,
      combosFired:   result.firedCombos.length,
      signals:       result.firedSignals.map(s => ({
        type:   s.signalType,
        score:  s.scoreContrib,
        reason: s.reason,
      })),
      recommendation: result.recommendation,
    });

  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/booking/:bookingId/status
bookingRouter.get('/:bookingId/status', async (req, res) => {
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