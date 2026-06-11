import * as sql from 'mssql';
import {
  AgentBaseline, PropertyContext, VelocityContext,
  ScoringContext, FraudThresholds, PermutationRule,
  DEFAULT_THRESHOLDS, RiskLevel, SignalType,
  AgentMeta, CancelRatioContext, RepeatGuestContext, BlacklistContext,FrequentEditsContext,
 SubAgentContext,
  SessionContext
} from './types';

export async function fetchScoringContext(
  agentId:    string,
  propertyId: string,
  pool:       sql.ConnectionPool,
  guestEmail?: string | null,
  bookingId?:  string,
  ipAddress?:  string | null,
): Promise<ScoringContext> {
 const [baseline, property, velocity, agentMeta, cancelRatio, repeatGuest, blacklist, frequentEdits, subAgent, sessionContext] = await Promise.all([
    fetchBaseline(agentId, pool),
    fetchProperty(propertyId, pool),
    fetchVelocity(agentId, pool),
    fetchAgentMeta(agentId, pool),
    fetchCancelRatio(agentId, pool),
    fetchRepeatGuest(agentId, guestEmail ?? null, pool),
    fetchBlacklist(guestEmail ?? null, pool),
    fetchFrequentEdits(bookingId ?? null, pool),
    fetchSubAgentContext(agentId, pool),
    fetchSessionContext(agentId, ipAddress, pool),
  ]);
  return { baseline, property, velocity, agentMeta, cancelRatio, repeatGuest, blacklist, frequentEdits, subAgent, sessionContext };
}

async function fetchBaseline(agentId: string, pool: sql.ConnectionPool): Promise<AgentBaseline> {
  const result = await pool.request()
    .input('agentId', sql.UniqueIdentifier, agentId)
    .query(`SELECT * FROM dbo.agent_baseline WHERE agent_id = @agentId`);

  const row = result.recordset[0];
  if (!row) {
    return {
      agentId, avgNights: 3, maxNightsEver: 0,
      avgBookingAmount: 0, maxBookingAmount: 0,
      avgBookingsPerDay: 0, nationalityHistory: [],
      geoHistory: [], starRatingHistory: [],
      typicalActiveHours: [], lookbackDays: 180,
      avgRoomsPerBooking: 1.2,
    };
  }
  return {
    agentId:            row.agent_id,
    avgNights:          row.avg_nights          ?? 3,
    maxNightsEver:      row.max_nights_ever      ?? 0,
    avgBookingAmount:   row.avg_booking_amount   ?? 0,
    maxBookingAmount:   row.max_booking_amount   ?? 0,
    avgBookingsPerDay:  row.avg_bookings_per_day ?? 0,
    nationalityHistory: safeParseJson(row.nationality_history, []),
    geoHistory:         safeParseJson(row.geo_history, []),
    starRatingHistory:  safeParseJson(row.star_rating_history, []),
    typicalActiveHours: safeParseJson(row.typical_active_hours, []),
    lookbackDays:       row.lookback_days        ?? 180,
    avgRoomsPerBooking: row.avg_rooms_per_booking ?? 1.2, 
  };
}

async function fetchProperty(propertyId: string, pool: sql.ConnectionPool): Promise<PropertyContext> {
  const result = await pool.request()
    .input('propertyId', sql.UniqueIdentifier, propertyId)
    .query(`SELECT * FROM dbo.properties WHERE property_id = @propertyId AND is_active = 1`);

  const row = result.recordset[0];
  if (!row) throw new Error(`Property not found: ${propertyId}`);

  return {
    propertyId:    row.property_id,
    name:          row.name,
    city:          row.city,
    country:       row.country,
    starRating:    row.star_rating,
    normalMaxRate: row.normal_max_rate ?? 9999,
    avgRate:       row.avg_rate        ?? 0,
  };
}

async function fetchVelocity(agentId: string, pool: sql.ConnectionPool): Promise<VelocityContext> {
  const result = await pool.request()
    .input('agentId', sql.UniqueIdentifier, agentId)
    .query(`
      SELECT COUNT(*) AS bookings_last_hour
      FROM dbo.bookings
      WHERE agent_id = @agentId
        AND booked_at >= DATEADD(MINUTE, -60, SYSDATETIMEOFFSET())
    `);

  return { bookingsLastHour: result.recordset[0]?.bookings_last_hour ?? 0 };
}

export async function fetchThresholds(pool: sql.ConnectionPool): Promise<FraudThresholds> {
  const result = await pool.request()
    .query(`SELECT signal_type, threshold_value, score_weight FROM dbo.fraud_thresholds`);

  const map: Record<string, number> = {};
  result.recordset.forEach((r: any) => { map[r.signal_type] = r.threshold_value; });

  const get = (key: string, fallback: number): number => map[key] ?? fallback;

  return {
    longDuration:    get('long_duration',      DEFAULT_THRESHOLDS.longDuration),
    extremeDuration: get('extreme_duration',   DEFAULT_THRESHOLDS.extremeDuration),
    highAmountMult:  get('high_amount_mult',   DEFAULT_THRESHOLDS.highAmountMult),
    propertyCapMult: get('property_cap_mult',  DEFAULT_THRESHOLDS.propertyCapMult),
    velocityPerHour: get('velocity_per_hour',  DEFAULT_THRESHOLDS.velocityPerHour),
    offHoursStart:   get('off_hours_start',    DEFAULT_THRESHOLDS.offHoursStart),
    offHoursEnd:     get('off_hours_end',      DEFAULT_THRESHOLDS.offHoursEnd),
    starDropDelta:   get('star_drop_delta',    DEFAULT_THRESHOLDS.starDropDelta),
    scoreReview:     get('score_review',       DEFAULT_THRESHOLDS.scoreReview),
    scoreBlock:      get('score_block',        DEFAULT_THRESHOLDS.scoreBlock),
    scoreSuspend:    get('score_suspend',      DEFAULT_THRESHOLDS.scoreSuspend),
  };
}

export async function fetchPermutationRules(pool: sql.ConnectionPool): Promise<PermutationRule[]> {
  const result = await pool.request()
    .query(`
      SELECT rule_id, rule_name, combo_signals, bonus_score, severity, description
      FROM dbo.fraud_permutation_rules
      WHERE is_active = 1
    `);

  return result.recordset.map((r: any) => ({
    ruleId:       r.rule_id,
    ruleName:     r.rule_name,
    comboSignals: safeParseJson<SignalType[]>(r.combo_signals, []),
    bonusScore:   r.bonus_score,
    severity:     r.severity as RiskLevel,
    description:  r.description,
  }));
}

async function fetchAgentMeta(agentId: string, pool: sql.ConnectionPool): Promise<AgentMeta> {
  const result = await pool.request()
    .input('agentId', sql.UniqueIdentifier, agentId)
    .query(`SELECT status, created_at, updated_at FROM dbo.agents WHERE source_id = @agentId`);

  const row = result.recordset[0];
  if (!row) return { isNewAgent: false, daysSinceCreated: 999, daysSinceUpdated: 999 };

  const now = new Date();
  const created = new Date(row.created_at);
  const updated = row.updated_at ? new Date(row.updated_at) : null;

  return {
    isNewAgent:         row.status === 'active' && (now.getTime() - created.getTime()) < 90 * 24 * 60 * 60 * 1000,
    daysSinceCreated:   Math.floor((now.getTime() - created.getTime()) / (1000 * 60 * 60 * 24)),
    daysSinceUpdated:   updated ? Math.floor((now.getTime() - updated.getTime()) / (1000 * 60 * 60 * 24)) : 999,
  };
}

async function fetchCancelRatio(agentId: string, pool: sql.ConnectionPool): Promise<CancelRatioContext> {
  const result = await pool.request()
    .input('agentId', sql.UniqueIdentifier, agentId)
    .query(`
      SELECT
        COUNT(*) AS total_bookings,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_bookings
      FROM dbo.bookings
      WHERE agent_id = @agentId
    `);

  const row = result.recordset[0];
  const total     = row?.total_bookings     ?? 0;
  const cancelled = row?.cancelled_bookings ?? 0;
  const ratio     = total > 0 ? cancelled / total : 0;

  return { totalBookings: total, cancelledBookings: cancelled, cancelRatio: ratio };
}

async function fetchRepeatGuest(agentId: string, guestEmail: string | null, pool: sql.ConnectionPool): Promise<RepeatGuestContext> {
  if (!guestEmail) return { repeatCount: 0, isRepeat: false };

  const result = await pool.request()
    .input('agentId',    sql.UniqueIdentifier, agentId)
    .input('guestEmail', sql.NVarChar(150),    guestEmail)
    .query(`
      SELECT COUNT(*) AS repeat_count
      FROM dbo.bookings
      WHERE agent_id    = @agentId
        AND guest_email = @guestEmail
        AND status NOT IN ('cancelled', 'pending')
    `);

  const count = result.recordset[0]?.repeat_count ?? 0;
  return { repeatCount: count, isRepeat: count >= 2 };
}

async function fetchBlacklist(guestEmail: string | null, pool: sql.ConnectionPool): Promise<BlacklistContext> {
  if (!guestEmail) return { isBlacklisted: false, reason: null };

  const result = await pool.request()
    .input('email', sql.NVarChar(150), guestEmail)
    .query(`
      SELECT TOP 1 reason FROM dbo.blacklist
      WHERE email     = @email
        AND is_active = 1
    `);

  if (result.recordset.length === 0) return { isBlacklisted: false, reason: null };
  return { isBlacklisted: true, reason: result.recordset[0].reason };
}

async function fetchFrequentEdits(bookingId: string | null, pool: sql.ConnectionPool): Promise<FrequentEditsContext> {
  if (!bookingId) return { amendmentCount: 0, isFrequent: false };

  const result = await pool.request()
    .input('bookingId', sql.UniqueIdentifier, bookingId)
    .query(`
      SELECT COUNT(*) AS amendment_count
      FROM dbo.booking_amendments
      WHERE booking_id = @bookingId
    `);

  const count = result.recordset[0]?.amendment_count ?? 0;
  return { amendmentCount: count, isFrequent: count >= 2 };
}

async function fetchSubAgentContext(agentId: string, pool: sql.ConnectionPool): Promise<SubAgentContext> {
  const result = await pool.request()
    .input('agentId', sql.UniqueIdentifier, agentId)
    .query(`
      SELECT is_sub_agent, parent_agent_id
      FROM dbo.agents
      WHERE source_id = @agentId
    `);

  const row = result.recordset[0];
  if (!row) return { isSubAgent: false, parentAgentId: null };

  return {
    isSubAgent:    row.is_sub_agent === true || row.is_sub_agent === 1,
    parentAgentId: row.parent_agent_id ?? null,
  };
}

async function fetchSessionContext(
  agentId:   string,
  currentIp: string | null | undefined,
  pool:      sql.ConnectionPool,
): Promise<SessionContext> {
  if (!currentIp) return { concurrentSessionCount: 0, distinctIPs: [], hasConcurrentSessions: false };

  // Upsert current session — mark agent as active from this IP
  await pool.request()
    .input('agentId',   sql.UniqueIdentifier, agentId)
    .input('ip',        sql.VarChar(45),       currentIp)
    .query(`
      IF EXISTS (
        SELECT 1 FROM dbo.agent_sessions
        WHERE agent_id   = @agentId
          AND ip_address = @ip
          AND is_active  = 1
      )
        UPDATE dbo.agent_sessions
        SET last_seen_at = SYSDATETIMEOFFSET()
        WHERE agent_id   = @agentId
          AND ip_address = @ip
          AND is_active  = 1
      ELSE
        INSERT INTO dbo.agent_sessions (agent_id, ip_address, created_at, last_seen_at, is_active)
        VALUES (@agentId, @ip, SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), 1)
    `);

  // Fetch all distinct active IPs for this agent in last 30 minutes
  const result = await pool.request()
    .input('agentId', sql.UniqueIdentifier, agentId)
    .query(`
      SELECT DISTINCT ip_address
      FROM dbo.agent_sessions
      WHERE agent_id    = @agentId
        AND is_active   = 1
        AND last_seen_at >= DATEADD(MINUTE, -30, SYSDATETIMEOFFSET())
    `);

  const ips: string[] = result.recordset.map((r: any) => r.ip_address);

  return {
    concurrentSessionCount: ips.length,
    distinctIPs:            ips,
    hasConcurrentSessions:  ips.length >= 2,
  };
}

function safeParseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; }
  catch { return fallback; }
}