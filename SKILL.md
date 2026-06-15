---
name: qiaomu-app-review
description: |
  Use when a user wants to analyze App Store reviews, mine product opportunities
  from user comments, compare competitor pain points, generate durable review
  insight reports, or create local HTML/Markdown evidence pages without relying
  on a hosted website or a specific LLM provider.
---

# Qiaomu App Review

Turn App Store comments into product insight, evidence, and durable review pages.

## Default Workflow

1. Identify the target app from an App Store URL, numeric App ID, or app name.
2. Ask for country only when the target is ambiguous; default to `us` for English/global apps and `cn` for Chinese-market apps when the user gives no clue.
3. Prefer the local standalone runner when you are in this skill repo or an installed skill folder:
   - `node scripts/app_review_local.mjs --query "ChatGPT" --country us --max-reviews 120`
4. Use the current Agent's own model to write the analysis from the generated evidence files. Do not require Qiaomu LLM, any vendor API key, or the live website for normal skill use.
5. Prefer evidence-backed output:
   - summarize only after review samples are available
   - keep representative review snippets
   - separate positive signals, pain points, opportunities, version risks, and action items
6. For quick manual use or public web pages, optionally send the user to the live site:
   - `https://appreview.qiaomu.ai`
7. For website API or automation use, optionally call the local/deployed service:
   - `POST /api/research`
   - `POST /api/research/regenerate`
   - `GET /api/health`
8. For source deployment, use the website repo:
   - `https://github.com/joeseesun/qiaomu-app-review-insights`

## Local Standalone Workflow

Fetch reviews and generate a local evidence package:

```bash
node scripts/app_review_local.mjs \
  --query "ChatGPT" \
  --country us \
  --max-reviews 120 \
  --out ./app-review-output/chatgpt
```

The runner writes:

- `reviews.json`: structured app metadata, stats, review samples, and search candidates
- `evidence.md`: human-readable evidence package with review snippets
- `evidence.html`: local browser page with a chart dashboard, stats, and review evidence
- `agent-prompt.md`: prompt for the current Agent to produce the final product insight report

After the current Agent writes `insight.md`, render it into a shareable local HTML page:

```bash
node scripts/app_review_local.mjs \
  --render-md ./app-review-output/chatgpt/insight.md \
  --data ./app-review-output/chatgpt/reviews.json \
  --html ./app-review-output/chatgpt/insight.html \
  --title "ChatGPT 评价洞察"
```

The HTML dashboard should include practical visual signals: rating distribution, sentiment mix, version risk, review timeline, repeated terms, and review depth by rating. These charts are generated from local review data and should not require external JavaScript or a hosted service.

## Optional Website API

Generate or read a cached insight page:

```bash
curl -X POST https://appreview.qiaomu.ai/api/research \
  -H 'Content-Type: application/json' \
  -d '{"query":"ChatGPT","country":"us","maxReviews":160}'
```

Force regeneration:

```bash
curl -X POST https://appreview.qiaomu.ai/api/research/regenerate \
  -H 'Content-Type: application/json' \
  -d '{"appId":"6448311069","country":"us","maxReviews":160}'
```

## Output Standards

When producing a report for the user, include:

- `摘要`: short product-positioning summary based on reviews
- `核心痛点`: repeated frustrations with evidence
- `产品机会`: opportunities that can become roadmap or indie-app ideas
- `正向信号`: what users already value
- `用户分层`: user groups and their different concerns
- `版本风险`: feedback tied to updates, regressions, pricing, limits, or performance
- `行动建议`: concrete product or research next steps

## Environment Notes

The standalone skill workflow requires Node.js only. It does not need an LLM API key because the user's current Agent writes the report.

The optional website deployment uses OpenAI-compatible API calls. If you deploy the website yourself, configure the provider there:

```env
QIAOMU_LLM_API_KEY=your_api_key
QIAOMU_LLM_BASE_URL=https://your-openai-compatible-endpoint/v1
QIAOMU_LLM_MODEL=your_model
```

Never print, store, or commit real API keys. Use local `.env.local`, macOS Keychain, or the host platform's secret store.

## Guardrails

- Do not invent review evidence. If no review samples are available, say that clearly.
- Do not treat AI summaries as facts without showing representative comments.
- Do not commit `.env.local`, `.env.development`, cache data, tokens, or private deployment paths.
- For public pages, keep distribution fundamentals: stable URL, title/description, canonical URL, structured data, update time, and source evidence.

## Metadata

Copyright (c) 向阳乔木

- Live site: https://appreview.qiaomu.ai
- Source repo: https://github.com/joeseesun/qiaomu-app-review-insights
- X: https://x.com/vista8
- GitHub: https://github.com/joeseesun/
