import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

/** Telegram refuses more than 4096 characters; the tag and a margin come out of it. */
const CHUNK = 3800;
const TIMEOUT_MS = 10_000;
/** A 429's retry_after is honoured up to this. */
const MAX_WAIT_MS = 120_000;

interface Outcome {
  ok: boolean;
  /** Worth another attempt: a 429, a 5xx, or no answer at all. */
  retriable?: boolean;
  /** How long Telegram asked us to wait (429 retry_after). */
  waitMs?: number;
  reason?: string;
}

function toPlain(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

function firstLine(text: string): string {
  const lines = toPlain(text)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  // A kind's hashtags alone say little in the log; the line after them says
  // what happened.
  const line =
    /^#\w+(?:\s+#\w+)*$/.test(lines[0] ?? '') && lines[1]
      ? `${lines[0]} ${lines[1]}`
      : lines[0];
  return (line ?? '').slice(0, 200);
}

/** Split on line breaks into pieces Telegram accepts; a giant line is cut. */
export function splitAlert(text: string, size = CHUNK): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    const pieces: string[] = [];
    for (let i = 0; i < line.length; i += size)
      pieces.push(line.slice(i, i + size));
    if (pieces.length === 0) pieces.push('');
    for (const piece of pieces) {
      if (current && current.length + 1 + piece.length > size) {
        out.push(current);
        current = piece;
      } else {
        current = current ? `${current}\n${piece}` : piece;
      }
    }
  }
  if (current) out.push(current);
  return out;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });

export interface AlertOptions {
  /**
   * The alert's kind as a hashtag (`limit` → `#limit`), first line after the
   * environment, so a kind can be searched for and told apart in the chat.
   * Several go on that one line (`['suspicious', 'volume']` →
   * `#suspicious #volume`): the kind first, then what narrows it.
   */
  tag?: string | string[];
}

/** A tag as Telegram searches it: lower case, `_` for anything else. */
const hashtag = (tag: string) => tag.toLowerCase().replace(/[^a-z0-9_]/g, '_');

/** `#tag` (or `#a #b`) on the first line, then the text. */
export function withTag(text: string, options: AlertOptions = {}): string {
  const tags = [
    ...new Set(
      (Array.isArray(options.tag) ? options.tag : [options.tag])
        .map((t) => hashtag(t ?? ''))
        .filter(Boolean),
    ),
  ];
  return tags.length ? `${tags.map((t) => `#${t}`).join(' ')}\n${text}` : text;
}

/**
 * The batch jobs' Telegram channel (BOT_TOKEN / TG_ALERT_CHAT_ID).
 *
 * It used to make one attempt and log a line when that failed, so a report
 * could simply vanish: a 429 when several nightly jobs finish together, a
 * network blip, a stray `<` in the HTML, a report over 4096 characters.
 * Now:
 * - a 429 waits the `retry_after` Telegram names, a network or 5xx failure
 *   backs off (2s, 10s, 60s) — four attempts in all;
 * - markup Telegram cannot parse is sent again as plain text, so the words
 *   arrive even when a tag does not;
 * - a long report goes in pieces, split on line breaks;
 * - a report that still does not arrive is written to the log **whole**, so
 *   it is in Kibana rather than nowhere, and so is a report sent where alerts
 *   are off (no BOT_TOKEN) — by its first line.
 *
 * `send` holds its caller for one attempt at most — the MIB trouble alert is
 * awaited inside a partner request — and retries in the background.
 * `deliver` waits for the retries and says whether the report arrived; the
 * jobs that record their runs use it.
 */
@Injectable()
export class TelegramAlertService {
  private readonly logger = new Logger(TelegramAlertService.name);
  private warnedOff = false;

  /** Delays before the 2nd, 3rd and 4th attempt. Tests shorten them. */
  static retryDelaysMs = [2_000, 10_000, 60_000];

  /**
   * Environment tag prepended to every alert so dev and prod are
   * distinguishable. SERVICE_ENVIRONMENT first: it is baked per build
   * (production / development), while dev may run with NODE_ENV=production.
   */
  private envTag(): string {
    const env =
      process.env.SERVICE_ENVIRONMENT || process.env.NODE_ENV || 'unknown';
    return /^prod/i.test(env)
      ? '🟢 <b>PROD</b>'
      : `🟡 <b>${env.toUpperCase().replace(/[<>&]/g, '')}</b>`;
  }

  /** One attempt awaited, retries in the background. Whether it arrived at once. */
  async send(text: string, options: AlertOptions = {}): Promise<boolean> {
    return this.dispatch(withTag(text, options), false);
  }

  /** Waits for the retries. Whether the whole report arrived. */
  async deliver(text: string, options: AlertOptions = {}): Promise<boolean> {
    return this.dispatch(withTag(text, options), true);
  }

  private async dispatch(text: string, wait: boolean): Promise<boolean> {
    const token = process.env.BOT_TOKEN;
    const chat = process.env.TG_ALERT_CHAT_ID;
    if (!token || !chat) {
      if (!this.warnedOff) {
        this.warnedOff = true;
        this.logger.warn(
          '[telegram] alerts are off here — BOT_TOKEN or TG_ALERT_CHAT_ID is unset',
        );
      }
      this.logger.log(`[telegram] not sent (alerts off): ${firstLine(text)}`);
      return false;
    }

    let delivered = true;
    for (const chunk of splitAlert(`${this.envTag()}\n${text}`)) {
      const ok = wait
        ? await this.withRetries(chunk, token, chat)
        : await this.firstThenBackground(chunk, token, chat);
      delivered = delivered && ok;
    }
    if (delivered) this.logger.log(`[telegram] sent: ${firstLine(text)}`);
    return delivered;
  }

  private async attempt(
    chunk: string,
    token: string,
    chat: string,
  ): Promise<Outcome> {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const post = (body: Record<string, unknown>) =>
      axios.post(
        url,
        { chat_id: chat, disable_web_page_preview: true, ...body },
        { timeout: TIMEOUT_MS },
      );
    try {
      await post({ text: chunk, parse_mode: 'HTML' });
      return { ok: true };
    } catch (err: any) {
      let failure = err;
      const status: number | undefined = err?.response?.status;
      const description = String(
        err?.response?.data?.description ?? err?.message ?? err,
      );
      if (
        status === 400 &&
        /parse entities|start tag|end tag/i.test(description)
      ) {
        // The markup is broken, not Telegram: send the words without it.
        try {
          await post({ text: toPlain(chunk) });
          this.logger.warn(
            `[telegram] HTML refused (${description}) — sent as plain text: ${firstLine(chunk)}`,
          );
          return { ok: true };
        } catch (plainErr) {
          failure = plainErr;
        }
      }
      const s: number | undefined = failure?.response?.status;
      const d = String(
        failure?.response?.data?.description ?? failure?.message ?? failure,
      );
      if (s === 429) {
        const after = Number(failure?.response?.data?.parameters?.retry_after);
        return {
          ok: false,
          retriable: true,
          waitMs: Number.isFinite(after) ? after * 1000 : 5_000,
          reason: `429 ${d}`,
        };
      }
      // No status: the request never got an answer. 5xx: Telegram's side.
      return {
        ok: false,
        retriable: s === undefined || s >= 500,
        reason: `${s ?? 'network'} ${d}`,
      };
    }
  }

  private async withRetries(
    chunk: string,
    token: string,
    chat: string,
    first?: Outcome,
  ): Promise<boolean> {
    let outcome = first ?? (await this.attempt(chunk, token, chat));
    const delays = TelegramAlertService.retryDelaysMs;
    for (
      let i = 0;
      !outcome.ok && outcome.retriable && i < delays.length;
      i++
    ) {
      await sleep(
        Math.min(Math.max(delays[i], outcome.waitMs ?? 0), MAX_WAIT_MS),
      );
      outcome = await this.attempt(chunk, token, chat);
    }
    if (!outcome.ok) {
      this.logger.error(
        `[telegram] alert NOT delivered (${outcome.reason}) — full text, so it is not lost:\n` +
          toPlain(chunk),
      );
      return false;
    }
    return true;
  }

  private async firstThenBackground(
    chunk: string,
    token: string,
    chat: string,
  ): Promise<boolean> {
    const first = await this.attempt(chunk, token, chat);
    if (first.ok) return true;
    if (!first.retriable) return this.withRetries(chunk, token, chat, first);
    this.logger.warn(
      `[telegram] send failed (${first.reason}) — retrying in the background: ${firstLine(chunk)}`,
    );
    void this.withRetries(chunk, token, chat, first).then((ok) => {
      if (ok) this.logger.log(`[telegram] sent on retry: ${firstLine(chunk)}`);
    });
    return false;
  }
}
