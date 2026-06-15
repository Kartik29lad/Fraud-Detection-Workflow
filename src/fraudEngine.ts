// ============================================================
//  FRAUD DETECTION ENGINE — Main Entry Point
//
//  HOW TO USE IN YOUR BOOKING FLOW:
//
//    import { evaluateBookingFraud } from './fraudEngine';
//
//    // At booking time — one function call, everything handled:
//    const result = await evaluateBookingFraud(bookingInput, pool);
//
//    if (result.actionTaken === 'auto_suspend') {
//      // suspend agent in your agents table
//    }
//    if (result.actionTaken === 'block') {
//      // reject booking — return error to client
//    }
//    // otherwise continue with booking creation
// ============================================================

import { FraudScorer, scoreFraud }              from './fraudScorer';
import { fetchScoringContext, fetchThresholds,fetchPermutationRules } from './dbContext';
import { persistFraudResult } from './dbWriter';
import {
  BookingInput, FraudReviewResult,
  FraudThresholds, PermutationRule,
  DEFAULT_THRESHOLDS
}                                                from './types';
import { randomUUID }                            from 'crypto';

// ════════════════════════════════════════════════════════════
//  ONE FUNCTION — CALL AT BOOKING TIME
//
//  Pass:  bookingInput  — raw booking data
//         pool          — your MSSQL connection pool
//
//  Returns: FraudReviewResult — full scored object
//  Side-effects: writes to fraud_signals, fraud_reviews,
//                audit_log, agent_suspension_log
// ════════════════════════════════════════════════════════════

export async function evaluateBookingFraud(
  booking: BookingInput,
  pool:    any,
  opts?: {
    thresholds?:       FraudThresholds;   // pass to override DB thresholds
    permutationRules?: PermutationRule[]; // pass to override DB rules
    skipPersist?:      boolean;           // true = dry-run, no DB writes
  },
): Promise<FraudReviewResult> {

  // ── Step 1: Fetch context + thresholds in parallel ────────
  const [context, thresholds, perms] = await Promise.all([
    fetchScoringContext(
  booking.agentId,
  booking.propertyId,
  pool,
  booking.guestEmail,
  booking.bookingId,
  booking.ipAddress,
  booking.guestNationality,
  booking.passportNumber,
  booking.visaNumber,
  booking.guestPhone,
),
    opts?.thresholds       ?? fetchThresholds(pool),
    opts?.permutationRules ?? fetchPermutationRules(pool),
  ]);

  // ── Step 2: Run scoring algorithm ─────────────────────────
  const scorer = new FraudScorer(thresholds, perms);
  const result = scorer.score(booking, context);

  // ── Step 3: Persist results to DB ─────────────────────────
  if (!opts?.skipPersist) {
    const reviewId = randomUUID();
    await persistFraudResult(result, pool, reviewId);
  }

  // ── Step 4: Return full result to caller ──────────────────
  return result;
}

// ════════════════════════════════════════════════════════════
//  USAGE EXAMPLE — Real booking flow
// ════════════════════════════════════════════════════════════
//
//  import { evaluateBookingFraud } from './fraudEngine';
//
//  async function createBooking(req: Request, res: Response) {
//    const booking: BookingInput = {
//      bookingId:        randomUUID(),
//      agentId:          req.body.agentId,
//      propertyId:       req.body.propertyId,
//      guestNationality: req.body.guestNationality,
//      checkIn:          new Date(req.body.checkIn),
//      checkOut:         new Date(req.body.checkOut),
//      amountPerNight:   req.body.amountPerNight,
//      bookedAt:         new Date(),
//    };
//
//    const fraud = await evaluateBookingFraud(booking, pool);
//
//    // Block if action says so
//    if (fraud.actionTaken === 'block' || fraud.actionTaken === 'auto_suspend') {
//      return res.status(403).json({
//        error:   'Booking blocked by fraud detection',
//        reason:  fraud.primaryReason,
//        score:   fraud.totalScore,
//        action:  fraud.actionTaken,
//      });
//    }
//
//    // Otherwise create booking normally
//    await db.insertBooking({ ...booking, riskScore: fraud.totalScore });
//    return res.json({ success: true, riskScore: fraud.totalScore });
//  }

// ════════════════════════════════════════════════════════════
//  DRY-RUN EXAMPLE — Test without touching DB
// ════════════════════════════════════════════════════════════

export async function dryRunScore(
  booking:  BookingInput,
  baseline: import('./types').AgentBaseline,
  property: import('./types').PropertyContext,
  velocity: import('./types').VelocityContext,
): Promise<FraudReviewResult> {
  return scoreFraud(
    booking,
    {
      baseline,
      property,
      velocity,
      agentMeta:   { isNewAgent: false, daysSinceCreated: 999, daysSinceUpdated: 999 },
      cancelRatio: { totalBookings: 0, cancelledBookings: 0, cancelRatio: 0 },
      repeatGuest: { repeatCount: 0, isRepeat: false },
      blacklist:   { isBlacklisted: false, reason: null },
      frequentEdits: { amendmentCount: 0, isFrequent: false },
      subAgent: { isSubAgent: false, parentAgentId: null },
      sessionContext: { concurrentSessionCount: 0, distinctIPs: [], hasConcurrentSessions: false },
      ipReputation:   { isBlacklisted: false, reason: null, source: null },
accountFarming: { sameIpAgentCount: 0, isFarming: false },
rapidIpSwitch:  { ipSwitchCount: 0, isRapidSwitching: false },
failedBookings: { failureCount: 0, isSuspicious: false },
failedPayments: { failureCount: 0, isSuspicious: false },
chargebacks:    { chargebackCount: 0, hasChargebacks: false },
creditLimit:    { creditLimit: null, currentBalance: null, usagePct: null, isAtRisk: false },
highRiskNat:    { isHighRisk: false, reason: null },
docRequirement: { requiresDocs: false, requiredDocType: null, hasPassport: false, hasVisa: false, isMissing: false },
duplicatePassenger: { duplicateCount: 0, isDuplicate: false },
    },
    DEFAULT_THRESHOLDS,
    [],
  );
}

// ════════════════════════════════════════════════════════════
//  INLINE TEST — Run with: npx ts-node src/fraudEngine.ts
//  Simulates the critical quad booking from the dummy data
// ════════════════════════════════════════════════════════════

async function inlineTest() {
  const { FraudScorer } = await import('./fraudScorer');

  const testBaseline: import('./types').AgentBaseline = {
    agentId:            'A1000001-0000-0000-0000-000000000001',
    avgNights:          3.4,
    maxNightsEver:      6,
    avgBookingAmount:   285.00,
    maxBookingAmount:   980.00,
    avgBookingsPerDay:  2.1,
    nationalityHistory: ['GB', 'US', 'FR', 'DE'],
    geoHistory:         ['london', 'paris', 'berlin'],
    starRatingHistory:  [3, 4, 4, 5],
    typicalActiveHours: [9, 10, 11, 14, 15, 16, 17],
    lookbackDays:       180,
    avgRoomsPerBooking: 1.2,
  };

  const testProperty: import('./types').PropertyContext = {
    propertyId:    'B2000002-0000-0000-0000-000000000002',
    name:          'Dubai Palace Suites',
    city:          'Dubai',
    country:       'AE',
    starRating:    5,
    normalMaxRate: 2000.00,
    avgRate:       1500.00,
  };

  const testVelocity: import('./types').VelocityContext = {
    bookingsLastHour: 1,
  };

  // ── The critical quad booking from dummy data ─────────────
  const testBooking: BookingInput = {
    bookingId:        'C3000015-0000-0000-0000-000000000015',
    agentId:          'A1000001-0000-0000-0000-000000000001',
    propertyId:       'B2000002-0000-0000-0000-000000000002',
    guestNationality: 'GH',                  // new nationality
    checkIn:          new Date('2026-06-01'),
    checkOut:         new Date('2026-07-01'), // 30 nights
    amountPerNight:   1900.00,
    bookedAt:         new Date('2026-05-09T02:51:00Z'), // 2am
  };

  // Load permutation rules
  const testPerms: PermutationRule[] = [
    {
      ruleId:       'PR000014',
      ruleName:     'quad_all_high',
      comboSignals: ['long_duration', 'new_nationality', 'high_amount', 'off_hours'],
      bonusScore:   65,
      severity:     'critical',
      description:  'QUAD: All major signals firing simultaneously',
    },
    {
      ruleId:       'PR000012',
      ruleName:     'triple_stay_nat_amount',
      comboSignals: ['long_duration', 'new_nationality', 'high_amount'],
      bonusScore:   50,
      severity:     'critical',
      description:  'TRIPLE: Long stay + new nationality + high amount',
    },
  ];

 const scorer = new FraudScorer(DEFAULT_THRESHOLDS, testPerms);
  const result = scorer.score(testBooking, {
    baseline:    testBaseline,
    property:    testProperty,
    velocity:    testVelocity,
    agentMeta:   { isNewAgent: false, daysSinceCreated: 999, daysSinceUpdated: 999 },
    cancelRatio: { totalBookings: 0, cancelledBookings: 0, cancelRatio: 0 },
    repeatGuest: { repeatCount: 0, isRepeat: false },
    blacklist:   { isBlacklisted: false, reason: null },
    frequentEdits: { amendmentCount: 0, isFrequent: false },
    subAgent: { isSubAgent: false, parentAgentId: null },
    sessionContext: { concurrentSessionCount: 0, distinctIPs: [], hasConcurrentSessions: false },
    ipReputation:   { isBlacklisted: false, reason: null, source: null },
accountFarming: { sameIpAgentCount: 0, isFarming: false },
rapidIpSwitch:  { ipSwitchCount: 0, isRapidSwitching: false },
failedBookings: { failureCount: 0, isSuspicious: false },
failedPayments: { failureCount: 0, isSuspicious: false },
chargebacks:    { chargebackCount: 0, hasChargebacks: false },
creditLimit:    { creditLimit: null, currentBalance: null, usagePct: null, isAtRisk: false },
highRiskNat:    { isHighRisk: false, reason: null },
docRequirement: { requiresDocs: false, requiredDocType: null, hasPassport: false, hasVisa: false, isMissing: false },
duplicatePassenger: { duplicateCount: 0, isDuplicate: false },
  });

  console.log('\n══════════════════════════════════════════');
  console.log(' FRAUD SCORER — INLINE TEST RESULT');
  console.log('══════════════════════════════════════════');
  console.log(`  Score:       ${result.totalScore}/100`);
  console.log(`  Risk level:  ${result.riskLevel.toUpperCase()}`);
  console.log(`  Action:      ${result.actionTaken}`);
  console.log(`  Nights:      ${result.nights}`);
  console.log(`  Total $:     $${result.totalAmount.toLocaleString()}`);
  console.log(`  Signals:     ${result.firedSignals.length}`);
  console.log(`  Combos:      ${result.firedCombos.length}`);
  console.log('\n  Primary reason:');
  console.log(`    ${result.primaryReason}`);
  console.log('\n  Full reason:');
  result.fullReason.split('\n').forEach(line => console.log(`    ${line}`));
  console.log('\n  Recommendation:');
  console.log(`    ${result.recommendation}`);
  console.log('══════════════════════════════════════════\n');
}

// Run inline test if executed directly
if (require.main === module) {
  inlineTest().catch(console.error);
}

// Re-export everything for external use
export * from './types';
export * from './fraudScorer';
export * from './dbContext';
export * from './dbWriter';