import * as sql from 'mssql';
import { FraudThresholds, PermutationRule, SignalType, RiskLevel } from '../types';
import { DEFAULT_THRESHOLDS } from '../config/thresholds';

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

function safeParseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; }
  catch { return fallback; }
}