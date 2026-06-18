import * as sql from 'mssql';
import * as dotenv from 'dotenv';
import path from 'path';
import logger from '../logger';

dotenv.config({ path: path.join(__dirname, '../.env') });

const config: sql.config = {
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server:   process.env.DB_SERVER?.split('\\')[0] || 'localhost',
  database: process.env.DB_NAME,
  options: {
    instanceName:           process.env.DB_SERVER?.split('\\')[1],
    trustServerCertificate: true,
    encrypt:                false,
  }
};

let poolPromise: Promise<sql.ConnectionPool> | null = null;

const MAX_RETRIES    = 3;
const RETRY_DELAY_MS = 5000;

export async function connectDB(): Promise<sql.ConnectionPool> {
  if (poolPromise) {
    try {
      const pool = await poolPromise;
      if (pool.connected) return pool;
      poolPromise = null;
    } catch {
      poolPromise = null;
    }
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      logger.info(`DB connection attempt ${attempt}/${MAX_RETRIES}`);
      const pool = await new sql.ConnectionPool(config).connect();
      logger.info('Connected to SQL Server');
      poolPromise = Promise.resolve(pool);
      return pool;
    } catch (err) {
      logger.error(`DB connection attempt ${attempt} failed`, { error: err });
      if (attempt < MAX_RETRIES) {
        logger.info(`Retrying in ${RETRY_DELAY_MS / 1000}s`);
        await new Promise(res => setTimeout(res, RETRY_DELAY_MS));
      } else {
        poolPromise = null;
        throw new Error(`DB connection failed after ${MAX_RETRIES} attempts`);
      }
    }
  }

  throw new Error('DB connection failed');
}

export async function getPool(): Promise<sql.ConnectionPool> {
  return connectDB();
}