import { FraudThresholds } from '../types';

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