import { randomUUID }                          from 'crypto';
import { FraudScorer, scoreFraud }             from './scorer';
import { fetchScoringContext }                 from '../db/context';
import { fetchThresholds, fetchPermutationRules } from '../db/thresholds';
import { persistFraudResult }                  from '../db/writer';
import {
  BookingInput,
  FraudReviewResult,
  FraudThresholds,
  PermutationRule,
  AgentBaseline,
  PropertyContext,
  VelocityContext,
  DEFAULT_THRESHOLDS,
} from '../types';

export async function evaluateBookingFraud(
  booking: BookingInput,
  pool:    any,
  opts?: {
    thresholds?:       FraudThresholds;
    permutationRules?: PermutationRule[];
    skipPersist?:      boolean;
  },
): Promise<FraudReviewResult> {

  // ── Step 1: fetch context + thresholds in parallel ────────
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

  // ── Step 2: run scoring ───────────────────────────────────
  const scorer = new FraudScorer(thresholds, perms);
  const result = scorer.score(booking, context);

  // ── Step 3: persist to DB ─────────────────────────────────
  if (!opts?.skipPersist) {
    const reviewId = randomUUID();
    await persistFraudResult(result, pool, reviewId);
  }

  // ── Step 4: return ────────────────────────────────────────
  return result;
}

export async function dryRunScore(
  booking:  BookingInput,
  baseline: AgentBaseline,
  property: PropertyContext,
  velocity: VelocityContext,
): Promise<FraudReviewResult> {
  return scoreFraud(
    booking,
    {
      baseline,
      property,
      velocity,
      agentMeta:          { isNewAgent: false, daysSinceCreated: 999, daysSinceUpdated: 999 },
      cancelRatio:        { totalBookings: 0, cancelledBookings: 0, cancelRatio: 0 },
      repeatGuest:        { repeatCount: 0, isRepeat: false },
      blacklist:          { isBlacklisted: false, reason: null },
      frequentEdits:      { amendmentCount: 0, isFrequent: false },
      subAgent:           { isSubAgent: false, parentAgentId: null },
      sessionContext:     { concurrentSessionCount: 0, distinctIPs: [], hasConcurrentSessions: false },
      ipReputation:       { isBlacklisted: false, reason: null, source: null },
      accountFarming:     { sameIpAgentCount: 0, isFarming: false },
      rapidIpSwitch:      { ipSwitchCount: 0, isRapidSwitching: false },
      failedBookings:     { failureCount: 0, isSuspicious: false },
      failedPayments:     { failureCount: 0, isSuspicious: false },
      chargebacks:        { chargebackCount: 0, hasChargebacks: false },
      creditLimit:        { creditLimit: null, currentBalance: null, usagePct: null, isAtRisk: false },
      highRiskNat:        { isHighRisk: false, reason: null },
      docRequirement:     { requiresDocs: false, requiredDocType: null, hasPassport: false, hasVisa: false, isMissing: false },
      duplicatePassenger: { duplicateCount: 0, isDuplicate: false },
    },
    DEFAULT_THRESHOLDS,
    [],
  );
}