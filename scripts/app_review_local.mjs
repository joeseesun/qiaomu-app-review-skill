#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_COUNTRY = 'us';
const DEFAULT_MAX_REVIEWS = 120;

function printUsage() {
  console.log(`Qiaomu App Review local runner

Fetch App Store review evidence without relying on appreview.qiaomu.ai.

Usage:
  node scripts/app_review_local.mjs --query "ChatGPT" --country us --max-reviews 120 --out ./app-review-output
  node scripts/app_review_local.mjs --query "https://apps.apple.com/us/app/chatgpt/id6448311069" --out ./out
  node scripts/app_review_local.mjs --render-md ./out/insight.md --data ./out/reviews.json --html ./out/insight.html --title "ChatGPT 评价洞察"

Options:
  --query, -q        App Store URL, App ID, or app name
  --country, -c      App Store country code, default: us
  --max-reviews, -n  Maximum reviews to fetch, default: 120
  --out, -o          Output directory, default: ./app-review-output/<country>-<appId>-<slug>
  --render-md        Render an existing Markdown report into local HTML
  --data             Optional reviews.json path for chart dashboards in rendered HTML
  --html             HTML output path for --render-md
  --title            HTML/report title override
  --help, -h         Show this help
`);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') args.help = true;
    else if (token === '--query' || token === '-q') args.query = argv[++index];
    else if (token === '--country' || token === '-c') args.country = argv[++index];
    else if (token === '--max-reviews' || token === '-n') args.maxReviews = Number(argv[++index]);
    else if (token === '--out' || token === '-o') args.out = argv[++index];
    else if (token === '--render-md') args.renderMd = argv[++index];
    else if (token === '--data') args.data = argv[++index];
    else if (token === '--html') args.html = argv[++index];
    else if (token === '--title') args.title = argv[++index];
    else throw new Error(`Unknown option: ${token}`);
  }
  return args;
}

function label(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return label(value[0]);
  if (typeof value === 'object') return label(value.label ?? value.attributes?.label ?? value.name);
  return '';
}

function extractAppId(query) {
  const trimmed = String(query || '').trim();
  if (/^\d{5,}$/.test(trimmed)) return trimmed;
  const match = trimmed.match(/(?:\/id|[?&]id=)(\d{5,})/i);
  return match?.[1] || '';
}

function extractCountry(query) {
  const match = String(query || '').match(/apps\.apple\.com\/([a-z]{2})\//i);
  return match?.[1]?.toLowerCase() || '';
}

function slugify(text) {
  return String(text || 'app')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'app';
}

function escapeHtml(text) {
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatDate(value) {
  if (!value) return '未知';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().slice(0, 10);
}

function percent(value, digits = 0) {
  if (!Number.isFinite(value)) return '0%';
  return `${(value * 100).toFixed(digits)}%`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

const TERM_STOPWORDS = new Set([
  'about', 'after', 'again', 'also', 'always', 'because', 'being', 'been', 'best', 'cant', 'could',
  'does', 'doing', 'dont', 'even', 'every', 'from', 'good', 'have', 'help', 'helpful', 'just',
  'like', 'more', 'much', 'need', 'only', 'really', 'some', 'still', 'that', 'their', 'them',
  'then', 'there', 'they', 'this', 'time', 'very', 'want', 'when', 'with', 'work', 'would',
  '一个', '不是', '不能', '为什么', '什么', '但是', '可以', '没有', '这个', '真的', '就是', '还是',
  '非常', '感觉', '现在', '一直', '已经', '使用', '用户', '软件', '功能', '问题', '时候',
]);

function extractTerms(reviews, limit = 12) {
  const counts = new Map();
  const add = (term) => {
    const normalized = term.toLowerCase().replace(/^'+|'+$/g, '');
    if (normalized.length < 2 || TERM_STOPWORDS.has(normalized)) return;
    counts.set(normalized, (counts.get(normalized) || 0) + 1);
  };

  for (const review of reviews) {
    const text = `${review.title || ''} ${review.content || ''}`;
    const latinWords = text.match(/[A-Za-z][A-Za-z']{3,}/g) || [];
    for (const word of latinWords) add(word);

    const cjkRuns = text.match(/[\p{Script=Han}]{2,}/gu) || [];
    for (const run of cjkRuns) {
      const chars = Array.from(run);
      if (chars.length <= 4) {
        add(run);
      } else {
        for (let index = 0; index < chars.length - 1; index += 1) {
          add(chars.slice(index, index + 2).join(''));
        }
      }
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([term, count]) => ({ term, count }));
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: 'application/json,text/plain,*/*',
      'user-agent': 'qiaomu-app-review-skill/1.0',
    },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status} for ${url}${body ? `\n${body.slice(0, 300)}` : ''}`);
  }
  return response.json();
}

async function lookupApp(appId, country) {
  const url = `https://itunes.apple.com/lookup?id=${encodeURIComponent(appId)}&country=${encodeURIComponent(country)}`;
  const data = await fetchJson(url);
  const app = data.results?.[0];
  if (!app) throw new Error(`No App Store app found for id ${appId} in ${country}`);
  return normalizeApp(app, country);
}

async function searchApp(term, country) {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&country=${encodeURIComponent(country)}&entity=software&limit=5`;
  const data = await fetchJson(url);
  const results = (data.results || []).map((item) => normalizeApp(item, country));
  if (!results.length) throw new Error(`No App Store app found for "${term}" in ${country}`);
  return { app: results[0], candidates: results };
}

function normalizeApp(item, country) {
  return {
    id: String(item.trackId || item.trackIdStr || item.bundleId || ''),
    name: item.trackName || item.collectionName || item.name || '',
    artistName: item.artistName || '',
    country,
    primaryGenreName: item.primaryGenreName || '',
    version: item.version || '',
    artworkUrl: item.artworkUrl512 || item.artworkUrl100 || item.artworkUrl60 || '',
    appStoreUrl: item.trackViewUrl || '',
    averageUserRating: item.averageUserRating || 0,
    userRatingCount: item.userRatingCount || 0,
  };
}

async function resolveApp(query, country) {
  const urlCountry = extractCountry(query);
  const resolvedCountry = (urlCountry || country || DEFAULT_COUNTRY).toLowerCase();
  const appId = extractAppId(query);
  if (appId) {
    const app = await lookupApp(appId, resolvedCountry);
    return { app, candidates: [app], country: resolvedCountry };
  }
  const result = await searchApp(query, resolvedCountry);
  return { ...result, country: resolvedCountry };
}

function normalizeReview(entry, country, appId) {
  const id = label(entry.id) || `${appId}-${label(entry.updated)}-${label(entry.title)}`;
  const title = label(entry.title);
  const content = label(entry.content);
  const rating = Number(label(entry['im:rating']) || 0);
  if (!content || !rating) return null;
  return {
    id,
    title,
    content,
    rating,
    version: label(entry['im:version']) || 'unknown',
    author: label(entry.author?.name) || 'anonymous',
    updated: label(entry.updated),
    country,
  };
}

async function fetchReviews(appId, country, maxReviews) {
  const reviews = [];
  const seen = new Set();
  const maxPages = Math.max(1, Math.ceil(maxReviews / 50) + 1);

  for (let page = 1; page <= maxPages && reviews.length < maxReviews; page += 1) {
    const url = `https://itunes.apple.com/${country}/rss/customerreviews/id=${encodeURIComponent(appId)}/page=${page}/json`;
    const data = await fetchJson(url);
    const entries = data.feed?.entry ? (Array.isArray(data.feed.entry) ? data.feed.entry : [data.feed.entry]) : [];
    let addedOnPage = 0;
    for (const entry of entries) {
      const review = normalizeReview(entry, country, appId);
      if (!review || seen.has(review.id)) continue;
      seen.add(review.id);
      reviews.push(review);
      addedOnPage += 1;
      if (reviews.length >= maxReviews) break;
    }
    if (addedOnPage === 0) break;
  }

  return reviews;
}

function buildStats(reviews) {
  const total = reviews.length;
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const versions = new Map();
  const daily = new Map();
  const lengthByRating = new Map();
  const dates = [];

  for (const review of reviews) {
    distribution[review.rating] = (distribution[review.rating] || 0) + 1;
    const version = review.version || 'unknown';
    const versionStats = versions.get(version) || {
      version,
      count: 0,
      totalRating: 0,
      negative: 0,
      positive: 0,
      latestReviewDate: '',
    };
    versionStats.count += 1;
    versionStats.totalRating += review.rating;
    if (review.rating <= 2) versionStats.negative += 1;
    if (review.rating >= 4) versionStats.positive += 1;
    if (!versionStats.latestReviewDate || review.updated > versionStats.latestReviewDate) {
      versionStats.latestReviewDate = review.updated || versionStats.latestReviewDate;
    }
    versions.set(version, versionStats);
    if (review.updated) {
      dates.push(review.updated);
      const day = formatDate(review.updated);
      const dayStats = daily.get(day) || { date: day, count: 0, totalRating: 0, negative: 0, positive: 0 };
      dayStats.count += 1;
      dayStats.totalRating += review.rating;
      if (review.rating <= 2) dayStats.negative += 1;
      if (review.rating >= 4) dayStats.positive += 1;
      daily.set(day, dayStats);
    }

    const lengthStats = lengthByRating.get(review.rating) || { rating: review.rating, count: 0, totalLength: 0 };
    lengthStats.count += 1;
    lengthStats.totalLength += Array.from(review.content || '').length;
    lengthByRating.set(review.rating, lengthStats);
  }

  const totalRating = reviews.reduce((sum, review) => sum + review.rating, 0);
  const negative = reviews.filter((review) => review.rating <= 2).length;
  const positive = reviews.filter((review) => review.rating >= 4).length;
  const neutral = reviews.filter((review) => review.rating === 3).length;
  const negativeReviews = reviews.filter((review) => review.rating <= 2);
  const positiveReviews = reviews.filter((review) => review.rating >= 4);

  return {
    totalReviews: total,
    averageRating: total ? Number((totalRating / total).toFixed(2)) : 0,
    ratingDistribution: distribution,
    sentimentCounts: { negative, neutral, positive },
    negativeShare: total ? Number((negative / total).toFixed(3)) : 0,
    positiveShare: total ? Number((positive / total).toFixed(3)) : 0,
    neutralShare: total ? Number((neutral / total).toFixed(3)) : 0,
    oldestReviewDate: dates.length ? dates.slice().sort()[0] : '',
    latestReviewDate: dates.length ? dates.slice().sort().at(-1) : '',
    versionDistribution: [...versions.values()]
      .map((item) => ({
        ...item,
        averageRating: Number((item.totalRating / item.count).toFixed(2)),
        negativeShare: Number((item.negative / item.count).toFixed(3)),
        positiveShare: Number((item.positive / item.count).toFixed(3)),
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20),
    dailySeries: [...daily.values()]
      .map((item) => ({
        ...item,
        averageRating: Number((item.totalRating / item.count).toFixed(2)),
        negativeShare: Number((item.negative / item.count).toFixed(3)),
        positiveShare: Number((item.positive / item.count).toFixed(3)),
      }))
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-21),
    reviewLengthByRating: [5, 4, 3, 2, 1].map((rating) => {
      const item = lengthByRating.get(rating);
      return {
        rating,
        count: item?.count || 0,
        averageLength: item?.count ? Math.round(item.totalLength / item.count) : 0,
      };
    }),
    topTerms: {
      negative: extractTerms(negativeReviews),
      positive: extractTerms(positiveReviews),
    },
  };
}

function pickEvidence(reviews) {
  const negative = reviews.filter((review) => review.rating <= 2).slice(0, 40);
  const positive = reviews.filter((review) => review.rating >= 4).slice(0, 25);
  const neutral = reviews.filter((review) => review.rating === 3).slice(0, 10);
  return { negative, positive, neutral };
}

function reviewLine(review) {
  const title = review.title ? `**${review.title}** ` : '';
  return `- ${title}${review.rating} 星 · ${review.version} · ${formatDate(review.updated)} · ${review.author}\n  ${review.content.replace(/\s+/g, ' ').slice(0, 700)}`;
}

function buildAgentPrompt(app, stats, jsonPath) {
  return `你是一名资深 App 产品研究员。请基于本地证据文件 \`${jsonPath}\` 里的 App Store 评论，输出一份证据优先的中文产品洞察报告。

目标 App：${app.name}
样本量：${stats.totalReviews} 条
样本均分：${stats.averageRating}

请严格输出这些部分：

1. 摘要：3-5 句，说明整体口碑、主要矛盾、最值得关注的产品信号。
2. 核心痛点：按主题归纳，每条包含标题、解释、代表性评论证据。
3. 产品机会：说明可以进入需求池、路线图或独立产品切口的机会。
4. 正向信号：用户为什么愿意给高分，哪些价值不能丢。
5. 用户分层：不同用户群体的诉求差异。
6. 版本风险：和版本更新、性能、付费策略、限制、退化有关的风险。
7. 行动建议：产品经理下一步该验证、修复或排期的动作。

要求：
- 不要编造评论证据。
- 每个判断尽量引用评论里的原话或短证据。
- 明确说明样本边界：国家区、样本量、抓取时间。
- 输出 Markdown，文件名建议为 \`insight.md\`。
- 写完后可运行：\`node scripts/app_review_local.mjs --render-md insight.md --data ${jsonPath} --html insight.html --title "${app.name} 评价洞察"\`。`;
}

function buildMarkdown({ app, stats, reviews, candidates, generatedAt, jsonFileName }) {
  const evidence = pickEvidence(reviews);
  const dist = [5, 4, 3, 2, 1]
    .map((rating) => `- ${rating} 星：${stats.ratingDistribution[rating] || 0}`)
    .join('\n');

  return `# ${app.name} App Store 评论证据包

> 这是本地抓取的评论证据包。当前 Agent 应基于这些证据生成产品洞察，而不是泛泛总结。

## App 信息

- App：${app.name}
- 开发者：${app.artistName || '未知'}
- 国家区：${app.country.toUpperCase()}
- 分类：${app.primaryGenreName || '未知'}
- 版本：${app.version || '未知'}
- App Store：${app.appStoreUrl || '未知'}
- 抓取时间：${generatedAt}

## 样本统计

- 评论样本：${stats.totalReviews}
- 样本均分：${stats.averageRating} / 5
- 好评占比：${Math.round(stats.positiveShare * 100)}%
- 差评占比：${Math.round(stats.negativeShare * 100)}%
- 时间范围：${formatDate(stats.oldestReviewDate)} - ${formatDate(stats.latestReviewDate)}

### 星级分布

${dist}

### 版本样本

${stats.versionDistribution.map((item) => `- ${item.version}：${item.count} 条，均分 ${item.averageRating}`).join('\n') || '- 暂无版本样本'}

## 给当前 Agent 的分析提示词

${buildAgentPrompt(app, stats, jsonFileName)}

## 差评证据

${evidence.negative.map(reviewLine).join('\n\n') || '暂无差评样本。'}

## 好评证据

${evidence.positive.map(reviewLine).join('\n\n') || '暂无好评样本。'}

## 中性证据

${evidence.neutral.map(reviewLine).join('\n\n') || '暂无中性样本。'}

${candidates.length > 1 ? `## 搜索候选\n\n${candidates.map((candidate, index) => `${index + 1}. ${candidate.name} · ${candidate.artistName} · ${candidate.id}`).join('\n')}` : ''}
`;
}

function buildMetricCard(labelText, value, detail = '') {
  return `<div class="metric-card">
    <div class="metric-label">${escapeHtml(labelText)}</div>
    <div class="metric-value">${escapeHtml(value)}</div>
    ${detail ? `<div class="metric-detail">${escapeHtml(detail)}</div>` : ''}
  </div>`;
}

function buildRatingChart(stats) {
  const max = Math.max(1, ...Object.values(stats.ratingDistribution || {}));
  const rows = [5, 4, 3, 2, 1].map((rating) => {
    const count = stats.ratingDistribution?.[rating] || 0;
    const width = Math.max(3, Math.round((count / max) * 100));
    const tone = rating >= 4 ? 'good' : rating <= 2 ? 'risk' : 'neutral';
    return `<div class="rating-row">
      <span>${rating} 星</span>
      <div class="bar-track"><div class="bar-fill ${tone}" style="width:${width}%"></div></div>
      <strong>${count}</strong>
    </div>`;
  }).join('');
  return `<div class="chart-panel">
    <div class="chart-head">
      <div>
        <div class="chart-kicker">RATING</div>
        <h2>星级分布</h2>
      </div>
      <span>${stats.averageRating} / 5</span>
    </div>
    <div class="rating-chart">${rows}</div>
  </div>`;
}

function buildSentimentChart(stats) {
  const positive = stats.positiveShare || 0;
  const neutral = stats.neutralShare || 0;
  const positiveDeg = Math.round(positive * 360);
  const neutralDeg = Math.round((positive + neutral) * 360);
  const gradient = `conic-gradient(var(--good) 0deg ${positiveDeg}deg, var(--neutral) ${positiveDeg}deg ${neutralDeg}deg, var(--risk) ${neutralDeg}deg 360deg)`;
  return `<div class="chart-panel">
    <div class="chart-head">
      <div>
        <div class="chart-kicker">SENTIMENT</div>
        <h2>口碑结构</h2>
      </div>
      <span>${percent(stats.negativeShare)} 差评</span>
    </div>
    <div class="donut-wrap">
      <div class="donut" style="background:${gradient}">
        <div class="donut-hole">
          <strong>${percent(positive)}</strong>
          <span>好评</span>
        </div>
      </div>
      <div class="legend-list">
        <div><i class="good"></i>好评 ${stats.sentimentCounts?.positive || 0} 条 · ${percent(positive)}</div>
        <div><i class="neutral"></i>中性 ${stats.sentimentCounts?.neutral || 0} 条 · ${percent(neutral)}</div>
        <div><i class="risk"></i>差评 ${stats.sentimentCounts?.negative || 0} 条 · ${percent(stats.negativeShare || 0)}</div>
      </div>
    </div>
  </div>`;
}

function buildVersionRiskChart(stats) {
  const versions = (stats.versionDistribution || []).slice(0, 8);
  if (!versions.length) {
    return `<div class="chart-panel"><div class="chart-head"><div><div class="chart-kicker">VERSION</div><h2>版本风险</h2></div></div><p class="empty">暂无版本样本。</p></div>`;
  }
  const maxCount = Math.max(1, ...versions.map((item) => item.count));
  const rows = versions.map((item) => {
    const countWidth = Math.max(5, Math.round((item.count / maxCount) * 100));
    const riskWidth = Math.max(3, Math.round((item.negativeShare || 0) * 100));
    const riskClass = item.negativeShare >= 0.5 ? 'risk' : item.negativeShare >= 0.25 ? 'warn' : 'good';
    return `<div class="version-row">
      <div class="version-main">
        <strong>${escapeHtml(item.version)}</strong>
        <span>${item.count} 条 · 均分 ${item.averageRating}</span>
      </div>
      <div class="version-bars">
        <div class="bar-track count"><div class="bar-fill neutral" style="width:${countWidth}%"></div></div>
        <div class="bar-track riskline"><div class="bar-fill ${riskClass}" style="width:${riskWidth}%"></div></div>
      </div>
      <em>${percent(item.negativeShare || 0)} 差评</em>
    </div>`;
  }).join('');
  return `<div class="chart-panel wide">
    <div class="chart-head">
      <div>
        <div class="chart-kicker">VERSION</div>
        <h2>版本风险</h2>
      </div>
      <span>样本最多的 ${versions.length} 个版本</span>
    </div>
    <div class="version-chart">${rows}</div>
  </div>`;
}

function buildTimelineChart(stats) {
  const series = stats.dailySeries || [];
  if (!series.length) {
    return `<div class="chart-panel wide"><div class="chart-head"><div><div class="chart-kicker">TIME</div><h2>评论走势</h2></div></div><p class="empty">暂无可用日期样本。</p></div>`;
  }

  const width = 720;
  const height = 280;
  const left = 52;
  const right = 28;
  const top = 34;
  const bottom = 54;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const maxCount = Math.max(1, ...series.map((item) => item.count));
  const step = series.length > 1 ? plotWidth / (series.length - 1) : 0;
  const barWidth = clamp(Math.floor(plotWidth / Math.max(series.length, 1) * 0.5), 8, 28);
  const points = series.map((item, index) => {
    const x = series.length > 1 ? left + index * step : left + plotWidth / 2;
    const y = top + (5 - item.averageRating) / 4 * plotHeight;
    return { ...item, x, y };
  });
  const pathData = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' ');
  const bars = points.map((point) => {
    const barHeight = Math.max(4, (point.count / maxCount) * (plotHeight * 0.75));
    const y = top + plotHeight - barHeight;
    const negativeHeight = barHeight * (point.negativeShare || 0);
    return `<g>
      <rect x="${(point.x - barWidth / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth}" height="${barHeight.toFixed(1)}" rx="3" fill="#d9d7cc"/>
      <rect x="${(point.x - barWidth / 2).toFixed(1)}" y="${(y + barHeight - negativeHeight).toFixed(1)}" width="${barWidth}" height="${negativeHeight.toFixed(1)}" rx="3" fill="#a33b2f"/>
    </g>`;
  }).join('');
  const pointDots = points.map((point) => `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="4.2" fill="#1B365D" stroke="#f5f4ed" stroke-width="1.5"/>`).join('');
  const firstLabel = points[0]?.date || '';
  const lastLabel = points.at(-1)?.date || '';
  return `<div class="chart-panel wide">
    <div class="chart-head">
      <div>
        <div class="chart-kicker">TIME</div>
        <h2>评论走势</h2>
      </div>
      <span>${formatDate(stats.oldestReviewDate)} - ${formatDate(stats.latestReviewDate)}</span>
    </div>
    <svg class="timeline-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="评论量与均分走势">
      <rect width="100%" height="100%" fill="transparent"/>
      <line x1="${left}" y1="${top + plotHeight}" x2="${width - right}" y2="${top + plotHeight}" stroke="#c9c6ba" stroke-width="1"/>
      <line x1="${left}" y1="${top}" x2="${left}" y2="${top + plotHeight}" stroke="#c9c6ba" stroke-width="1"/>
      <text x="${left - 12}" y="${top + 4}" text-anchor="end" font-size="11" fill="#6b6a64">5.0</text>
      <text x="${left - 12}" y="${top + plotHeight + 4}" text-anchor="end" font-size="11" fill="#6b6a64">1.0</text>
      <line x1="${left}" y1="${top + plotHeight / 2}" x2="${width - right}" y2="${top + plotHeight / 2}" stroke="#e7e3d8" stroke-width="1" stroke-dasharray="4 6"/>
      ${bars}
      <path d="${pathData}" fill="none" stroke="#1B365D" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
      ${pointDots}
      <text x="${left}" y="${height - 18}" font-size="11" fill="#504e49">${escapeHtml(firstLabel)}</text>
      <text x="${width - right}" y="${height - 18}" font-size="11" text-anchor="end" fill="#504e49">${escapeHtml(lastLabel)}</text>
      <text x="${width - right}" y="${top + 16}" font-size="10" text-anchor="end" fill="#1B365D">蓝线：日均星级 · 红柱：差评占比</text>
    </svg>
  </div>`;
}

function buildTermChart(title, terms, tone) {
  const top = (terms || []).slice(0, 8);
  if (!top.length) return `<div class="term-block"><h3>${escapeHtml(title)}</h3><p class="empty">暂无高频词。</p></div>`;
  const max = Math.max(1, ...top.map((item) => item.count));
  const rows = top.map((item) => {
    const width = Math.max(8, Math.round((item.count / max) * 100));
    return `<div class="term-row">
      <span>${escapeHtml(item.term)}</span>
      <div class="bar-track"><div class="bar-fill ${tone}" style="width:${width}%"></div></div>
      <strong>${item.count}</strong>
    </div>`;
  }).join('');
  return `<div class="term-block"><h3>${escapeHtml(title)}</h3>${rows}</div>`;
}

function buildTermsChart(stats) {
  return `<div class="chart-panel wide">
    <div class="chart-head">
      <div>
        <div class="chart-kicker">TERMS</div>
        <h2>评论高频词</h2>
      </div>
      <span>按正负样本拆开看</span>
    </div>
    <div class="terms-grid">
      ${buildTermChart('差评里反复出现', stats.topTerms?.negative || [], 'risk')}
      ${buildTermChart('好评里反复出现', stats.topTerms?.positive || [], 'good')}
    </div>
  </div>`;
}

function buildReviewDepthChart(stats) {
  const rows = stats.reviewLengthByRating || [];
  const max = Math.max(1, ...rows.map((item) => item.averageLength));
  const items = rows.map((item) => {
    const width = Math.max(4, Math.round((item.averageLength / max) * 100));
    const tone = item.rating >= 4 ? 'good' : item.rating <= 2 ? 'risk' : 'neutral';
    return `<div class="term-row">
      <span>${item.rating} 星</span>
      <div class="bar-track"><div class="bar-fill ${tone}" style="width:${width}%"></div></div>
      <strong>${item.averageLength || 0} 字</strong>
    </div>`;
  }).join('');
  return `<div class="chart-panel">
    <div class="chart-head">
      <div>
        <div class="chart-kicker">DEPTH</div>
        <h2>表达强度</h2>
      </div>
      <span>评论平均长度</span>
    </div>
    ${items}
  </div>`;
}

function buildDashboardHtml(app, stats) {
  if (!app || !stats) return '';
  const period = `${formatDate(stats.oldestReviewDate)} - ${formatDate(stats.latestReviewDate)}`;
  return `<section class="dashboard" aria-label="App Store 评论图表仪表盘">
    <div class="dashboard-title">
      <div>
        <div class="chart-kicker">LOCAL DASHBOARD</div>
        <h2>${escapeHtml(app.name)} 评论仪表盘</h2>
      </div>
      <p>${escapeHtml(app.country?.toUpperCase() || '')} · ${escapeHtml(app.primaryGenreName || '未知分类')} · ${escapeHtml(period)}</p>
    </div>
    <div class="metrics">
      ${buildMetricCard('评论样本', `${stats.totalReviews || 0} 条`, '本地抓取')}
      ${buildMetricCard('样本均分', `${stats.averageRating || 0} / 5`, '不是总评分')}
      ${buildMetricCard('差评占比', percent(stats.negativeShare || 0), `${stats.sentimentCounts?.negative || 0} 条 1-2 星`)}
      ${buildMetricCard('好评占比', percent(stats.positiveShare || 0), `${stats.sentimentCounts?.positive || 0} 条 4-5 星`)}
      ${buildMetricCard('版本样本', `${stats.versionDistribution?.length || 0} 个`, '可看更新风险')}
    </div>
    <div class="chart-grid">
      ${buildRatingChart(stats)}
      ${buildSentimentChart(stats)}
      ${buildVersionRiskChart(stats)}
      ${buildTimelineChart(stats)}
      ${buildTermsChart(stats)}
      ${buildReviewDepthChart(stats)}
    </div>
  </section>`;
}

function markdownToHtml(markdown) {
  const lines = markdown.split(/\r?\n/);
  const html = [];
  let inList = false;
  let inCode = false;
  let code = [];

  function closeList() {
    if (inList) {
      html.push('</ul>');
      inList = false;
    }
  }

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (inCode) {
        html.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
        code = [];
        inCode = false;
      } else {
        closeList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }
    if (/^###\s+/.test(line)) {
      closeList();
      html.push(`<h3>${escapeHtml(line.replace(/^###\s+/, ''))}</h3>`);
    } else if (/^##\s+/.test(line)) {
      closeList();
      html.push(`<h2>${escapeHtml(line.replace(/^##\s+/, ''))}</h2>`);
    } else if (/^#\s+/.test(line)) {
      closeList();
      html.push(`<h1>${escapeHtml(line.replace(/^#\s+/, ''))}</h1>`);
    } else if (/^-\s+/.test(line)) {
      if (!inList) {
        html.push('<ul>');
        inList = true;
      }
      html.push(`<li>${inlineMarkdown(line.replace(/^-\s+/, ''))}</li>`);
    } else if (/^>\s+/.test(line)) {
      closeList();
      html.push(`<blockquote>${inlineMarkdown(line.replace(/^>\s+/, ''))}</blockquote>`);
    } else if (line.trim()) {
      closeList();
      html.push(`<p>${inlineMarkdown(line)}</p>`);
    } else {
      closeList();
    }
  }
  closeList();
  return html.join('\n');
}

function inlineMarkdown(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function wrapHtml({ title, body, app, stats }) {
  const subtitle = app && stats
    ? `${escapeHtml(app.name)} · ${stats.totalReviews} 条评论 · ${stats.averageRating} / 5`
    : '';
  const dashboard = app && stats ? buildDashboardHtml(app, stats) : '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      --paper:#f5f4ed;
      --ivory:#fffdfa;
      --ink:#141413;
      --muted:#6b6a64;
      --olive:#504e49;
      --line:#e6e1d4;
      --brand:#1B365D;
      --brand-soft:#EEF2F7;
      --good:#187052;
      --good-soft:#e8f4ee;
      --risk:#a33b2f;
      --risk-soft:#f7e9e6;
      --warn:#b7791f;
      --neutral:#b8b7b0;
      --shadow:0 18px 50px rgb(63 57 45 / .08);
      --serif: Charter, Georgia, "Songti SC", "Noto Serif CJK SC", serif;
      --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
      --mono: "SF Mono", Consolas, "JetBrains Mono", monospace;
    }
    * { box-sizing: border-box; }
    body {
      margin:0;
      background:
        radial-gradient(circle at 20% 0%, rgb(255 255 255 / .7), transparent 32rem),
        linear-gradient(180deg, #f9f7ef 0%, var(--paper) 46%, #efede4 100%);
      color:var(--ink);
      font-family:var(--serif);
    }
    main { max-width: 1180px; margin: 0 auto; padding: 52px 20px 76px; }
    header { border-bottom:1px solid var(--line); margin-bottom:28px; padding-bottom:22px; }
    .brand { color:var(--brand); font-family:var(--mono); font-size:12px; font-weight:700; letter-spacing:.16em; text-transform:uppercase; }
    h1 { font-size:42px; line-height:1.12; margin:10px 0 10px; font-weight:500; letter-spacing:0; }
    h2 { margin:0; font-size:23px; font-weight:500; line-height:1.2; }
    h3 { margin:22px 0 10px; font-size:18px; font-weight:500; }
    p, li { line-height:1.78; }
    blockquote { margin:18px 0; border-left:3px solid var(--brand); background:var(--brand-soft); padding:12px 16px; color:var(--brand); }
    code { font-family:var(--mono); background:#f7f4ea; border:1px solid var(--line); border-radius:5px; padding:1px 5px; }
    pre { overflow:auto; background:#191916; color:#fafafa; border-radius:8px; padding:16px; }
    ul { padding-left:1.3rem; }
    a { color:var(--brand); }
    .subtitle { color:var(--muted); font-family:var(--sans); }
    .dashboard { margin: 0 0 24px; }
    .dashboard-title {
      display:flex;
      justify-content:space-between;
      gap:20px;
      align-items:flex-end;
      margin-bottom:18px;
    }
    .dashboard-title p { margin:0; color:var(--muted); font-family:var(--sans); font-size:14px; }
    .chart-kicker {
      font-family:var(--mono);
      font-size:11px;
      letter-spacing:.18em;
      color:var(--brand);
      font-weight:700;
      margin-bottom:7px;
    }
    .metrics {
      display:grid;
      grid-template-columns:repeat(5, minmax(0, 1fr));
      gap:12px;
      margin-bottom:14px;
    }
    .metric-card, .chart-panel, .card {
      background:rgb(255 253 250 / .86);
      border:1px solid var(--line);
      box-shadow:var(--shadow);
    }
    .metric-card { border-radius:8px; padding:16px 16px 14px; min-height:104px; }
    .metric-label, .metric-detail { font-family:var(--sans); color:var(--muted); font-size:13px; }
    .metric-value { margin:8px 0 4px; color:var(--brand); font-size:30px; line-height:1; font-weight:500; font-variant-numeric:tabular-nums; }
    .chart-grid { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:14px; }
    .chart-panel { border-radius:8px; padding:18px; overflow:hidden; }
    .chart-panel.wide { grid-column:span 2; }
    .chart-head { display:flex; justify-content:space-between; gap:16px; align-items:flex-start; margin-bottom:16px; }
    .chart-head span { font-family:var(--sans); color:var(--muted); font-size:13px; white-space:nowrap; }
    .rating-chart, .version-chart { display:grid; gap:10px; }
    .rating-row, .version-row, .term-row {
      display:grid;
      grid-template-columns:52px minmax(0, 1fr) 42px;
      gap:12px;
      align-items:center;
      font-family:var(--sans);
      font-size:13px;
      color:var(--olive);
    }
    .version-row { grid-template-columns:minmax(130px, .7fr) minmax(0, 1fr) 74px; padding:10px 0; border-bottom:1px solid #ece8dc; }
    .version-row:last-child { border-bottom:0; }
    .version-main strong { display:block; color:var(--ink); font-family:var(--serif); font-size:16px; font-weight:500; overflow-wrap:anywhere; }
    .version-main span { color:var(--muted); font-size:12px; }
    .version-bars { display:grid; gap:6px; }
    .version-row em { color:var(--olive); font-style:normal; font-size:12px; text-align:right; }
    .bar-track { height:10px; background:#eeebe2; border-radius:99px; overflow:hidden; }
    .bar-track.count { height:8px; }
    .bar-track.riskline { height:6px; }
    .bar-fill { height:100%; border-radius:99px; }
    .bar-fill.good { background:var(--good); }
    .bar-fill.risk { background:var(--risk); }
    .bar-fill.warn { background:var(--warn); }
    .bar-fill.neutral { background:var(--brand); opacity:.62; }
    .donut-wrap { display:flex; align-items:center; gap:24px; min-height:190px; }
    .donut { width:164px; height:164px; border-radius:50%; display:grid; place-items:center; box-shadow:inset 0 0 0 1px rgb(20 20 19 / .05); flex:0 0 auto; }
    .donut-hole { width:94px; height:94px; border-radius:50%; background:var(--ivory); display:grid; place-items:center; align-content:center; border:1px solid var(--line); }
    .donut-hole strong { color:var(--brand); font-size:25px; font-weight:500; line-height:1; }
    .donut-hole span { color:var(--muted); font-family:var(--sans); font-size:12px; margin-top:4px; }
    .legend-list { display:grid; gap:11px; font-family:var(--sans); color:var(--olive); font-size:13px; }
    .legend-list i { display:inline-block; width:10px; height:10px; border-radius:2px; margin-right:8px; }
    .legend-list .good { background:var(--good); }
    .legend-list .neutral { background:var(--neutral); }
    .legend-list .risk { background:var(--risk); }
    .timeline-svg { width:100%; min-height:260px; display:block; }
    .terms-grid { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:22px; }
    .term-block h3 { margin-top:0; }
    .term-row { grid-template-columns:90px minmax(0, 1fr) 34px; margin:9px 0; }
    .term-row span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .empty { color:var(--muted); font-family:var(--sans); }
    .card { border-radius:8px; padding:28px; margin-top:22px; }
    .card > h1:first-child { font-size:30px; }
    .card h2 { margin-top:34px; border-top:1px solid var(--line); padding-top:24px; }
    @media (max-width: 880px) {
      main { padding:32px 14px 56px; }
      h1 { font-size:34px; }
      .dashboard-title { display:block; }
      .metrics, .chart-grid, .terms-grid { grid-template-columns:1fr; }
      .chart-panel.wide { grid-column:auto; }
      .donut-wrap { align-items:flex-start; }
      .version-row { grid-template-columns:1fr; gap:8px; }
      .version-row em { text-align:left; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div class="brand">乔木 App 洞察 · Local Evidence</div>
      <h1>${escapeHtml(title)}</h1>
      ${subtitle ? `<div class="subtitle">${subtitle}</div>` : ''}
    </header>
    ${dashboard}
    <section class="card">
${body}
    </section>
  </main>
</body>
</html>`;
}

async function writeOutputs({ app, candidates, reviews, outDir }) {
  const generatedAt = new Date().toISOString();
  const stats = buildStats(reviews);
  const jsonFileName = 'reviews.json';
  const payload = { generatedAt, app, candidates, stats, reviews };
  const markdown = buildMarkdown({ app, stats, reviews, candidates, generatedAt, jsonFileName });
  const html = wrapHtml({
    title: `${app.name} 评论证据包`,
    body: markdownToHtml(markdown),
    app,
    stats,
  });
  const prompt = buildAgentPrompt(app, stats, path.join(outDir, jsonFileName));

  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, jsonFileName), JSON.stringify(payload, null, 2), 'utf8');
  await writeFile(path.join(outDir, 'evidence.md'), markdown, 'utf8');
  await writeFile(path.join(outDir, 'evidence.html'), html, 'utf8');
  await writeFile(path.join(outDir, 'agent-prompt.md'), prompt, 'utf8');

  return {
    outDir,
    json: path.join(outDir, jsonFileName),
    markdown: path.join(outDir, 'evidence.md'),
    html: path.join(outDir, 'evidence.html'),
    prompt: path.join(outDir, 'agent-prompt.md'),
    stats,
  };
}

async function renderMarkdownFile(args) {
  if (!args.renderMd) throw new Error('--render-md is required');
  const input = path.resolve(args.renderMd);
  const output = path.resolve(args.html || input.replace(/\.md$/i, '.html'));
  const markdown = await readFile(input, 'utf8');
  const title = args.title || path.basename(input, path.extname(input));
  let app;
  let stats;
  if (args.data) {
    const dataPath = path.resolve(args.data);
    const data = JSON.parse(await readFile(dataPath, 'utf8'));
    app = data.app;
    stats = data.stats || (Array.isArray(data.reviews) ? buildStats(data.reviews) : undefined);
  }
  const html = wrapHtml({ title, body: markdownToHtml(markdown), app, stats });
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, html, 'utf8');
  console.log(JSON.stringify({ html: output }, null, 2));
}

async function runFetch(args) {
  if (!args.query) throw new Error('--query is required unless --render-md is used');
  const maxReviews = Number.isFinite(args.maxReviews) && args.maxReviews > 0
    ? Math.min(500, Math.floor(args.maxReviews))
    : DEFAULT_MAX_REVIEWS;
  const requestedCountry = (args.country || DEFAULT_COUNTRY).toLowerCase();
  const { app, candidates, country } = await resolveApp(args.query, requestedCountry);
  const reviews = await fetchReviews(app.id, country, maxReviews);
  if (!reviews.length) throw new Error(`No reviews fetched for ${app.name} (${app.id}) in ${country}`);
  const outDir = path.resolve(args.out || path.join(process.cwd(), 'app-review-output', `${country}-${app.id}-${slugify(app.name)}`));
  const result = await writeOutputs({ app, candidates, reviews, outDir });
  console.log(JSON.stringify({
    app: { id: app.id, name: app.name, country },
    totalReviews: result.stats.totalReviews,
    averageRating: result.stats.averageRating,
    outputs: {
      json: result.json,
      markdown: result.markdown,
      html: result.html,
      prompt: result.prompt,
    },
  }, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }
  if (args.renderMd) {
    await renderMarkdownFile(args);
  } else {
    await runFetch(args);
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
