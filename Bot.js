require('dotenv').config();
const { Telegraf } = require('telegraf');
const { execFile } = require('child_process');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

if (!process.env.BOT_TOKEN) {
  console.error('❌ BOT_TOKEN is missing. Add it to your .env file.');
  process.exit(1);
}

const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';

const bot = new Telegraf(process.env.BOT_TOKEN, {
  telegram: process.env.API_ROOT ? { apiRoot: process.env.API_ROOT } : {},
  handlerTimeout: 5 * 60 * 1000,
});

const MAX_MB = process.env.API_ROOT ? 2000 : 50;
const MAX_BYTES = MAX_MB * 1024 * 1024;
const YT_MAX_MINUTES = Number(process.env.YT_MAX_MINUTES) || 15; // longest YouTube video allowed
const YT_JS_RUNTIME = process.env.YT_JS_RUNTIME || 'node';       // JS runtime yt-dlp uses for YouTube
const URL_RE = /https?:\/\/(?:[\w-]+\.)?(?:instagram\.com|tiktok\.com|youtube\.com|youtu\.be)\/\S+/i;
const MAX_PARALLEL = 3;
let running = 0;

// ---------------------------------------------------------------
// Usage logging: console + Google Sheet
// ---------------------------------------------------------------
const SHEET_URL = process.env.SHEET_WEBHOOK_URL;

const pad = (n) => String(n).padStart(2, '0');
function localStamp() {
  const d = new Date(); // your PC's local time
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
  };
}

async function sendToSheet(r) {
  if (!SHEET_URL) return;
  await fetch(SHEET_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: process.env.SHEET_SECRET || '', ...r }),
  });
}

const platformOf = (url) =>
  /tiktok\.com/i.test(url) ? 'TikTok'
  : /instagram\.com/i.test(url) ? 'Instagram'
  : /youtube\.com|youtu\.be/i.test(url) ? 'YouTube'
  : '-';

// status: START | REQUEST | SENT | FAILED
// START and REQUEST are console-only; only SENT and FAILED go to the Google Sheet
function logUse(ctx, url, status, info = '') {
  const u = ctx.from || {};
  const rec = {
    ...localStamp(),
    userId: u.id,
    username: u.username ? '@' + u.username : '-',
    name: [u.first_name, u.last_name].filter(Boolean).join(' '),
    status,
    platform: platformOf(url),
    url,
    info,
  };

  console.log(
    `${rec.date} ${rec.time} | ${status} | ${rec.platform} | ${rec.username} (${rec.userId}) ${rec.name} | ${url}${info ? ' | ' + info : ''}`
  );

  if (status !== 'SENT' && status !== 'FAILED') return;
  sendToSheet(rec).catch((e) => console.warn('Sheet log failed:', e.message));
}

// ---------------------------------------------------------------
// Download
// ---------------------------------------------------------------
function ytdlp(url, dir) {
  const isYT = /youtube\.com|youtu\.be/i.test(url);

  // Instagram/TikTok: best H.264 video + AAC audio, merged to mp4.
  // YouTube: best quality that still fits under the upload limit
  // (`<?` also accepts formats whose size is unknown).
  const V = MAX_MB - 6; // room for the audio track
  const format = isYT
    ? `bv*[vcodec^=avc1][filesize<?${V}M][filesize_approx<?${V}M]+ba[acodec^=mp4a][filesize<?6M]` +
      `/b[ext=mp4][filesize<?${MAX_MB}M][filesize_approx<?${MAX_MB}M]/w`
    : 'bv*[vcodec^=avc1]+ba[acodec^=mp4a]/bv*+ba/b';

  const args = [
    '-f', format,
    '--merge-output-format', 'mp4',
    '--no-playlist',
    '--no-warnings',
    '-o', path.join(dir, '%(id)s.%(ext)s'),
  ];
  if (process.env.COOKIES_FILE) args.push('--cookies', process.env.COOKIES_FILE);
  if (isYT) {
    args.push('--js-runtimes', YT_JS_RUNTIME);
    args.push('--match-filter', `duration<=?${YT_MAX_MINUTES * 60} & !is_live`);
  }
  args.push(url);

  return new Promise((resolve, reject) =>
    execFile(YTDLP, args, { timeout: 180000 }, (err, _out, stderr) =>
      err ? reject(new Error(stderr || err.message)) : resolve()
    )
  );
}

bot.start((ctx) => {
  logUse(ctx, '-', 'START');
  return ctx.reply('Welcome to TRD Bot! Send me an Instagram Reel, TikTok or YouTube link and I\'ll send back the video without watermark.');
});

bot.on('text', async (ctx) => {
  const match = ctx.message.text.match(URL_RE);
  if (!match) return ctx.reply('Send a valid Instagram, TikTok or YouTube link.');
  if (running >= MAX_PARALLEL) return ctx.reply('Busy, try again in a moment.');

  running++;
  logUse(ctx, match[0], 'REQUEST');
  const dir = path.join(os.tmpdir(), 'trd-' + crypto.randomBytes(6).toString('hex'));
  const status = await ctx.reply('⏳ Downloading...');

  try {
    await fs.mkdir(dir, { recursive: true });
    await ytdlp(match[0], dir);

    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.mp4'));
    if (!files.length) throw new Error('No video downloaded (too long, private, or blocked).');
    const file = path.join(dir, files[0]);

    const { size } = await fs.stat(file);
    if (size > MAX_BYTES)
      throw new Error(`Video is ${(size / 1048576).toFixed(0)}MB, over Telegram's limit.`);

    await ctx.replyWithVideo({ source: file }, { supports_streaming: true });
    logUse(ctx, match[0], 'SENT', (size / 1048576).toFixed(1) + 'MB');
  } catch (e) {
    const reason = e.message.split('\n').filter(Boolean).pop().slice(0, 120);
    logUse(ctx, match[0], 'FAILED', reason);
    await ctx.reply('❌ Failed: ' + reason);
  } finally {
    running--;
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    ctx.deleteMessage(status.message_id).catch(() => {});
  }
});

bot.catch((err) => console.error('Bot error:', err.message));

// --- Startup checks ---
// NOTE: bot.launch() only resolves when the bot STOPS, so don't log inside .then()
execFile(YTDLP, ['--version'], (err, out) => {
  if (err) console.warn('⚠️  yt-dlp NOT found. Downloads will fail. Fix PATH or set YTDLP_PATH in .env');
  else console.log('✅ yt-dlp', out.trim());
});

console.log(SHEET_URL ? '✅ Google Sheet logging ON' : 'ℹ️  Google Sheet logging OFF (set SHEET_WEBHOOK_URL to enable)');

bot.telegram
  .getMe()
  .then((me) => console.log(`✅ TRD Bot is running as @${me.username}. Send it a link in Telegram.`))
  .catch((e) => {
    console.error('❌ Cannot reach Telegram. Check BOT_TOKEN:', e.message);
    process.exit(1);
  });

bot.launch().catch((e) => {
  console.error('❌ Launch failed:', e.message);
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));