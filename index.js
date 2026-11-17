
import "dotenv/config";
import axios from "axios";
import * as cheerio from "cheerio";
import fs from "node:fs/promises";
import { XMLParser } from "fast-xml-parser";

const WEBHOOKS = {
  news: process.env.DISCORD_WEBHOOK_NEWS,
  youtube: process.env.DISCORD_WEBHOOK_YOUTUBE,
  live: process.env.DISCORD_WEBHOOK_LIVE,
  official: process.env.DISCORD_WEBHOOK_OFFICIAL,
  yamaguchi: process.env.DISCORD_WEBHOOK_YAMAGUCHI
};

const YOUTUBE_CHANNEL_ID = process.env.YOUTUBE_CHANNEL_ID;
const YAMAGUCHI_YOUTUBE_CHANNEL_ID = process.env.YAMAGUCHI_YOUTUBE_CHANNEL_ID;
const STATE_FILE = "./data/state.json";

const configuredWebhookCount =
  Object.values(WEBHOOKS).filter(Boolean).length;

if (configuredWebhookCount === 0) {
  console.error("No Discord webhook configured.");
  process.exit(1);
}

const http = axios.create({
  timeout: 20000,
  headers: {
    "User-Agent": "SakanactionDiscordNotifier/1.0"
  }
});

async function loadState() {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
  } catch {
    return {
      seen: [],
      youtubeSeen: [],
      yamaguchiYoutubeSeen: [],
      yamaguchiLiveScheduledSeen: [],
      yamaguchiLiveStartedSeen: []
    };
  }
}

async function saveState(state) {
  state.seen = (state.seen || []).slice(-500);
  state.youtubeSeen = (state.youtubeSeen || []).slice(-100);
  state.yamaguchiYoutubeSeen =
    (state.yamaguchiYoutubeSeen || []).slice(-100);

  await fs.writeFile(
    STATE_FILE,
    JSON.stringify(state, null, 2)
  );
}

async function postDiscord(
  channel,
  title,
  url,
  source,
  description = "",
  imageUrl = null
) {
  const webhook = WEBHOOKS[channel];

  if (!webhook) {
    console.log(`Webhook not configured: ${channel}`);
    return;
  }

  const embed = {
    title: String(title).slice(0, 250),
    url,
    description: String(
      description || "公式情報が更新されました。"
    ).slice(0, 1000),
    color: 0x5865F2,
    footer: {
      text: `サカナクション公式情報 • ${source}`
    },
    timestamp: new Date().toISOString()
  };

  if (imageUrl) {
    embed.image = {
      url: imageUrl
    };
  }

  await http.post(webhook, {
    username: "サカナクションメールサービス",
    embeds: [embed]
  });
}

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function absoluteUrl(href, base) {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

// NEWS記事のメイン画像を取得
async function getArticleImage(articleUrl) {
  try {
    const { data } = await http.get(articleUrl);
    const $ = cheerio.load(data);

    const image =
      $('meta[property="og:image"]').attr("content") ||
      $('meta[name="twitter:image"]').attr("content");

    return image
      ? absoluteUrl(image, articleUrl)
      : null;

  } catch (err) {
    console.error("Image fetch failed:", err.message);
    return null;
  }
}

async function checkOfficialNews(state) {
  const url = "https://sakanaction.jp/news/";
  const { data } = await http.get(url);
  const $ = cheerio.load(data);
  const items = [];

  $("a[href]").each((_, el) => {
    const href = absoluteUrl($(el).attr("href"), url);
    const title = cleanText($(el).text());

    if (
      href &&
      /\/news\/detail\//.test(href) &&
      title.length > 3
    ) {
      items.push({
        key: `news:${href}`,
        title,
        url: href
      });
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

    const isLiveLink =
      /(live|tour|feature)/i.test(href) &&
      /(SAKANAQUARIUM|TOUR|ツアー|ライブ|公演|チケット)/i.test(
        `${title} ${context}`
      );

    if (isLiveLink) {
      items.push({
        key: `live:${href}`,
        title,
        url: href,
        description: context
      });
    }
  });

  await notifyNew(items, state, "公式サイト LIVE / TOUR");
}

async function notifyNew(items, state, source) {
  const unique = [
    ...new Map(items.map(x => [x.key, x])).values()
  ];

  if (!state.initialized) {
    state.seen.push(...unique.map(x => x.key));
    return;
  }

  for (const item of unique.reverse()) {
    if (state.seen.includes(item.key)) continue;

    const channel = source.includes("NEWS")
      ? "news"
      : "live";

    // NEWS記事の画像を取得
    const imageUrl = channel === "news"
      ? await getArticleImage(item.url)
      : null;

    await postDiscord(
      channel,
      item.title,
      item.url,
      source,
      item.description || "",
      imageUrl
    );

    if (
      channel === "news" &&
      /(お知らせ|重要|メディア|出演|掲載|リリース|配信|番組)/i.test(
        item.title
      )
    ) {
      await postDiscord(
        "official",
        item.title,
        item.url,
        "公式からのお知らせ",
        item.description || "",
        imageUrl
      );
    }

    state.seen.push(item.key);
    await saveState(state);
  }
}

async function checkYouTubeChannel(
  state,
  channelId,
  webhook,
  seenKey,
  initializedKey,
  source
) {
  if (!channelId) {
    console.log(`${source}: channel ID not configured.`);
    return;
  }

  if (!WEBHOOKS[webhook]) {
    console.log(`${source}: webhook not configured.`);
    return;
  }

  const feedUrl =
    `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;

  const { data } = await http.get(feedUrl);

  const parser = new XMLParser({
    ignoreAttributes: false
  });

  const feed = parser.parse(data);

  const entries = feed?.feed?.entry
    ? [].concat(feed.feed.entry)
    : [];

  if (!state[initializedKey]) {
    state[seenKey] = entries
      .map(e => e["yt:videoId"])
      .filter(Boolean);

    state[initializedKey] = true;
    return;
  }

  for (const e of entries.reverse()) {
    const id = e["yt:videoId"];

    if (!id || state[seenKey].includes(id)) continue;

    const title = cleanText(e.title) || "新しい動画";

    await postDiscord(
      webhook,
      title,
      `https://www.youtube.com/watch?v=${id}`,
      source
    );

    state[seenKey].push(id);
    await saveState(state);
  }
}

async function checkYouTube(state) {
  await checkYouTubeChannel(
    state,
    YOUTUBE_CHANNEL_ID,
    "youtube",
    "youtubeSeen",
    "youtubeInitialized",
    "サカナクション公式YouTube"
  );
}


async function checkYamaguchiLiveStreams(state) {
  if (!YAMAGUCHI_YOUTUBE_CHANNEL_ID) {
    console.log("Yamaguchi live: channel ID not configured.");
    return;
  }

  if (!WEBHOOKS.yamaguchi) {
    console.log("Yamaguchi live: webhook not configured.");
    return;
  }

  state.yamaguchiLiveScheduledSeen ||= [];
  state.yamaguchiLiveStartedSeen ||= [];

  const feedUrl =
    `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(YAMAGUCHI_YOUTUBE_CHANNEL_ID)}`;

  const { data } = await http.get(feedUrl);

  const parser = new XMLParser({
    ignoreAttributes: false
  });

  const feed = parser.parse(data);

  const entries = feed?.feed?.entry
    ? [].concat(feed.feed.entry)
    : [];

  for (const entry of entries) {
    const id = entry["yt:videoId"];
    if (!id) continue;

    const videoUrl =
      `https://www.youtube.com/watch?v=${id}`;

    try {
      const { data: html } = await http.get(videoUrl);

      const match = html.match(
        /ytInitialPlayerResponse\s*=\s*(\{.*?\})\s*;/s
      );

      if (!match) continue;

      const player = JSON.parse(match[1]);

      const details =
        player?.microformat
          ?.playerMicroformatRenderer
          ?.liveBroadcastDetails;

      if (!details) continue;

      const title =
        cleanText(entry.title) || "山口一郎 ライブ配信";

      // 配信予定
      if (
        details.isUpcoming &&
        !state.yamaguchiLiveScheduledSeen.includes(id)
      ) {
        const startTime = details.startTimestamp
          ? new Date(details.startTimestamp).toLocaleString("ja-JP", {
              timeZone: "Asia/Tokyo"
            })
          : "日時未定";

        await postDiscord(
          "yamaguchi",
          `【ライブ配信予定】${title}`,
          videoUrl,
          "山口一郎チャンネル",
          `配信予定日時：${startTime}`
        );

        state.yamaguchiLiveScheduledSeen.push(id);
        await saveState(state);
      }

      // 配信開始
      if (
        details.isLiveNow &&
        !state.yamaguchiLiveStartedSeen.includes(id)
      ) {
        await postDiscord(
          "yamaguchi",
          `【ライブ配信開始】${title}`,
          videoUrl,
          "山口一郎チャンネル",
          "山口一郎チャンネルのライブ配信が始まりました！"
        );

        state.yamaguchiLiveStartedSeen.push(id);
        await saveState(state);
      }

    } catch (err) {
      console.error(
        `Yamaguchi live check failed (${id}):`,
        err.message
      );
    }
  }
}

async function checkYamaguchiYouTube(state) {
  await checkYouTubeChannel(
    state,
    YAMAGUCHI_YOUTUBE_CHANNEL_ID,
    "yamaguchi",
    "yamaguchiYoutubeSeen",
    "yamaguchiYoutubeInitialized",
    "山口一郎チャンネル"
  );

  await checkYamaguchiLiveStreams(state);
}

async function runChecks() {
  const state = await loadState();

  console.log(
    `[${new Date().toISOString()}] Checking official sources...`
  );

  const checks = [
    ["NEWS", () => checkOfficialNews(state)],
    ["LIVE", () => checkLiveInfo(state)],
    ["YouTube", () => checkYouTube(state)],
    ["山口一郎YouTube", () => checkYamaguchiYouTube(state)],
  ];

  for (const [name, fn] of checks) {
    try {
      await fn();
      console.log(`${name}: OK`);
    } catch (err) {
      console.error(
        `${name}:`,
        err.response?.status || err.message
      );
    }
  }

  state.initialized = true;
  await saveState(state);
}

await runChecks();

console.log("One-shot check completed.");
