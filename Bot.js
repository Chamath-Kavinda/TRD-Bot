require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
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
const isYouTube = (url) => /youtube\.com|youtu\.be/i.test(url);
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
  : isYouTube(url) ? 'YouTube'
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
// yt-dlp helpers
// ---------------------------------------------------------------
function commonArgs(url) {
  const a = ['--no-playlist', '--no-warnings'];
  if (process.env.COOKIES_FILE) a.push('--cookies', process.env.COOKIES_FILE);
  if (isYouTube(url)) a.push('--js-runtimes', YT_JS_RUNTIME);
  return a;
}

// mode: 'video' | 'audio'   height: exact video height (YouTube only)
function ytdlp(url, dir, mode = 'video', height) {
  let format = 'bv*[vcodec^=avc1]+ba[acodec^=mp4a]/bv*+ba/b'; // Instagram / TikTok
  let extra = ['--merge-output-format', 'mp4'];

  if (mode === 'audio') {
    format = 'ba/b';
    extra = ['-x', '--audio-format', 'mp3', '--audio-quality', '0'];
  } else if (height) {
    const H = height;
    const V = MAX_MB - 6; // room for the audio track
    const fit = `[filesize<?${V}M][filesize_approx<?${V}M]`;
    format =
      `bv*[height=${H}][vcodec^=avc1]${fit}+ba[acodec^=mp4a]` + // H.264 that fits
      `/bv*[height=${H}]${fit}+ba` +                             // any codec that fits
      `/b[height=${H}]/bv*[height<=${H}]${fit}+ba`;
  }

  const args = ['-f', format, ...extra, ...commonArgs(url), '-o', path.join(dir, '%(id)s.%(ext)s'), url];
  return new Promise((resolve, reject) =>
    execFile(YTDLP, args, { timeout: 180000 }, (err, _out, stderr) =>
      err ? reject(new Error(stderr || err.message)) : resolve()
    )
  );
}

// Reads video metadata (title, duration, all formats) without downloading
function fetchYtInfo(url) {
  const args = ['-J', ...commonArgs(url), url];
  return new Promise((resolve, reject) =>
    execFile(YTDLP, args, { timeout: 60000, maxBuffer: 64 * 1024 * 1024 }, (err, out, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      try {
        const info = JSON.parse(out);
        resolve({
          title: info.title || 'YouTube video',
          channel: info.uploader || info.channel || '',
          duration: info.duration || 0,
          live: !!info.is_live,
          formats: (info.formats || []).map((f) => ({
            height: f.height,
            width: f.width,
            vcodec: f.vcodec,
            acodec: f.acodec,
            size: f.filesize || f.filesize_approx || null,
            tbr: f.tbr || 0,
            abr: f.abr || 0,
          })),
        });
      } catch (e) {
        reject(new Error('Could not read video info'));
      }
    })
  );
}

// ---- quality options ----
// Lists the video heights that exist and fit under Telegram's upload limit
function qualityOptions(meta) {
  const isVid = (f) => f.height && f.vcodec && f.vcodec !== 'none';
  const isAud = (f) => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none');

  const bestAudio = meta.formats.filter(isAud).sort((a, b) => b.abr - a.abr)[0];
  const audioSize = (bestAudio && bestAudio.size) || 0;

  // group by height, keep only streams that fit the limit (or have unknown size),
  // prefer H.264 (plays everywhere), then higher bitrate
  const score = (f) => (f.vcodec.startsWith('avc1') ? 1e6 : 0) + f.tbr;
  const totalSize = (f) => {
    const hasAudio = f.acodec && f.acodec !== 'none';
    return f.size ? f.size + (hasAudio ? 0 : audioSize) : null;
  };
  const groups = new Map();
  for (const f of meta.formats.filter(isVid)) {
    if (!groups.has(f.height)) groups.set(f.height, []);
    groups.get(f.height).push(f);
  }

  const list = [];
  let hidden = 0;
  for (const [height, fs_] of groups) {
    const fitting = fs_.filter((f) => totalSize(f) === null || totalSize(f) <= MAX_BYTES);
    if (!fitting.length) { hidden++; continue; }
    const f = fitting.sort((x, y) => score(y) - score(x))[0];
    list.push({
      height, // used for downloading
      label: Math.min(f.width || f.height, f.height), // 1080x1920 shorts show as 1080p
      size: totalSize(f),
    });
  }
  list.sort((x, y) => y.height - x.height);
  return { list, hidden };
}
// ---- end quality options ----

const fmtDur = (s) => {
  s = Math.round(s || 0);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
};
const safeName = (t) => (t || 'audio').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'audio';
const lastLine = (msg) => msg.split('\n').filter(Boolean).pop().slice(0, 120);

// ---------------------------------------------------------------
// Download + send one file, then clean up
// ---------------------------------------------------------------
async function job(ctx, url, statusId, mode, height, opts = {}) {
  running++;
  const dir = path.join(os.tmpdir(), 'trd-' + crypto.randomBytes(6).toString('hex'));
  try {
    await fs.mkdir(dir, { recursive: true });
    await ytdlp(url, dir, mode, height);

    const ext = mode === 'audio' ? '.mp3' : '.mp4';
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith(ext));
    if (!files.length) throw new Error('No video downloaded (too long, private, or blocked).');
    const file = path.join(dir, files[0]);

    const { size } = await fs.stat(file);
    if (size > MAX_BYTES)
      throw new Error(`File is ${(size / 1048576).toFixed(0)}MB, over Telegram's limit.`);

    if (mode === 'audio') {
      const m = opts.meta || {};
      await ctx.replyWithAudio(
        { source: file, filename: safeName(m.title) + '.mp3' },
        { title: m.title, performer: m.channel, duration: Math.round(m.duration || 0) }
      );
    } else {
      await ctx.replyWithVideo({ source: file }, { supports_streaming: true });
    }
    logUse(ctx, url, 'SENT', [opts.label, (size / 1048576).toFixed(1) + 'MB'].filter(Boolean).join(' · '));
  } catch (e) {
    const reason = lastLine(e.message);
    logUse(ctx, url, 'FAILED', [opts.label, reason].filter(Boolean).join(' · '));
    await ctx.reply('❌ Failed: ' + reason).catch(() => {});
  } finally {
    running--;
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    if (statusId) ctx.telegram.deleteMessage(ctx.chat.id, statusId).catch(() => {});
  }
}

// ---------------------------------------------------------------
// YouTube: choose Video / Audio, then quality
// ---------------------------------------------------------------
const pending = new Map(); // token -> { url, userId, meta, choiceMsgId, created }
setInterval(() => {
  for (const [k, v] of pending) if (Date.now() - v.created > 30 * 60 * 1000) pending.delete(k);
}, 5 * 60 * 1000).unref();

async function handleYouTube(ctx, url) {
  logUse(ctx, url, 'REQUEST');
  const status = await ctx.reply('🔍 Checking video...');
  try {
    const meta = await fetchYtInfo(url);
    if (meta.live) throw new Error('Live streams are not supported.');
    if (meta.duration > YT_MAX_MINUTES * 60)
      throw new Error(`Video is ${fmtDur(meta.duration)} long. Max is ${YT_MAX_MINUTES} min.`);

    const token = crypto.randomBytes(4).toString('hex');
    const sent = await ctx.reply(
      `${meta.title}\n👤 ${meta.channel || 'Unknown'} · ⏱ ${fmtDur(meta.duration)}\n\nWhat do you want to download?`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback('🎬 Video', `yt:v:${token}`),
          Markup.button.callback('🎵 Audio (MP3)', `yt:a:${token}`),
        ],
      ])
    );
    pending.set(token, { url, userId: ctx.from.id, meta, choiceMsgId: sent.message_id, created: Date.now() });
  } catch (e) {
    const reason = lastLine(e.message);
    logUse(ctx, url, 'FAILED', reason);
    await ctx.reply('❌ Failed: ' + reason);
  } finally {
    ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
  }
}

bot.action(/^yt:([avqc]):([0-9a-f]{8})(?::(\d+))?$/, async (ctx) => {
  const [, act, token, h] = ctx.match;
  const entry = pending.get(token);
  if (!entry)
    return ctx.answerCbQuery('This request expired. Please send the link again.', { show_alert: true });
  if (ctx.from.id !== entry.userId)
    return ctx.answerCbQuery('This request belongs to another user.', { show_alert: true });

  const msgId = ctx.callbackQuery.message.message_id;

  // Cancel the quality list
  if (act === 'c') {
    await ctx.answerCbQuery();
    return ctx.deleteMessage().catch(() => {});
  }

  // Video chosen -> new message listing the available qualities
  if (act === 'v') {
    const { list, hidden } = qualityOptions(entry.meta);
    if (!list.length)
      return ctx.answerCbQuery("No video quality fits Telegram's size limit. Try Audio.", { show_alert: true });
    await ctx.answerCbQuery();

    const buttons = list.map((o) =>
      Markup.button.callback(
        `🎬 ${o.label}p${o.size ? ' · ~' + Math.max(1, Math.round(o.size / 1048576)) + ' MB' : ''}`,
        `yt:q:${token}:${o.height}`
      )
    );
    const rows = [];
    for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
    rows.push([Markup.button.callback('✖ Cancel', `yt:c:${token}`)]);

    let text = `📺 Available qualities\n${entry.meta.title}`;
    if (hidden) text += `\n\n⚠️ ${hidden} higher quality option(s) hidden: over Telegram's ${MAX_MB} MB limit.`;
    return ctx.reply(text, Markup.inlineKeyboard(rows));
  }

  // Audio (a) or a chosen quality (q) -> download
  if (running >= MAX_PARALLEL)
    return ctx.answerCbQuery('Busy, try again in a moment.', { show_alert: true });

  let height, label;
  if (act === 'q') {
    height = Number(h);
    const opt = qualityOptions(entry.meta).list.find((o) => o.height === height);
    if (!opt) return ctx.answerCbQuery('That quality is not available.', { show_alert: true });
    label = `Video ${opt.label}p`;
  } else {
    label = 'Audio MP3';
  }

  await ctx.answerCbQuery();
  if (act === 'q') ctx.telegram.deleteMessage(ctx.chat.id, entry.choiceMsgId).catch(() => {});
  await ctx.editMessageText(act === 'a' ? '⏳ Converting to MP3...' : `⏳ Downloading ${label.replace('Video ', '')}...`).catch(() => {});

  await job(ctx, entry.url, msgId, act === 'a' ? 'audio' : 'video', height, { label, meta: entry.meta });
  pending.delete(token);
});

// ---------------------------------------------------------------
// Commands / messages
// ---------------------------------------------------------------
bot.start((ctx) => {
  logUse(ctx, '-', 'START');
  return ctx.reply(
    "Welcome to TRD Bot! Send me an Instagram Reel, TikTok or YouTube link.\n\n" +
      "• Instagram / TikTok: I'll send the video without watermark.\n" +
      '• YouTube: you can choose Video (with quality) or Audio (MP3).'
  );
});

bot.on('text', async (ctx) => {
  const match = ctx.message.text.match(URL_RE);
  if (!match) return ctx.reply('Send a valid Instagram, TikTok or YouTube link.');
  const url = match[0];

  if (isYouTube(url)) return handleYouTube(ctx, url);

  if (running >= MAX_PARALLEL) return ctx.reply('Busy, try again in a moment.');
  logUse(ctx, url, 'REQUEST');
  const status = await ctx.reply('⏳ Downloading...');
  return job(ctx, url, status.message_id, 'video');
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