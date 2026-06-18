import {
  BookingInput,
  ScoringContext,
  FraudThresholds,
  PermutationRule,
  FraudReviewResult,
  FiredSignal,
  FiredCombo,
  RiskLevel,
  ActionTaken,
  SignalType,
} from '../types';
import { DEFAULT_THRESHOLDS } from '../config/thresholds';
import {
  checkDuration,
  checkNationality,
  checkAmount,
  checkPropertyCap,
  checkStarRating,
  checkVelocity,
  checkOffHours,
  checkGeo,
  checkNewAgent,
  checkCancelRatio,
  checkAccountChange,
  checkLeadTime,
  checkRepeatGuest,
  checkBlacklist,
  checkFrequentEdits,
  checkFakeNames,
  checkDisposableEmail,
  checkGroupSize,
  checkDataQuality,
  checkSubAgent,
  checkConcurrentSessions,
  checkIpReputation,
  checkAccountFarming,
  checkRapidIpSwitch,
  checkFailedBookings,
  checkFailedPayments,
  checkChargebacks,
  checkCreditLimit,
  checkHighRiskNat,
  checkDocRequirement,
  checkDuplicatePassenger,
} from './signals';

export class FraudScorer {
  private readonly t:     FraudThresholds;
  private readonly perms: PermutationRule[];

  constructor(
    thresholds:       FraudThresholds   = DEFAULT_THRESHOLDS,
    permutationRules: PermutationRule[] = [],
  ) {
    this.t     = thresholds;
    this.perms = permutationRules;
  }

  public score(booking: BookingInput, ctx: ScoringContext): FraudReviewResult {

    // ── Step 1: derived metrics ────────────────────────────
    const nights      = this.computeNights(booking.checkIn, booking.checkOut);
    const totalAmount = nights * booking.amountPerNight;
    const bookingHour = booking.bookedAt.getHours();

    // ── Step 2: run all signals ────────────────────────────
    const firedSignals: FiredSignal[] = [
      ...checkDuration(nights, this.t),
      ...checkNationality(booking.guestNationality, ctx),
      ...checkAmount(totalAmount, booking.amountPerNight, ctx, this.t),
      ...checkPropertyCap(booking.amountPerNight, ctx, this.t),
      ...checkStarRating(ctx, this.t),
      ...checkVelocity(ctx, this.t),
      ...checkOffHours(bookingHour, this.t),
      ...checkGeo(ctx.property.city, ctx),
      ...checkNewAgent(ctx, totalAmount),
      ...checkCancelRatio(ctx),
      ...checkAccountChange(ctx),
      ...checkLeadTime(booking, nights),
      ...checkRepeatGuest(ctx),
      ...checkBlacklist(ctx),
      ...checkFrequentEdits(ctx),
      ...checkFakeNames(booking.passengerName || ''),
      ...checkDisposableEmail(booking.guestEmail || ''),
      ...checkGroupSize(booking.roomCount || 1, ctx.baseline.avgRoomsPerBooking || 1.2),
      ...checkDataQuality(booking),
      ...checkSubAgent(ctx),
      ...checkConcurrentSessions(ctx),
      ...checkIpReputation(ctx),
      ...checkAccountFarming(ctx),
      ...checkRapidIpSwitch(ctx),
      ...checkFailedBookings(ctx),
      ...checkFailedPayments(ctx),
      ...checkChargebacks(ctx),
      ...checkCreditLimit(ctx),
      ...checkHighRiskNat(booking, ctx),
      ...checkDocRequirement(ctx),
      ...checkDuplicatePassenger(ctx),
    ];

    // ── Step 3: base score ─────────────────────────────────
    const baseScore = firedSignals.reduce((sum, s) => sum + s.scoreContrib, 0);

    // ── Step 4: combo bonuses ──────────────────────────────
    const firedSignalTypes = new Set(firedSignals.map(s => s.signalType));
    const firedCombos      = this.checkPermutations(firedSignalTypes);
    const comboBonus       = firedCombos.reduce((sum, c) => sum + c.bonusScore, 0);

    // ── Step 5: cap at 100 ────────────────────────────────
    const totalScore = Math.min(100, baseScore + comboBonus);

    // ── Step 6: derive output ─────────────────────────────
    const riskLevel     = this.toRiskLevel(totalScore);
    const actionTaken   = this.toAction(totalScore);
    const primaryReason = this.buildPrimaryReason(firedSignals, firedCombos);
    const fullReason    = this.buildFullReason(firedSignals, firedCombos, totalScore);
    const recommendation = this.buildRecommendation(actionTaken, firedSignals);

    return {
      bookingId:      booking.bookingId,
      agentId:        booking.agentId,
      totalScore,
      riskLevel,
      actionTaken,
      firedSignals,
      firedCombos,
      primaryReason,
      fullReason,
      recommendation,
      nights,
      totalAmount,
      bookingHour,
      scoredAt:       new Date(),
      thresholdsUsed: this.t,
    };
  }

  private checkPermutations(firedTypes: Set<SignalType>): FiredCombo[] {
    return this.perms
      .filter(rule => rule.comboSignals.every(sig => firedTypes.has(sig)))
      .map(rule => ({
        ruleName:    rule.ruleName,
        bonusScore:  rule.bonusScore,
        severity:    rule.severity,
        description: rule.description,
      }));
  }

  private toRiskLevel(score: number): RiskLevel {
    if (score >= this.t.scoreSuspend) return 'critical';
    if (score >= this.t.scoreBlock)   return 'high';
    if (score >= this.t.scoreReview)  return 'medium';
    return 'low';
  }

  private toAction(score: number): ActionTaken {
    if (score >= this.t.scoreSuspend) return 'auto_suspend';
    if (score >= this.t.scoreBlock)   return 'hold';
    if (score >= this.t.scoreReview)  return 'flag_review';
    return 'monitor';
  }

  private buildPrimaryReason(signals: FiredSignal[], combos: FiredCombo[]): string {
    if (combos.length > 0) {
      const top = [...combos].sort((a, b) => b.bonusScore - a.bonusScore)[0];
      return `Combo rule fired: ${top.description}`;
    }
    if (signals.length === 0) return 'No suspicious signals detected.';
    const top = [...signals].sort((a, b) => b.scoreContrib - a.scoreContrib)[0];
    return top.reason;
  }

  private buildFullReason(signals: FiredSignal[], combos: FiredCombo[], score: number): string {
    const parts: string[] = [`Risk score: ${score}/100.`];

    if (signals.length > 0) {
      parts.push(`Signals fired (${signals.length}):`);
      signals.forEach(s =>
        parts.push(`  • [${s.signalType}] +${s.scoreContrib}pts — ${s.reason}`)
      );
    }

    if (combos.length > 0) {
      parts.push(`Combo rules matched (${combos.length}):`);
      combos.forEach(c =>
        parts.push(`  • [${c.ruleName}] +${c.bonusScore}pts — ${c.description}`)
      );
    }

    return parts.join('\n');
  }

  private buildRecommendation(action: ActionTaken, signals: FiredSignal[]): string {
    const sigList = signals.map(s => s.signalType).join(', ');

    switch (action) {
      case 'auto_suspend':
        return `AUTO-SUSPEND agent immediately. Block all pending bookings. Preserve audit log. Escalate to fraud team. Signals: ${sigList}`;
      case 'hold':
        return `HOLD booking — do not confirm. Agent held for identity verification. Alert Supervisor + Finance Team. Fraud Team must investigate within 2 hours. Signals: ${sigList}`;
      case 'flag_review':
        return `FLAG for ops review. Do not block yet. Assign to compliance team. Signals: ${sigList}`;
      case 'monitor':
        return signals.length > 0
          ? `MONITOR — low risk but ${signals.length} weak signal(s) detected. Watch for pattern: ${sigList}`
          : 'MONITOR — no signals detected. Booking appears normal.';
    }
    return 'No action required.';
  }

  private computeNights(checkIn: Date, checkOut: Date): number {
    const msPerDay = 1000 * 60 * 60 * 24;
    return Math.round((checkOut.getTime() - checkIn.getTime()) / msPerDay);
  }
}

export function scoreFraud(
  booking:           BookingInput,
  context:           ScoringContext,
  thresholds?:       FraudThresholds,
  permutationRules?: PermutationRule[],
): FraudReviewResult {
  const scorer = new FraudScorer(thresholds, permutationRules);
  return scorer.score(booking, context);
}