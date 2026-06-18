import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { getPool } from '../db/pool';
import { requireApiKey } from '../middleware';
import { bookingRouter }    from './routes/booking';
import { fraudQueueRouter } from './routes/fraudQueue';
import { managerRouter }    from './routes/managerAction';
import { adminRouter }      from './routes/admin';
import logger from '../logger';

const app = express();

app.set('trust proxy', 1);

app.use(cors({
  origin:         'http://localhost:3001',
  methods:        ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-api-key', 'x-booking-source'],
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate limiter
const scoreLimiter = rateLimit({
  windowMs:       15 * 60 * 1000,
  max:            10,
  message:        { error: 'Too Many Requests', message: 'Max 10 booking score requests per 15 minutes.' },
  standardHeaders: true,
  legacyHeaders:  false,
});

app.use('/api/booking/score', scoreLimiter);
app.use('/api', requireApiKey);

// Health check
app.get('/', async (req, res) => {
  try {
    const pool = await getPool();
    await pool.request().query('SELECT 1 AS db_check');
    return res.json({
      status:    'healthy',
      api:       'running',
      db:        'connected',
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    return res.status(503).json({
      status:    'unhealthy',
      api:       'running',
      db:        'disconnected',
      error:     err.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// Routes
app.use('/api/booking',      bookingRouter);
app.use('/api/fraud-queue',  fraudQueueRouter);
app.use('/api/fraud-review', fraudQueueRouter);
app.use('/fraud-review',     managerRouter);
app.use('/api',              adminRouter);

const PORT = 3000;
app.listen(PORT, async () => {
  await getPool();
  logger.info(`Fraud Detection API running on http://localhost:${PORT}`);
});

export default app;