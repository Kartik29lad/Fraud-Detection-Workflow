// ============================================================
//  FRAUD DETECTION ENGINE — Type Definitions
//  All types mirror the MSSQL schema exactly.
// ============================================================

// ── Input: what you pass in at booking time ─────────────────

/** The incoming booking request — raw data before saving to DB */
export interface BookingInput {
  bookingId:        string;
  agentId:          string;
  propertyId:       string;
  guestNationality: string;
  guestEmail?:      string | null;
  checkIn:          Date;
  checkOut:         Date;
  amountPerNight:   number;
  bookedAt:         Date;
  passengerName?:   string;
  roomCount?:       number;
  guestPhone?:      string;
  ipAddress?:     string | null;
  sessionId?:     string | null;
}

// ── Context: data pulled from DB before scoring ─────────────

/** Agent's rolling baseline — from agent_baseline table */
export interface AgentBaseline {
  agentId:            string;
  avgNights:          number;
  maxNightsEver:      number;
  avgBookingAmount:   number;
  maxBookingAmount:   number;
  avgBookingsPerDay:  number;
  nationalityHistory: string[];      // e.g. ["GB","US","FR"]
  geoHistory:         string[];      // e.g. ["london","paris"]
  starRatingHistory:  number[];      // e.g. [3,4,4,5]
  typicalActiveHours: number[];      // e.g. [9,10,11,14,15,16]
  lookbackDays:       number;        // default 180
  avgRoomsPerBooking: number;
}

/** Property data — from properties table */
export interface PropertyContext {
  propertyId:    string;
  name:          string;
  city:          string;
  country:       string;
  starRating:    number;             // 1–5
  normalMaxRate: number;             // historical max nightly rate
  avgRate:       number;
}

/** Velocity data — bookings by this agent in last 60 min */
export interface VelocityContext {
  bookingsLastHour: number;
}

export interface AgentMeta {
  isNewAgent:       boolean;
  daysSinceCreated: number;
  daysSinceUpdated: number;
}

export interface CancelRatioContext {
  totalBookings:    number;
  cancelledBookings: number;
  cancelRatio:      number;
}

export interface RepeatGuestContext {
  repeatCount: number;
  isRepeat:    boolean;
}

export interface BlacklistContext {
  isBlacklisted: boolean;
  reason:        string | null;
}

export interface FrequentEditsContext {
  amendmentCount: number;
  isFrequent:     boolean;
}

export interface SubAgentContext {
  isSubAgent:      boolean;
  parentAgentId:   string | null;
}

export interface SessionContext {
  concurrentSessionCount: number;   // distinct active IPs right now
  distinctIPs:            string[]; // for detail logging
  hasConcurrentSessions:  boolean;
}
/** Everything the scorer needs — fetch all 3 before calling score() */
export interface ScoringContext {
  baseline:    AgentBaseline;
  property:    PropertyContext;
  velocity:    VelocityContext;
  agentMeta:   AgentMeta;
  cancelRatio: CancelRatioContext;
  repeatGuest: RepeatGuestContext;
  blacklist:   BlacklistContext;
  frequentEdits: FrequentEditsContext;
  subAgent: SubAgentContext;
  sessionContext:  SessionContext;
}

// ── Thresholds: from fraud_thresholds table ─────────────────

export interface FraudThresholds {
  longDuration:      number;   // default 15  nights
  extremeDuration:   number;   // default 25  nights
  highAmountMult:    number;   // default 3   × agent avg
  propertyCapMult:   number;   // default 1.5 × property max
  velocityPerHour:   number;   // default 5   bookings/hr
  offHoursStart:     number;   // default 23  (11pm)
  offHoursEnd:       number;   // default 5   (5am)
  starDropDelta:     number;   // default 2   stars below baseline
  scoreReview:       number;   // default 40
  scoreBlock:        number;   // default 70
  scoreSuspend:      number;   // default 90
}

export const DEFAULT_THRESHOLDS: FraudThresholds = {
  longDuration:    15,
  extremeDuration: 25,
  highAmountMult:  3,
  propertyCapMult: 1.5,
  velocityPerHour: 5,
  offHoursStart:   23,
  offHoursEnd:     5,
  starDropDelta:   2,
  scoreReview:     40,
  scoreBlock:      70,
  scoreSuspend:    90,
};

// ── Permutation combo rules ──────────────────────────────────

export interface PermutationRule {
  ruleId:       string;
  ruleName:     string;
  comboSignals: SignalType[];   // ALL must fire for bonus to apply
  bonusScore:   number;
  severity:     RiskLevel;
  description:  string;
}

// ── Signal types (mirrors CHECK constraint in DB) ────────────

export type SignalType =
  | 'long_duration'
  | 'new_nationality'
  | 'high_amount'
  | 'property_cap_breach'
  | 'low_star_mismatch'
  | 'velocity_spike'
  | 'off_hours'
  | 'new_geo'
  | 'new_agent'
  | 'cancel_ratio'
  | 'account_change'
  | 'lead_time_anomaly'
  | 'repeat_guest'
  | 'blacklist_match'
  | 'fake_name_detected'  
  | 'disposable_email'     
  | 'data_quality_low'     
  | 'group_size_anomaly'   
  | 'frequent_edits'       
  | 'sub_agent_anomaly'
  | 'concurrent_sessions';

// ── Output: what comes back from score() ────────────────────

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export type ActionTaken =
  | 'monitor'
  | 'flag_review'
  | 'hold'
  | 'block'
  | 'auto_suspend';

/** One fired signal — maps to a row in fraud_signals table */
export interface FiredSignal {
  signalType:   SignalType;
  scoreContrib: number;
  reason:       string;         // human-readable explanation
  detail:       Record<string, unknown>;  // actual vs baseline values → stored as JSON
}

/** One fired permutation combo */
export interface FiredCombo {
  ruleName:     string;
  bonusScore:   number;
  severity:     RiskLevel;
  description:  string;
}

/** Full fraud review object — ready to INSERT into fraud_reviews + fraud_signals */
export interface FraudReviewResult {
  // ── core scoring ──────────────────────────────────────────
  bookingId:       string;
  agentId:         string;
  totalScore:      number;           // 0–100 capped
  riskLevel:       RiskLevel;
  actionTaken:     ActionTaken;

  // ── signals ───────────────────────────────────────────────
  firedSignals:    FiredSignal[];    // individual signals → fraud_signals rows
  firedCombos:     FiredCombo[];     // permutation combos that matched

  // ── human-readable output ─────────────────────────────────
  primaryReason:   string;           // top signal plain English
  fullReason:      string;           // all signals joined
  recommendation:  string;           // what ops team should do

  // ── computed booking metrics (for DB insert) ──────────────
  nights:          number;
  totalAmount:     number;
  bookingHour:     number;

  // ── metadata ──────────────────────────────────────────────
  scoredAt:        Date;
  thresholdsUsed:  FraudThresholds;
}