// One-off, safe to rerun: node dist/scripts/chamber/rating-history-backfill.cli.js [--dry-run] [--batch 5000]
import { Client } from 'pg';
import * as dotenv from 'dotenv';
import {
  BACKFILL_USAGE,
  backfillRatingHistory,
  parseBackfillArgs,
} from './rating-history-backfill';

dotenv.config();

async function main() {
  const args = parseBackfillArgs(process.argv.slice(2));
  if (!args) {
    console.error(BACKFILL_USAGE);
    process.exit(1);
  }
  const env = process.env;
  const db = new Client({
    host: env.POSTGRES_HOST || env.DB_HOST,
    port: Number(env.POSTGRES_PORT || env.DB_PORT || 5432),
    user: env.POSTGRES_USER || env.DB_USERNAME,
    password: env.POSTGRES_PASSWORD || env.DB_PASSWORD,
    database: env.POSTGRES_DB || env.DB_NAME,
    application_name: 'rating-history-backfill',
  });
  await db.connect();
  try {
    const { rows } = await db.query(
      `SELECT current_database() AS db, current_setting('TimeZone') AS tz`,
    );
    console.log(`connected to ${rows[0].db} · session TimeZone ${rows[0].tz}`);
    if (!['UTC', 'Etc/UTC'].includes(rows[0].tz)) {
      console.warn(
        `  WARNING: session TimeZone is ${rows[0].tz}, not UTC; timestamp-without-time-zone values are read in it`,
      );
    }
    const totals = await backfillRatingHistory(
      (sql, params) => db.query(sql, params).then((r) => r.rows),
      {
        dryRun: args.dryRun,
        batch: args.batch,
        log: (line) => console.log(`  ${line}`),
      },
    );
    if (args.dryRun) console.log('  dry run: current is an upper bound');
    console.log(JSON.stringify(totals));
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
