import { getPool } from './db';
import { evaluateBookingFraud } from './fraudEngine';

async function main() {
  try {
    // Connect to DB
    const pool = await getPool();
    console.log('Connected to FraudDetection DB');

    // Test booking — same as score 94 example
    const testBooking = {
      bookingId:        '12345678-0000-0000-0000-000000000001',
      agentId:          '12345678-0000-0000-0000-000000000002',
      propertyId:       '12345678-0000-0000-0000-000000000003',
      guestNationality: 'NG',
      checkIn:          new Date('2026-06-01'),
      checkOut:         new Date('2026-07-01'),
      amountPerNight:   1900,
      bookedAt:         new Date('2026-05-09T02:51:00Z'),
    };

    console.log('Running fraud score...');
    const result = await evaluateBookingFraud(testBooking, pool, {
      skipPersist: false  // dry run — no DB writes yet
    });

    console.log('═══════════════════════════════');
    console.log('Score:      ', result.totalScore);
    console.log('Risk level: ', result.riskLevel);
    console.log('Action:     ', result.actionTaken);
    console.log('Reason:     ', result.primaryReason);
    console.log('═══════════════════════════════');

  } catch (err) {
    console.error('Error:', err);
  }
}

main();