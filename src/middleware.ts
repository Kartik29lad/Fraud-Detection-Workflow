import { Request, Response, NextFunction } from 'express';
import * as dotenv from 'dotenv';
import * as crypto from 'crypto'; // <-- 1. Added crypto import

dotenv.config();

const API_KEYS = (process.env.API_KEYS || process.env.API_KEY || '')
  .split(',')
  .map(k => k.trim())
  .filter(Boolean);
const TOKEN_SECRET = process.env.TOKEN_SECRET;

function getTokenSecret(): string {
  if (!TOKEN_SECRET) {
    throw new Error('TOKEN_SECRET environment variable is required');
  }
  return TOKEN_SECRET;
}

export function requireApiKey(req: Request, res: Response, next: NextFunction) {
  const key = req.headers['x-api-key'];

  if (!key) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing API key. Add header: x-api-key'
    });
  }

  if (!API_KEYS.includes(key as string)) {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Invalid API key'
    });
  }

  next();
}

// Whitelist check for manager decision
export function validateDecision(decision: string): boolean {
  const allowed = ['approve_block', 'false_positive'];
  return allowed.includes(decision);
}

const BOOKING_SOURCE_SECRET = process.env.BOOKING_SOURCE_SECRET;

export function validateBookingSource(req: Request, res: Response, next: NextFunction) {
  const sourceSecret = req.headers['x-booking-source'];

  if (!sourceSecret) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing booking source header. Add header: x-booking-source'
    });
  }

  if (sourceSecret !== BOOKING_SOURCE_SECRET) {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Invalid booking source secret'
    });
  }

  next();
}

// --- 3. ADDED THE TWO NEW TOKEN FUNCTIONS BELOW ---

// Generates a short-lived secure token for the email link
export function generateExpiryToken(reviewId: string, expiresAt: number): string {
  return crypto
    .createHmac('sha256', getTokenSecret())
    .update(`${reviewId}:${expiresAt}`)
    .digest('hex');
}

// Validates if the link token is genuine and hasn't expired
export function verifyExpiryToken(reviewId: string, token: string, expiresAt: number): boolean {
  // Check if time is up (Date.now() gets current time in milliseconds)
  if (Date.now() > expiresAt) {
    return false; 
  }

  // Verify no one tampered with the URL
  const expectedToken = generateExpiryToken(reviewId, expiresAt);
  
  try {
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expectedToken));
  } catch (e) {
    return false; // Fails if someone tampered with the string
  }
}

// Generate 6-digit OTP
export function generateOTP(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}
