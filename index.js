import "dotenv/config";
import axios from "axios";
import * as cheerio from "cheerio";
import fs from "node:fs/promises";
import { XMLParser } from "fast-xml-parser";

const WEBHOOKS = {
  news: process.env.DISCORD_WEBHOOK_NEWS,
  x: process.env.DISCORD_WEBHOOK_X,
  youtube: process.env.DISCORD_WEBHOOK_YOUTUBE,
  live: process.env.DISCORD_WEBHOOK_LIVE,
  official: process.env.DISCORD_WEBHOOK_OFFICIAL
};
const YOUTUBE_CHANNEL_ID = process.env.YOUTUBE_CHANNEL_ID;
const X_BEARER_TOKEN = process.env.X_BEARER_TOKEN;
const STATE_FILE = "./data/state.json";

const configuredWebhookCount = Object.values(WEBHOOKS).filter(Boolean).length;
if (configuredWebhookCount === 0) {
  console.error("Set at least one channel webhook in .env (DISCORD_WEBHOOK_NEWS, etc.).");
  process.exit(1);
}

const http = axios.create({
  timeout: 20000,
  headers: { "User-Agent": "SakanactionDiscordNotifier/1.0 (personal notification bot)" }
});

async function loadState() {
  try { return JSON.parse(await fs.readFile(STATE_FILE, "utf8")); }
  catch { return { seen: [], youtubeSeen: [], xSinceId: null }; }
}
async function saveState(state) {
  state.seen = state.seen.slice(-500);
  state.youtubeSeen = state.youtubeSeen.slice(-100);
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}
async function postDiscord(channel, title, url, source, description = "") {
  const webhook = WEBHOOKS[channel];
  if (!webhook) {
    console.log(`Webhook not configured for #${channel}; skipping notification.`);
    return;
  }
  const payload = {
    username: "サカナクション通知Bot",
    embeds: [{
      title: String(title).slice(0, 250),
      url,
      description: String(description || "公式情報が更新されました。").slice(0, 1000),
      color: 0x5865F2,
      footer: { text: `サカナクション公式情報 • ${source}` },
      timestamp: new Date().toISOString()
    }]
  };
  await http.post(webhook, payload);
}
function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
function absoluteUrl(href, base) {
  try { return new URL(href, base).href; } catch { return null; }
}

async function checkOfficialNews(state) {
  const url = "https://sakanaction.jp/news/";
  const { data } = await http.get(url);
  const $ = cheerio.load(data);
  const items = [];
  $("a[href]").each((_, el) => {
    const href = absoluteUrl($(el).attr("href"), url);
    const title = cleanText($(el).text());
    if (href && /\/news\/detail\//.test(href) && title.length > 3) {
      items.push({ key: `news:${href}`, title, url: href });
    }
  });
  await notifyNew(items, state, "公式サイト NEWS");
}

async function checkLiveInfo(state) {
  const url = "https://sakanaction.jp/";
  const { data } = await http.get(url);
  const $ = cheerio.load(data);
  const items = [];
  $("a[href]").each((_, el) => {
    const href = absoluteUrl($(el).attr("href"), url);
    const title = cleanText($(el).text());
    const context = cleanText($(el).parent().text());
    if (!href || !title || title.length < 3) return;
    const isLiveLink = /(live|tour|feature)/i.test(href) &&
      /(SAKANAQUARIUM|TOUR|ツアー|ライブ|公演|チケット)/i.test(`${title} ${context}`);
    if (isLiveLink) items.push({ key: `live:${href}`, title, url: href, description: context });
  });
  await notifyNew(items, state, "公式サイト LIVE / TOUR");
}

async function notifyNew(items, state, source) {
  const unique = [...new Map(items.map(x => [x.key, x])).values()];
  // On first run, record existing posts without flooding the Discord channel.
  if (!state.initialized) {
    state.seen.push(...unique.map(x => x.key));
    return;
  }
  for (const item of unique.reverse()) {
    if (state.seen.includes(item.key)) continue;
    const channel = source.includes("NEWS") ? "news" : "live";
    await postDiscord(channel, item.title, item.url, source, item.description || "");
    if (channel === "news" && /(お知らせ|重要|メディア|出演|掲載|リリース|配信|番組)/i.test(item.title)) {
      await postDiscord("official", item.title, item.url, "公式からのお知らせ", item.description || "");
    }
    state.seen.push(item.key);
    await saveState(state);
  }
}

async function checkYouTube(state) {
  if (!YOUTUBE_CHANNEL_ID) return;
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(YOUTUBE_CHANNEL_ID)}`;
  const { data } = await http.get(feedUrl);
  const parser = new XMLParser({ ignoreAttributes: false });
  const feed = parser.parse(data);
  const entries = feed?.feed?.entry ? [].concat(feed.feed.entry) : [];
  if (!state.youtubeInitialized) {
    state.youtubeSeen = entries.map(e => e["yt:videoId"]).filter(Boolean);
    state.youtubeInitialized = true;
    return;
  }
  for (const e of entries.reverse()) {
    const id = e["yt:videoId"];
    if (!id || state.youtubeSeen.includes(id)) continue;
    const title = cleanText(e.title) || "新しい動画";
    await postDiscord("youtube", title, `https://www.youtube.com/watch?v=${id}`, "公式YouTube");
    state.youtubeSeen.push(id);
    await saveState(state);
  }
}

async function checkX(state) {
  if (!X_BEARER_TOKEN) return;
  const params = new URLSearchParams({
    query: "from:sakanaction -is:retweet",
    max_results: "10",
    "tweet.fields": "created_at"
  });
  if (state.xSinceId) params.set("since_id", state.xSinceId);
  const { data } = await http.get(`https://api.x.com/2/tweets/search/recent?${params}`, {
    headers: { Authorization: `Bearer ${X_BEARER_TOKEN}` }
  });
  const tweets = data?.data || [];
  // First successful lookup establishes a baseline; do not announce old posts.
  if (!state.xSinceId) {
    if (data?.meta?.newest_id) state.xSinceId = data.meta.newest_id;
    return;
  }
  for (const tweet of tweets.reverse()) {
    await postDiscord("x", "公式Xの新しい投稿", `https://x.com/sakanaction/status/${tweet.id}`, "公式X", tweet.text);
  }
  if (data?.meta?.newest_id) state.xSinceId = data.meta.newest_id;
}

async function runChecks() {
  const state = await loadState();
  console.log(`[${new Date().toISOString()}] Checking official sources...`);
  const checks = [
    ["NEWS", () => checkOfficialNews(state)],
    ["LIVE", () => checkLiveInfo(state)],
    ["YouTube", () => checkYouTube(state)],
    ["X", () => checkX(state)]
  ];
  for (const [name, fn] of checks) {
    try { await fn(); console.log(`${name}: OK`); }
    catch (err) {
      console.error(`${name}:`, err.response?.status || err.message);
    }
  }
  state.initialized = true;
  await saveState(state);
}

await runChecks();
console.log("One-shot check completed.");
