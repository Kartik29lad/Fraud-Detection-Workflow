import {
  BookingInput,
  ScoringContext,
  FraudThresholds,
  FiredSignal,
} from '../types';
import { SIGNAL_WEIGHTS } from './weights';

export function checkDuration(nights: number, t: FraudThresholds): FiredSignal[] {
  const signals: FiredSignal[] = [];

  if (nights >= t.longDuration) {
    signals.push({
      signalType:   'long_duration',
      scoreContrib: SIGNAL_WEIGHTS.long_duration,
      reason:       `Booking is ${nights} nights — agent baseline is ${t.longDuration}+ nights threshold`,
      detail: {
        nights,
        threshold:  t.longDuration,
        scoreAdded: SIGNAL_WEIGHTS.long_duration,
      },
    });
  }

  if (nights >= t.extremeDuration) {
    signals.push({
      signalType:   'long_duration',
      scoreContrib: 10,
      reason:       `Extreme stay: ${nights} nights >= extreme threshold (${t.extremeDuration})`,
      detail: {
        nights,
        extremeThreshold: t.extremeDuration,
        extraScoreAdded:  10,
      },
    });
  }

  return signals;
}

export function checkNationality(guestNationality: string, ctx: ScoringContext): FiredSignal[] {
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

export function checkAmount(totalAmount: number, amountPerNight: number, ctx: ScoringContext, t: FraudThresholds): FiredSignal[] {
  const threshold  = ctx.baseline.avgBookingAmount * t.highAmountMult;
  const multiplier = parseFloat((totalAmount / ctx.baseline.avgBookingAmount).toFixed(2));

  if (totalAmount > threshold) {
    return [{
      signalType:   'high_amount',
      scoreContrib: SIGNAL_WEIGHTS.high_amount,
      reason:       `Total $${totalAmount.toLocaleString()} is ${multiplier}× agent avg ($${ctx.baseline.avgBookingAmount}) — threshold: ${t.highAmountMult}×`,
      detail: {
        totalAmount,
        amountPerNight,
        agentAvgAmount:    ctx.baseline.avgBookingAmount,
        multiplierApplied: t.highAmountMult,
        actualMultiplier:  multiplier,
        computedThreshold: threshold,
        scoreAdded:        SIGNAL_WEIGHTS.high_amount,
      },
    }];
  }
  return [];
}

export function checkPropertyCap(amountPerNight: number, ctx: ScoringContext, t: FraudThresholds): FiredSignal[] {
  const capThreshold = ctx.property.normalMaxRate * t.propertyCapMult;

  if (amountPerNight > capThreshold) {
    return [{
      signalType:   'property_cap_breach',
      scoreContrib: SIGNAL_WEIGHTS.property_cap_breach,
      reason:       `Rate $${amountPerNight}/night exceeds property cap $${ctx.property.normalMaxRate} × ${t.propertyCapMult} = $${capThreshold}`,
      detail: {
        amountPerNight,
        propertyNormalMax:    ctx.property.normalMaxRate,
        multiplierApplied:    t.propertyCapMult,
        computedCapThreshold: capThreshold,
        propertyName:         ctx.property.name,
        scoreAdded:           SIGNAL_WEIGHTS.property_cap_breach,
      },
    }];
  }
  return [];
}

export function checkStarRating(ctx: ScoringContext, t: FraudThresholds): FiredSignal[] {
  const history = ctx.baseline.starRatingHistory;
  if (!history.length) return [];

  const agentAvgStar = history.reduce((a, b) => a + b, 0) / history.length;
  const delta        = parseFloat((agentAvgStar - ctx.property.starRating).toFixed(2));

  if (delta >= t.starDropDelta) {
    return [{
      signalType:   'low_star_mismatch',
      scoreContrib: SIGNAL_WEIGHTS.low_star_mismatch,
      reason:       `Property is ${ctx.property.starRating}★ — agent usually books ${agentAvgStar.toFixed(1)}★ (drop: ${delta} stars, threshold: ${t.starDropDelta})`,
      detail: {
        bookedStarRating:   ctx.property.starRating,
        agentAvgStarRating: agentAvgStar,
        delta,
        threshold:          t.starDropDelta,
        propertyName:       ctx.property.name,
        scoreAdded:         SIGNAL_WEIGHTS.low_star_mismatch,
      },
    }];
  }
  return [];
}

export function checkVelocity(ctx: ScoringContext, t: FraudThresholds): FiredSignal[] {
  if (ctx.velocity.bookingsLastHour >= t.velocityPerHour) {
    return [{
      signalType:   'velocity_spike',
      scoreContrib: SIGNAL_WEIGHTS.velocity_spike,
      reason:       `Agent made ${ctx.velocity.bookingsLastHour} bookings in last 60 min — threshold: ${t.velocityPerHour}`,
      detail: {
        bookingsLastHour: ctx.velocity.bookingsLastHour,
        threshold:        t.velocityPerHour,
        scoreAdded:       SIGNAL_WEIGHTS.velocity_spike,
      },
    }];
  }
  return [];
}

export function checkOffHours(bookingHour: number, t: FraudThresholds): FiredSignal[] {
  const inWindow = bookingHour >= t.offHoursStart || bookingHour < t.offHoursEnd;

  if (inWindow) {
    return [{
      signalType:   'off_hours',
      scoreContrib: SIGNAL_WEIGHTS.off_hours,
      reason:       `Booking at ${bookingHour}:00 falls in off-hours window (${t.offHoursStart}:00–${t.offHoursEnd}:00)`,
      detail: {
        bookingHour,
        offHoursStart: t.offHoursStart,
        offHoursEnd:   t.offHoursEnd,
        scoreAdded:    SIGNAL_WEIGHTS.off_hours,
      },
    }];
  }
  return [];
}

export function checkGeo(city: string, ctx: ScoringContext): FiredSignal[] {
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

export function checkNewAgent(ctx: ScoringContext, totalAmount: number): FiredSignal[] {
  if (ctx.agentMeta.isNewAgent && totalAmount > 1000) {
    return [{
      signalType:   'new_agent',
      scoreContrib: SIGNAL_WEIGHTS.new_agent,
      reason:       `New agent (${ctx.agentMeta.daysSinceCreated} days old) booking high value $${totalAmount.toLocaleString()}`,
      detail:       { daysSinceCreated: ctx.agentMeta.daysSinceCreated, totalAmount },
    }];
  }
  return [];
}

export function checkCancelRatio(ctx: ScoringContext): FiredSignal[] {
  const cr = ctx.cancelRatio;
  if (cr.cancelRatio >= 0.4 && cr.totalBookings >= 5) {
    return [{
      signalType:   'cancel_ratio',
      scoreContrib: SIGNAL_WEIGHTS.cancel_ratio,
      reason:       `High cancellation ratio: ${(cr.cancelRatio * 100).toFixed(0)}% (${cr.cancelledBookings}/${cr.totalBookings} bookings)`,
      detail:       { cancelRatio: cr.cancelRatio, cancelled: cr.cancelledBookings, total: cr.totalBookings },
    }];
  }
  return [];
}

export function checkAccountChange(ctx: ScoringContext): FiredSignal[] {
  if (ctx.agentMeta.daysSinceUpdated <= 0) {
    return [{
      signalType:   'account_change',
      scoreContrib: SIGNAL_WEIGHTS.account_change,
      reason:       `Agent account data changed ${ctx.agentMeta.daysSinceUpdated} day(s) before booking`,
      detail:       { daysSinceUpdated: ctx.agentMeta.daysSinceUpdated },
    }];
  }
  return [];
}

export function checkLeadTime(booking: BookingInput, nights: number): FiredSignal[] {
  const leadTimeDays = Math.floor(
    (booking.checkIn.getTime() - booking.bookedAt.getTime()) / (1000 * 60 * 60 * 24)
  );
  if (leadTimeDays <= 0 || leadTimeDays > 365) {
    return [{
      signalType:   'lead_time_anomaly',
      scoreContrib: SIGNAL_WEIGHTS.lead_time_anomaly,
      reason:       leadTimeDays <= 0
        ? `Same-day or past check-in booking (lead time: ${leadTimeDays} days)`
        : `Booking made ${leadTimeDays} days in advance — unusually far future`,
      detail:       { leadTimeDays },
    }];
  }
  return [];
}

export function checkRepeatGuest(ctx: ScoringContext): FiredSignal[] {
  if (ctx.repeatGuest.isRepeat) {
    return [{
      signalType:   'repeat_guest',
      scoreContrib: SIGNAL_WEIGHTS.repeat_guest,
      reason:       `Guest email seen ${ctx.repeatGuest.repeatCount} times across this agent's bookings`,
      detail:       { repeatCount: ctx.repeatGuest.repeatCount },
    }];
  }
  return [];
}

export function checkBlacklist(ctx: ScoringContext): FiredSignal[] {
  if (ctx.blacklist.isBlacklisted) {
    return [{
      signalType:   'blacklist_match',
      scoreContrib: SIGNAL_WEIGHTS.blacklist_match,
      reason:       `Guest email matches blacklist: ${ctx.blacklist.reason ?? 'no reason specified'}`,
      detail:       { reason: ctx.blacklist.reason },
    }];
  }
  return [];
}

export function checkFrequentEdits(ctx: ScoringContext): FiredSignal[] {
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

export function checkFakeNames(passengerName: string): FiredSignal[] {
  const fakeRegex = /^(test|asdf|qwerty|abc|guest|unknown|aaaa|user|none|nil|null)$/i;
  if (fakeRegex.test(passengerName) || (passengerName.length > 0 && passengerName.length < 3)) {
    return [{
      signalType:   'fake_name_detected',
      scoreContrib: SIGNAL_WEIGHTS.fake_name_detected,
      reason:       `Suspicious passenger name detected: "${passengerName}"`,
      detail:       { passengerName },
    }];
  }
  return [];
}

export function checkDisposableEmail(email: string): FiredSignal[] {
  const disposableDomains = ['mailinator.com', 'tempmail.com', 'sharklasers.com', 'guerrillamail.com', 'yopmail.com'];
  const domain = email.split('@')[1]?.toLowerCase();

  if (disposableDomains.includes(domain)) {
    return [{
      signalType:   'disposable_email',
      scoreContrib: SIGNAL_WEIGHTS.disposable_email,
      reason:       `Disposable email domain detected: @${domain}`,
      detail:       { email, domain },
    }];
  }
  return [];
}

export function checkGroupSize(currentRooms: number, avgRooms: number): FiredSignal[] {
  if (currentRooms > (avgRooms * 2) && currentRooms > 3) {
    return [{
      signalType:   'group_size_anomaly',
      scoreContrib: SIGNAL_WEIGHTS.group_size_anomaly,
      reason:       `Unusual room count: ${currentRooms} (Agent avg: ${avgRooms})`,
      detail:       { currentRooms, avgRooms },
    }];
  }
  return [];
}

export function checkDataQuality(booking: BookingInput): FiredSignal[] {
  if (!booking.guestPhone || booking.guestPhone.length < 5) {
    return [{
      signalType:   'data_quality_low',
      scoreContrib: SIGNAL_WEIGHTS.data_quality_low,
      reason:       `Mandatory data quality check failed (Phone missing or invalid)`,
      detail:       { phone: booking.guestPhone || 'MISSING' },
    }];
  }
  return [];
}

export function checkSubAgent(ctx: ScoringContext): FiredSignal[] {
  if (!ctx.subAgent.isSubAgent) return [];

  const isHighValue = ctx.baseline.avgBookingAmount > 0 &&
    (ctx.property.avgRate > ctx.baseline.avgBookingAmount * 2);

  const citySlug   = ctx.property.city.toLowerCase();
  const inKnownGeo = ctx.baseline.geoHistory.map(g => g.toLowerCase()).includes(citySlug);

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
        agentAvg:      ctx.baseline.avgBookingAmount,
        knownGeos:     ctx.baseline.geoHistory,
      },
    }];
  }
  return [];
}

export function checkConcurrentSessions(ctx: ScoringContext): FiredSignal[] {
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

export function checkIpReputation(ctx: ScoringContext): FiredSignal[] {
  const ip = ctx.ipReputation;
  if (!ip.isBlacklisted) return [];

  return [{
    signalType:   'ip_reputation',
    scoreContrib: SIGNAL_WEIGHTS.ip_reputation,
    reason:       `IP address is blacklisted — Source: ${ip.source ?? 'unknown'}, Reason: ${ip.reason ?? 'unknown'}`,
    detail: {
      isBlacklisted: ip.isBlacklisted,
      reason:        ip.reason,
      source:        ip.source,
      scoreAdded:    SIGNAL_WEIGHTS.ip_reputation,
    },
  }];
}

export function checkAccountFarming(ctx: ScoringContext): FiredSignal[] {
  const af = ctx.accountFarming;
  if (!af.isFarming) return [];

  return [{
    signalType:   'account_farming',
    scoreContrib: SIGNAL_WEIGHTS.account_farming,
    reason:       `${af.sameIpAgentCount} other agents active from same IP in last 24h — possible account farming`,
    detail: {
      sameIpAgentCount: af.sameIpAgentCount,
      scoreAdded:       SIGNAL_WEIGHTS.account_farming,
    },
  }];
}

export function checkRapidIpSwitch(ctx: ScoringContext): FiredSignal[] {
  const rs = ctx.rapidIpSwitch;
  if (!rs.isRapidSwitching) return [];

  return [{
    signalType:   'rapid_ip_switch',
    scoreContrib: SIGNAL_WEIGHTS.rapid_ip_switch,
    reason:       `Agent switched across ${rs.ipSwitchCount} IPs in last 10 minutes — possible proxy rotation`,
    detail: {
      ipSwitchCount: rs.ipSwitchCount,
      scoreAdded:    SIGNAL_WEIGHTS.rapid_ip_switch,
    },
  }];
}

export function checkFailedBookings(ctx: ScoringContext): FiredSignal[] {
  const fb = ctx.failedBookings;
  if (!fb.isSuspicious) return [];

  return [{
    signalType:   'failed_booking_attempts',
    scoreContrib: SIGNAL_WEIGHTS.failed_booking_attempts,
    reason:       `${fb.failureCount} failed booking attempts in last 1 hour — possible brute forcing`,
    detail: {
      failureCount: fb.failureCount,
      threshold:    3,
      scoreAdded:   SIGNAL_WEIGHTS.failed_booking_attempts,
    },
  }];
}

export function checkFailedPayments(ctx: ScoringContext): FiredSignal[] {
  const fp = ctx.failedPayments;
  if (!fp.isSuspicious) return [];

  return [{
    signalType:   'failed_payment_attempts',
    scoreContrib: SIGNAL_WEIGHTS.failed_payment_attempts,
    reason:       `${fp.failureCount} failed payment attempts in last 1 hour — possible card testing`,
    detail: {
      failureCount: fp.failureCount,
      threshold:    3,
      scoreAdded:   SIGNAL_WEIGHTS.failed_payment_attempts,
    },
  }];
}

export function checkChargebacks(ctx: ScoringContext): FiredSignal[] {
  const cb = ctx.chargebacks;
  if (!cb.hasChargebacks) return [];

  return [{
    signalType:   'chargeback_history',
    scoreContrib: SIGNAL_WEIGHTS.chargeback_history,
    reason:       `Agent has ${cb.chargebackCount} open chargeback(s) on record`,
    detail: {
      chargebackCount: cb.chargebackCount,
      scoreAdded:      SIGNAL_WEIGHTS.chargeback_history,
    },
  }];
}

export function checkCreditLimit(ctx: ScoringContext): FiredSignal[] {
  const cl = ctx.creditLimit;
  if (!cl.isAtRisk || cl.usagePct == null) return [];

  return [{
    signalType:   'credit_limit_risk',
    scoreContrib: SIGNAL_WEIGHTS.credit_limit_risk,
    reason:       `Agent credit usage at ${cl.usagePct}% — limit $${cl.creditLimit}, balance $${cl.currentBalance}`,
    detail: {
      creditLimit:    cl.creditLimit,
      currentBalance: cl.currentBalance,
      usagePct:       cl.usagePct,
      scoreAdded:     SIGNAL_WEIGHTS.credit_limit_risk,
    },
  }];
}

export function checkHighRiskNat(booking: BookingInput, ctx: ScoringContext): FiredSignal[] {
  const hr = ctx.highRiskNat;
  if (!hr.isHighRisk) return [];

  return [{
    signalType:   'high_risk_nationality',
    scoreContrib: SIGNAL_WEIGHTS.high_risk_nationality,
    reason:       `Guest nationality "${booking.guestNationality.toUpperCase()}" is high-risk — ${hr.reason ?? 'flagged in system'}`,
    detail: {
      nationality: booking.guestNationality,
      reason:      hr.reason,
      scoreAdded:  SIGNAL_WEIGHTS.high_risk_nationality,
    },
  }];
}

export function checkDocRequirement(ctx: ScoringContext): FiredSignal[] {
  const doc = ctx.docRequirement;
  if (!doc.requiresDocs || !doc.isMissing) return [];

  return [{
    signalType:   'doc_requirement_missing',
    scoreContrib: SIGNAL_WEIGHTS.doc_requirement_missing,
    reason:       `Destination requires "${doc.requiredDocType}" — passport: ${doc.hasPassport ? '✅' : '❌'}, visa: ${doc.hasVisa ? '✅' : '❌'}`,
    detail: {
      requiredDocType: doc.requiredDocType,
      hasPassport:     doc.hasPassport,
      hasVisa:         doc.hasVisa,
      scoreAdded:      SIGNAL_WEIGHTS.doc_requirement_missing,
    },
  }];
}

export function checkDuplicatePassenger(ctx: ScoringContext): FiredSignal[] {
  const dp = ctx.duplicatePassenger;
  if (!dp.isDuplicate) return [];

  return [{
    signalType:   'duplicate_passenger',
    scoreContrib: SIGNAL_WEIGHTS.duplicate_passenger,
    reason:       `Guest email/phone used across ${dp.duplicateCount} other agents — possible cluster fraud`,
    detail: {
      duplicateCount: dp.duplicateCount,
      scoreAdded:     SIGNAL_WEIGHTS.duplicate_passenger,
    },
  }];
}