// ============================================================
//  FRAUD DETECTION ENGINE — Core Scoring Algorithm
//
//  USAGE:
//    const scorer = new FraudScorer(thresholds, permutationRules);
//    const result = scorer.score(bookingInput, context);
//
//  The result is ready to:
//    → INSERT into fraud_reviews      (1 row)
//    → INSERT into fraud_signals      (N rows — one per firedSignal)
//    → UPDATE bookings.risk_score     (result.totalScore)
//    → UPDATE bookings.status         (derived from result.actionTaken)
//    → INSERT into agent_suspension_log (if actionTaken === 'auto_suspend')
// ============================================================

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
  DEFAULT_THRESHOLDS,
} from './types';

// ── Score weights for each individual signal ─────────────────
//    These are overridden by fraud_thresholds.score_weight at runtime.
//    Shown here as defaults so the logic is self-documenting.

const SIGNAL_WEIGHTS: Record<SignalType, number> = {
  long_duration:       15,
  new_nationality:     15,
  high_amount:         20,
  property_cap_breach: 20,
  velocity_spike:      20,
  off_hours:           15,
  low_star_mismatch:   15,
  new_geo:             10,
  new_agent:           20,
  cancel_ratio:        15,
  account_change:      15,
  lead_time_anomaly:   10,
  repeat_guest:        15,
  blacklist_match:     40,
  fake_name_detected: 25,
  disposable_email:   30,
  data_quality_low:   15,
  group_size_anomaly: 20,
  frequent_edits:     20,
  sub_agent_anomaly:  15,
  concurrent_sessions: 20,

};

// ════════════════════════════════════════════════════════════
//  MAIN CLASS
// ════════════════════════════════════════════════════════════

export class FraudScorer {
  private readonly t:    FraudThresholds;
  private readonly perms: PermutationRule[];

  constructor(
    thresholds:       FraudThresholds  = DEFAULT_THRESHOLDS,
    permutationRules: PermutationRule[] = [],
  ) {
    this.t     = thresholds;
    this.perms = permutationRules;
  }

  // ── PUBLIC ENTRY POINT ────────────────────────────────────
  //
  //  Call this once per booking attempt.
  //  Pass raw booking data + pre-fetched context from DB.
  //  Returns a FraudReviewResult — one object, everything you need.

  public score(
    booking: BookingInput,
    ctx:     ScoringContext,
  ): FraudReviewResult {

    // ── Step 1: compute derived booking metrics ─────────────
    const nights      = this.computeNights(booking.checkIn, booking.checkOut);
    const totalAmount = nights * booking.amountPerNight;
    const bookingHour = booking.bookedAt.getHours();

    // ── Step 2: evaluate all individual signals ─────────────
    const firedSignals: FiredSignal[] = [
  ...this.checkDuration(nights),
  ...this.checkNationality(booking.guestNationality, ctx),
  ...this.checkAmount(totalAmount, booking.amountPerNight, ctx),
  ...this.checkPropertyCap(booking.amountPerNight, ctx),
  ...this.checkStarRating(ctx),
  ...this.checkVelocity(ctx),
  ...this.checkOffHours(bookingHour),
  ...this.checkGeo(ctx.property.city, ctx),
  ...this.checkNewAgent(ctx, totalAmount),
  ...this.checkCancelRatio(ctx),
  ...this.checkAccountChange(ctx),
  ...this.checkLeadTime(booking, nights),
  ...this.checkRepeatGuest(ctx),
  ...this.checkBlacklist(ctx),
  ...this.checkFrequentEdits(ctx),
  ...this.checkFakeNames(booking.passengerName || ''),
  ...this.checkDisposableEmail(booking.guestEmail || ''),
  ...this.checkGroupSize(booking.roomCount || 1, ctx.baseline.avgRoomsPerBooking || 1.2),
  ...this.checkDataQuality(booking),
  ...this.checkSubAgent(ctx),
  ...this.checkConcurrentSessions(ctx),
];

    // ── Step 3: sum individual signal scores ────────────────
    const baseScore = firedSignals.reduce((sum, s) => sum + s.scoreContrib, 0);

    // ── Step 4: check permutation combos ────────────────────
    //    A combo fires only when ALL its required signals are present.
    //    Bonus score stacks on top of base.
    const firedSignalTypes = new Set(firedSignals.map(s => s.signalType));
    const firedCombos: FiredCombo[] = this.checkPermutations(firedSignalTypes);
    const comboBonus = firedCombos.reduce((sum, c) => sum + c.bonusScore, 0);

    // ── Step 5: cap total at 100 ────────────────────────────
    const totalScore = Math.min(100, baseScore + comboBonus);

    // ── Step 6: derive risk level, action, reasons ──────────
    const riskLevel      = this.toRiskLevel(totalScore);
    const actionTaken    = this.toAction(totalScore);
    const primaryReason  = this.buildPrimaryReason(firedSignals, firedCombos);
    const fullReason     = this.buildFullReason(firedSignals, firedCombos, totalScore);
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

  // ════════════════════════════════════════════════════════
  //  SIGNAL EVALUATORS
  //  Each returns FiredSignal[] — empty array = signal clean.
  // ════════════════════════════════════════════════════════

  // ── 1. DURATION ──────────────────────────────────────────
  //
  //  FORMULA:
  //    base  score = +15  if nights >= longDuration (15)
  //    extra score = +10  if nights >= extremeDuration (25)
  //    total max   = +25  for duration alone

  private checkDuration(nights: number): FiredSignal[] {
    const signals: FiredSignal[] = [];

    if (nights >= this.t.longDuration) {
      signals.push({
        signalType:   'long_duration',
        scoreContrib: SIGNAL_WEIGHTS.long_duration,
        reason:       `Booking is ${nights} nights — agent baseline is ${this.t.longDuration}+ nights threshold`,
        detail: {
          nights,
          threshold: this.t.longDuration,
          scoreAdded: SIGNAL_WEIGHTS.long_duration,
        },
      });
    }

    // Extra weight for extreme stays (25+ nights)
    if (nights >= this.t.extremeDuration) {
      signals.push({
        signalType:   'long_duration',
        scoreContrib: 10,
        reason:       `Extreme stay: ${nights} nights >= extreme threshold (${this.t.extremeDuration})`,
        detail: {
          nights,
          extremeThreshold: this.t.extremeDuration,
          extraScoreAdded: 10,
        },
      });
    }

    return signals;
  }

  // ── 2. NATIONALITY ───────────────────────────────────────
  //
  //  FORMULA:
  //    nationality NOT IN agent_baseline.nationality_history → +15
  //    history is checked against last lookback_days (default 180)

  private checkNationality(
    guestNationality: string,
    ctx: ScoringContext,
  ): FiredSignal[] {
    const history = ctx.baseline.nationalityHistory.map(n => n.toUpperCase());
    const nat     = guestNationality.toUpperCase();

    if (!history.includes(nat)) {
      return [{
        signalType:   'new_nationality',
        scoreContrib: SIGNAL_WEIGHTS.new_nationality,
        reason:       `Guest nationality "${nat}" not in agent history (${history.join(', ')})`,
        detail: {
          guestNationality: nat,
          agentHistory:     history,
          lookbackDays:     ctx.baseline.lookbackDays,
          scoreAdded:       SIGNAL_WEIGHTS.new_nationality,
        },
      }];
    }
    return [];
  }

  // ── 3. HIGH AMOUNT ───────────────────────────────────────
  //
  //  FORMULA:
  //    totalAmount > (agentAvgBookingAmount × highAmountMult) → +20
  //    e.g. agent avg = $285, mult = 3 → threshold = $855
  //    booking total = $22,400 → 78.6× avg → FIRES

  private checkAmount(
    totalAmount:     number,
    amountPerNight:  number,
    ctx:             ScoringContext,
  ): FiredSignal[] {
    const threshold  = ctx.baseline.avgBookingAmount * this.t.highAmountMult;
    const multiplier = parseFloat((totalAmount / ctx.baseline.avgBookingAmount).toFixed(2));

    if (totalAmount > threshold) {
      return [{
        signalType:   'high_amount',
        scoreContrib: SIGNAL_WEIGHTS.high_amount,
        reason:       `Total $${totalAmount.toLocaleString()} is ${multiplier}× agent avg ($${ctx.baseline.avgBookingAmount}) — threshold: ${this.t.highAmountMult}×`,
        detail: {
          totalAmount,
          amountPerNight,
          agentAvgAmount: ctx.baseline.avgBookingAmount,
          multiplierApplied: this.t.highAmountMult,
          actualMultiplier:  multiplier,
          computedThreshold: threshold,
          scoreAdded: SIGNAL_WEIGHTS.high_amount,
        },
      }];
    }
    return [];
  }

  // ── 4. PROPERTY CAP BREACH ───────────────────────────────
  //
  //  FORMULA:
  //    amountPerNight > (property.normalMaxRate × propertyCapMult) → +20
  //    e.g. property max = $2000, mult = 1.5 → threshold = $3000
  //    booking rate = $1900/night — CLEAN (under $3000)
  //    booking rate = $3200/night — FIRES

  private checkPropertyCap(
    amountPerNight: number,
    ctx:            ScoringContext,
  ): FiredSignal[] {
    const capThreshold = ctx.property.normalMaxRate * this.t.propertyCapMult;

    if (amountPerNight > capThreshold) {
      return [{
        signalType:   'property_cap_breach',
        scoreContrib: SIGNAL_WEIGHTS.property_cap_breach,
        reason:       `Rate $${amountPerNight}/night exceeds property cap $${ctx.property.normalMaxRate} × ${this.t.propertyCapMult} = $${capThreshold}`,
        detail: {
          amountPerNight,
          propertyNormalMax:   ctx.property.normalMaxRate,
          multiplierApplied:   this.t.propertyCapMult,
          computedCapThreshold: capThreshold,
          propertyName:        ctx.property.name,
          scoreAdded:          SIGNAL_WEIGHTS.property_cap_breach,
        },
      }];
    }
    return [];
  }

  // ── 5. STAR RATING MISMATCH ──────────────────────────────
  //
  //  FORMULA:
  //    agentAvgStar = average(baseline.starRatingHistory)
  //    delta        = agentAvgStar - property.starRating
  //    if delta >= starDropDelta (2) → +15
  //    e.g. agent usually books 4★ → books 2★ → delta=2 → FIRES

  private checkStarRating(ctx: ScoringContext): FiredSignal[] {
    const history = ctx.baseline.starRatingHistory;
    if (!history.length) return [];

    const agentAvgStar = history.reduce((a, b) => a + b, 0) / history.length;
    const delta        = parseFloat((agentAvgStar - ctx.property.starRating).toFixed(2));

    if (delta >= this.t.starDropDelta) {
      return [{
        signalType:   'low_star_mismatch',
        scoreContrib: SIGNAL_WEIGHTS.low_star_mismatch,
        reason:       `Property is ${ctx.property.starRating}★ — agent usually books ${agentAvgStar.toFixed(1)}★ (drop: ${delta} stars, threshold: ${this.t.starDropDelta})`,
        detail: {
          bookedStarRating:   ctx.property.starRating,
          agentAvgStarRating: agentAvgStar,
          delta,
          threshold:          this.t.starDropDelta,
          propertyName:       ctx.property.name,
          scoreAdded:         SIGNAL_WEIGHTS.low_star_mismatch,
        },
      }];
    }
    return [];
  }

  // ── 6. VELOCITY SPIKE ────────────────────────────────────
  //
  //  FORMULA:
  //    bookingsLastHour >= velocityPerHour (5) → +20
  //    you fetch this from DB before calling score():
  //      SELECT COUNT(*) FROM bookings
  //      WHERE agent_id = ? AND booked_at >= DATEADD(MINUTE,-60,SYSDATETIMEOFFSET())

  private checkVelocity(ctx: ScoringContext): FiredSignal[] {
    if (ctx.velocity.bookingsLastHour >= this.t.velocityPerHour) {
      return [{
        signalType:   'velocity_spike',
        scoreContrib: SIGNAL_WEIGHTS.velocity_spike,
        reason:       `Agent made ${ctx.velocity.bookingsLastHour} bookings in last 60 min — threshold: ${this.t.velocityPerHour}`,
        detail: {
          bookingsLastHour: ctx.velocity.bookingsLastHour,
          threshold:        this.t.velocityPerHour,
          scoreAdded:       SIGNAL_WEIGHTS.velocity_spike,
        },
      }];
    }
    return [];
  }

  // ── 7. OFF HOURS ─────────────────────────────────────────
  //
  //  FORMULA:
  //    bookingHour >= offHoursStart (23) OR bookingHour < offHoursEnd (5) → +15
  //    window wraps midnight: 23:00 → 04:59
  //    e.g. booking at 02:47 → FIRES

  private checkOffHours(bookingHour: number): FiredSignal[] {
    const inWindow =
      bookingHour >= this.t.offHoursStart ||
      bookingHour < this.t.offHoursEnd;

    if (inWindow) {
      return [{
        signalType:   'off_hours',
        scoreContrib: SIGNAL_WEIGHTS.off_hours,
        reason:       `Booking at ${bookingHour}:00 falls in off-hours window (${this.t.offHoursStart}:00–${this.t.offHoursEnd}:00)`,
        detail: {
          bookingHour,
          offHoursStart: this.t.offHoursStart,
          offHoursEnd:   this.t.offHoursEnd,
          scoreAdded:    SIGNAL_WEIGHTS.off_hours,
        },
      }];
    }
    return [];
  }

  // ── 8. NEW GEO ───────────────────────────────────────────
  //
  //  FORMULA:
  //    property.city NOT IN baseline.geoHistory → +10
  //    city is slugified and lowercased before comparison

  private checkGeo(city: string, ctx: ScoringContext): FiredSignal[] {
    const slug    = city.toLowerCase().replace(/\s+/g, '_');
    const history = ctx.baseline.geoHistory.map(g => g.toLowerCase());

    if (!history.includes(slug) && !history.includes(city.toLowerCase())) {
      return [{
        signalType:   'new_geo',
        scoreContrib: SIGNAL_WEIGHTS.new_geo,
        reason:       `Property city "${city}" not in agent geo history (${ctx.baseline.geoHistory.join(', ')})`,
        detail: {
          bookedCity:      city,
          agentGeoHistory: ctx.baseline.geoHistory,
          scoreAdded:      SIGNAL_WEIGHTS.new_geo,
        },
      }];
    }
    return [];
  }

  // ── 9. NEW AGENT ─────────────────────────────────────────
private checkNewAgent(ctx: ScoringContext, totalAmount: number): FiredSignal[] {
  if (ctx.agentMeta.isNewAgent && totalAmount > 1000) {
    return [{
      signalType:   'new_agent',
      scoreContrib: 20,
      reason:       `New agent (${ctx.agentMeta.daysSinceCreated} days old) booking high value $${totalAmount.toLocaleString()}`,
      detail:       { daysSinceCreated: ctx.agentMeta.daysSinceCreated, totalAmount },
    }];
  }
  return [];
}

// ── 13. CANCEL RATIO ─────────────────────────────────────
private checkCancelRatio(ctx: ScoringContext): FiredSignal[] {
  const cr = ctx.cancelRatio;
  if (cr.cancelRatio >= 0.4 && cr.totalBookings >= 5) {
    return [{
      signalType:   'cancel_ratio',
      scoreContrib: 15,
      reason:       `High cancellation ratio: ${(cr.cancelRatio * 100).toFixed(0)}% (${cr.cancelledBookings}/${cr.totalBookings} bookings)`,
      detail:       { cancelRatio: cr.cancelRatio, cancelled: cr.cancelledBookings, total: cr.totalBookings },
    }];
  }
  return [];
}

// ── 18. ACCOUNT CHANGE ───────────────────────────────────
private checkAccountChange(ctx: ScoringContext): FiredSignal[] {
  if (ctx.agentMeta.daysSinceUpdated <= 7) {
    return [{
      signalType:   'account_change',
      scoreContrib: 15,
      reason:       `Agent account data changed ${ctx.agentMeta.daysSinceUpdated} day(s) before booking`,
      detail:       { daysSinceUpdated: ctx.agentMeta.daysSinceUpdated },
    }];
  }
  return [];
}

// ── 32. LEAD TIME ANOMALY ────────────────────────────────
private checkLeadTime(booking: BookingInput, nights: number): FiredSignal[] {
  const leadTimeDays = Math.floor(
    (booking.checkIn.getTime() - booking.bookedAt.getTime()) / (1000 * 60 * 60 * 24)
  );
  if (leadTimeDays <= 0 || leadTimeDays > 365) {
    return [{
      signalType:   'lead_time_anomaly',
      scoreContrib: 10,
      reason:       leadTimeDays <= 0
        ? `Same-day or past check-in booking (lead time: ${leadTimeDays} days)`
        : `Booking made ${leadTimeDays} days in advance — unusually far future`,
      detail:       { leadTimeDays },
    }];
  }
  return [];
}

// ── 34. REPEAT GUEST ─────────────────────────────────────
private checkRepeatGuest(ctx: ScoringContext): FiredSignal[] {
  if (ctx.repeatGuest.isRepeat) {
    return [{
      signalType:   'repeat_guest',
      scoreContrib: 15,
      reason:       `Guest email seen ${ctx.repeatGuest.repeatCount} times across this agent's bookings`,
      detail:       { repeatCount: ctx.repeatGuest.repeatCount },
    }];
  }
  return [];
}

// ── 46. BLACKLIST MATCH ──────────────────────────────────
private checkBlacklist(ctx: ScoringContext): FiredSignal[] {
  if (ctx.blacklist.isBlacklisted) {
    return [{
      signalType:   'blacklist_match',
      scoreContrib: 40,
      reason:       `Guest email matches blacklist: ${ctx.blacklist.reason ?? 'no reason specified'}`,
      detail:       { reason: ctx.blacklist.reason },
    }];
  }
  return [];
}

private checkFrequentEdits(ctx: ScoringContext): FiredSignal[] {
  if (ctx.frequentEdits.isFrequent) {
    return [{
      signalType:   'frequent_edits',
      scoreContrib: SIGNAL_WEIGHTS.frequent_edits,
      reason:       `Booking amended ${ctx.frequentEdits.amendmentCount} times — possible name change abuse`,
      detail:       { amendmentCount: ctx.frequentEdits.amendmentCount },
    }];
  }
  return [];
}

private checkSubAgent(ctx: ScoringContext): FiredSignal[] {
  if (!ctx.subAgent.isSubAgent) return [];

  // Sub-agent booking high value — flag it
  const baseline = ctx.baseline;
  const isHighValue = baseline.avgBookingAmount > 0 &&
    (ctx.property.avgRate > baseline.avgBookingAmount * 2);

  // Sub-agent booking in new geo
  const citySlug = ctx.property.city.toLowerCase();
  const inKnownGeo = ctx.baseline.geoHistory
    .map(g => g.toLowerCase())
    .includes(citySlug);

  if (isHighValue || !inKnownGeo) {
    return [{
      signalType:   'sub_agent_anomaly',
      scoreContrib: SIGNAL_WEIGHTS.sub_agent_anomaly,
      reason:       `Sub-agent booking outside normal pattern — ${!inKnownGeo ? 'new geo: ' + ctx.property.city : 'high value property'}`,
      detail: {
        isSubAgent:    true,
        parentAgentId: ctx.subAgent.parentAgentId,
        propertyCity:  ctx.property.city,
        propertyRate:  ctx.property.avgRate,
        agentAvg:      baseline.avgBookingAmount,
        knownGeos:     baseline.geoHistory,
      },
    }];
  }
  return [];
}
// ── Rule 20: Concurrent Sessions ─────────────────────────
private checkConcurrentSessions(ctx: ScoringContext): FiredSignal[] {
  const session = ctx.sessionContext;
  if (!session.hasConcurrentSessions) return [];

  return [{
    signalType:   'concurrent_sessions',
    scoreContrib: SIGNAL_WEIGHTS.concurrent_sessions,
    reason:       `Agent active from ${session.concurrentSessionCount} different IPs simultaneously (${session.distinctIPs.join(', ')})`,
    detail: {
      concurrentSessionCount: session.concurrentSessionCount,
      distinctIPs:            session.distinctIPs,
      scoreAdded:             SIGNAL_WEIGHTS.concurrent_sessions,
    },
  }];
}

// ── Rule 35: Fake Passenger Names ────────────────────────
  private checkFakeNames(passengerName: string): FiredSignal[] {
    const fakeRegex = /^(test|asdf|qwerty|abc|guest|unknown|aaaa|user|none|nil|null)$/i;
    if (fakeRegex.test(passengerName) || (passengerName.length > 0 && passengerName.length < 3)) {
      return [{
        signalType: 'fake_name_detected',
        scoreContrib: SIGNAL_WEIGHTS.fake_name_detected,
        reason: `Suspicious passenger name detected: "${passengerName}"`,
        detail: { passengerName }
      }];
    }
    return [];
  }

  // ── Rule 41/5: Disposable Email Detection ────────────────
  private checkDisposableEmail(email: string): FiredSignal[] {
    const disposableDomains = ['mailinator.com', 'tempmail.com', 'sharklasers.com', 'guerrillamail.com', 'yopmail.com'];
    const domain = email.split('@')[1]?.toLowerCase();
    
    if (disposableDomains.includes(domain)) {
      return [{
        signalType: 'disposable_email',
        scoreContrib: SIGNAL_WEIGHTS.disposable_email,
        reason: `Disposable email domain detected: @${domain}`,
        detail: { email, domain }
      }];
    }
    return [];
  }

  // ── Rule 33: Group/Room Count Anomaly ─────────────────────
  private checkGroupSize(currentRooms: number, avgRooms: number): FiredSignal[] {
    if (currentRooms > (avgRooms * 2) && currentRooms > 3) {
      return [{
        signalType: 'group_size_anomaly',
        scoreContrib: SIGNAL_WEIGHTS.group_size_anomaly,
        reason: `Unusual room count: ${currentRooms} (Agent avg: ${avgRooms})`,
        detail: { currentRooms, avgRooms }
      }];
    }
    return [];
  }

  // ── Rule 44: Data Quality (Missing Fields) ────────────────
  private checkDataQuality(booking: any): FiredSignal[] {
    if (!booking.guestPhone || booking.guestPhone.includes('12345') || booking.guestPhone.length < 5) {
      return [{
        signalType: 'data_quality_low',
        scoreContrib: SIGNAL_WEIGHTS.data_quality_low,
        reason: `Mandatory data quality check failed (Phone missing or invalid)`,
        detail: { phone: booking.guestPhone || 'MISSING' }
      }];
    }
    return [];
  }

  // ════════════════════════════════════════════════════════
  //  PERMUTATION COMBO CHECKER
  //
  //  FORMULA:
  //    for each active rule:
  //      if ALL rule.comboSignals are in firedSignalTypes
  //        → add rule.bonusScore to total
  //
  //  Combos stack — multiple combos can fire on one booking.
  //  This is what pushes borderline bookings into critical range.
  // ════════════════════════════════════════════════════════

  private checkPermutations(firedTypes: Set<SignalType>): FiredCombo[] {
    return this.perms
      .filter(rule =>
        rule.comboSignals.every(sig => firedTypes.has(sig))
      )
      .map(rule => ({
        ruleName:    rule.ruleName,
        bonusScore:  rule.bonusScore,
        severity:    rule.severity,
        description: rule.description,
      }));
  }

  // ════════════════════════════════════════════════════════
  //  SCORING FORMULA — FULL PICTURE
  //
  //  totalScore = SUM(individual signal scores)
  //             + SUM(permutation combo bonuses)
  //             capped at 100
  //
  //  Risk level mapping:
  //    0–39  → low      → monitor
  //    40–69 → medium   → flag_review
  //    70–89 → high     → hold / block
  //    90+   → critical → auto_suspend
  // ════════════════════════════════════════════════════════

  private toRiskLevel(score: number): RiskLevel {
    if (score >= this.t.scoreSuspend) return 'critical';
    if (score >= this.t.scoreBlock)   return 'high';
    if (score >= this.t.scoreReview)  return 'medium';
    return 'low';
  }

  private toAction(score: number): ActionTaken {
    if (score >= this.t.scoreSuspend) return 'auto_suspend';
    if (score >= this.t.scoreBlock)   return 'hold';       // 70–89: hold + identity verification
    if (score >= this.t.scoreReview)  return 'flag_review';
    return 'monitor';
  }

  // ════════════════════════════════════════════════════════
  //  HUMAN-READABLE OUTPUT BUILDERS
  // ════════════════════════════════════════════════════════

  private buildPrimaryReason(
    signals: FiredSignal[],
    combos:  FiredCombo[],
  ): string {
    if (combos.length > 0) {
      const top = [...combos].sort((a, b) => b.bonusScore - a.bonusScore)[0];
      return `Combo rule fired: ${top.description}`;
    }
    if (signals.length === 0) return 'No suspicious signals detected.';
    const top = [...signals].sort((a, b) => b.scoreContrib - a.scoreContrib)[0];
    return top.reason;
  }

  private buildFullReason(
    signals: FiredSignal[],
    combos:  FiredCombo[],
    score:   number,
  ): string {
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

  private buildRecommendation(
    action:  ActionTaken,
    signals: FiredSignal[],
  ): string {
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

  // ── Utility ──────────────────────────────────────────────

  private computeNights(checkIn: Date, checkOut: Date): number {
    const msPerDay = 1000 * 60 * 60 * 24;
    return Math.round((checkOut.getTime() - checkIn.getTime()) / msPerDay);
  }
}



// ════════════════════════════════════════════════════════════
//  STANDALONE FUNCTION — for simple usage without class
//
//  const result = scoreFraud(booking, context, thresholds, perms);
// ════════════════════════════════════════════════════════════

export function scoreFraud(
  booking:          BookingInput,
  context:          ScoringContext,
  thresholds?:      FraudThresholds,
  permutationRules?: PermutationRule[],
): FraudReviewResult {
  const scorer = new FraudScorer(thresholds, permutationRules);
  return scorer.score(booking, context);
}