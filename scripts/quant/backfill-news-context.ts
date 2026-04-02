import { createClient } from "@supabase/supabase-js";
import { booleanArg, csvStringArg, numberArg, parseArgs, stringArg, writeJson } from "./shared";

const DEFAULT_FEED_URLS = [
  "https://news.google.com/rss/search?q=bitcoin+OR+btc&hl=en-US&gl=US&ceid=US:en",
];

const POSITIVE_KEYWORDS = [
  "approval",
  "adoption",
  "accumulation",
  "buying",
  "bullish",
  "breakout",
  "demand",
  "etf inflow",
  "institutional",
  "surge",
  "treasury",
];

const NEGATIVE_KEYWORDS = [
  "ban",
  "bearish",
  "crackdown",
  "exploit",
  "hack",
  "liquidation",
  "lawsuit",
  "outflow",
  "selloff",
  "shutdown",
];

const IMPACT_KEYWORDS = [
  "cpi",
  "etf",
  "federal reserve",
  "fed",
  "inflation",
  "interest rate",
  "liquidation",
  "regulation",
  "sec",
  "tariff",
  "treasury",
];

const BTC_RELEVANCE_KEYWORDS = [
  "bitcoin",
  "btc",
  "crypto",
  "digital asset",
  "etf",
  "halving",
  "hashrate",
  "mining",
];

interface NewsArticle {
  title: string;
  link: string;
  publishedAt: string;
  source: string;
}

interface NewsContextSnapshot {
  timestamp: number;
  source: string;
  newsEventCount: number;
  newsSentiment: number;
  newsImpact: number;
  newsPositiveCount: number;
  newsNegativeCount: number;
  newsBtcRelevance: number;
  newsShockScore: number;
  title: string;
  link: string;
}

function round(value: number, precision = 6) {
  return Number(value.toFixed(precision));
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function decodeXml(value: string) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function extractTag(block: string, tag: string) {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? decodeXml(match[1].trim()) : null;
}

function countKeywordHits(text: string, keywords: string[]) {
  const haystack = text.toLowerCase();
  return keywords.reduce((count, keyword) => count + (haystack.includes(keyword) ? 1 : 0), 0);
}

function parseTime(value: string | null) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseFeed(xml: string, feedUrl: string): NewsArticle[] {
  const source = new URL(feedUrl).hostname.replace(/^www\./, "");
  const itemMatches = [...xml.matchAll(/<item\b[\s\S]*?>([\s\S]*?)<\/item>/gi)];
  const entryMatches = [...xml.matchAll(/<entry\b[\s\S]*?>([\s\S]*?)<\/entry>/gi)];
  const blocks = [...itemMatches.map((match) => match[1]), ...entryMatches.map((match) => match[1])];

  return blocks
    .map((block) => {
      const title = extractTag(block, "title");
      const linkTag = extractTag(block, "link");
      const atomHref = block.match(/<link[^>]+href="([^"]+)"/i)?.[1] ?? null;
      const publishedAt = extractTag(block, "pubDate") ?? extractTag(block, "published") ?? extractTag(block, "updated");
      if (!title || !(linkTag ?? atomHref) || !publishedAt) {
        return null;
      }
      return {
        title,
        link: decodeXml(linkTag ?? atomHref ?? ""),
        publishedAt,
        source,
      } satisfies NewsArticle;
    })
    .filter((article): article is NewsArticle => article !== null);
}

function scoreArticle(article: NewsArticle): NewsContextSnapshot | null {
  const timestamp = parseTime(article.publishedAt);
  if (timestamp === null) {
    return null;
  }

  const text = `${article.title} ${article.link}`;
  const positiveCount = countKeywordHits(text, POSITIVE_KEYWORDS);
  const negativeCount = countKeywordHits(text, NEGATIVE_KEYWORDS);
  const impactCount = countKeywordHits(text, IMPACT_KEYWORDS);
  const relevanceCount = countKeywordHits(text, BTC_RELEVANCE_KEYWORDS);
  const sentimentDenominator = Math.max(positiveCount + negativeCount, 1);
  const sentiment = clamp((positiveCount - negativeCount) / sentimentDenominator, -1, 1);
  const btcRelevance = clamp((relevanceCount + (/\bbitcoin\b|\bbtc\b/i.test(text) ? 1 : 0)) / 3, 0, 1);
  const impact = clamp(0.2 + impactCount * 0.16 + Math.abs(sentiment) * 0.18 + btcRelevance * 0.22, 0, 1);
  const shock = clamp(impact * (0.35 + Math.abs(sentiment)) * Math.max(btcRelevance, 0.25), 0, 1);

  return {
    timestamp,
    source: article.source,
    newsEventCount: 1,
    newsSentiment: round(sentiment),
    newsImpact: round(impact),
    newsPositiveCount: positiveCount,
    newsNegativeCount: negativeCount,
    newsBtcRelevance: round(btcRelevance),
    newsShockScore: round(shock),
    title: article.title,
    link: article.link,
  };
}

function maybeCreateSupabaseAdmin() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    return null;
  }
  return createClient(supabaseUrl, serviceRoleKey);
}

async function persistSnapshots(symbol: string, snapshots: NewsContextSnapshot[]) {
  const supabase = maybeCreateSupabaseAdmin();
  if (!supabase || snapshots.length === 0) {
    return false;
  }

  const rows = snapshots.map((snapshot) => ({
    venue: "news",
    symbol,
    snapshot_type: "news_context",
    created_at: new Date(snapshot.timestamp).toISOString(),
    raw_payload: {
      context: {
        newsEventCount: snapshot.newsEventCount,
        newsSentiment: snapshot.newsSentiment,
        newsImpact: snapshot.newsImpact,
        newsPositiveCount: snapshot.newsPositiveCount,
        newsNegativeCount: snapshot.newsNegativeCount,
        newsBtcRelevance: snapshot.newsBtcRelevance,
        newsShockScore: snapshot.newsShockScore,
        source: snapshot.source,
      },
      article: {
        title: snapshot.title,
        link: snapshot.link,
      },
    },
  }));

  const { error } = await supabase.from("market_snapshots").insert(rows as unknown);
  if (error) {
    throw error;
  }
  return true;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const feedUrls = csvStringArg(args, "feed-url", DEFAULT_FEED_URLS);
  const output = stringArg(args, "output", "research/datasets/BTCUSDT-news-context.json")!;
  const symbol = stringArg(args, "symbol", "BTCUSDT")!;
  const persist = booleanArg(args, "persist", true);
  const startAt = stringArg(args, "start");
  const endAt = stringArg(args, "end");
  const limit = Math.max(1, numberArg(args, "limit", 250));
  const minTimestamp = startAt ? Date.parse(startAt) : Number.NEGATIVE_INFINITY;
  const maxTimestamp = endAt ? Date.parse(endAt) : Number.POSITIVE_INFINITY;

  const xmlFeeds = await Promise.all(feedUrls.map(async (feedUrl) => ({
    feedUrl,
    xml: await fetch(feedUrl).then(async (response) => {
      if (!response.ok) {
        throw new Error(`News feed failed ${response.status} for ${feedUrl}`);
      }
      return response.text();
    }),
  })));

  const seen = new Set<string>();
  const articles = xmlFeeds
    .flatMap(({ feedUrl, xml }) => parseFeed(xml, feedUrl))
    .filter((article) => {
      const key = `${article.publishedAt}|${article.title.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((article) => scoreArticle(article))
    .filter((article): article is NewsContextSnapshot => article !== null)
    .filter((article) => article.timestamp >= minTimestamp && article.timestamp <= maxTimestamp)
    .sort((left, right) => left.timestamp - right.timestamp)
    .slice(-limit);

  if (persist) {
    await persistSnapshots(symbol, articles).catch((error) => {
      console.error("Supabase persist failed:", error instanceof Error ? error.message : error);
    });
  }

  await writeJson(output, {
    createdAt: new Date().toISOString(),
    provider: "rss-news",
    symbol,
    feedUrls,
    count: articles.length,
    snapshots: articles.map((article) => ({
      timestamp: article.timestamp,
      source: article.source,
      newsEventCount: article.newsEventCount,
      newsSentiment: article.newsSentiment,
      newsImpact: article.newsImpact,
      newsPositiveCount: article.newsPositiveCount,
      newsNegativeCount: article.newsNegativeCount,
      newsBtcRelevance: article.newsBtcRelevance,
      newsShockScore: article.newsShockScore,
      title: article.title,
      link: article.link,
    })),
  });

  console.log(JSON.stringify({
    output,
    symbol,
    persisted: persist,
    feedUrls,
    count: articles.length,
    window: {
      startAt: startAt ?? null,
      endAt: endAt ?? null,
    },
  }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
