---
name: qiaomu-app-review
description: |
  Use when a user wants to analyze App Store reviews, mine product opportunities
  from user comments, compare competitor pain points, generate durable review
  insight pages, or deploy/reuse the Qiaomu App Review Insights website.
---

# Qiaomu App Review

Turn App Store comments into product insight, evidence, and durable review pages.

## Default Workflow

1. Identify the target app from an App Store URL, numeric App ID, or app name.
2. Ask for country only when the target is ambiguous; default to `us` for English/global apps and `cn` for Chinese-market apps when the user gives no clue.
3. Prefer evidence-backed output:
   - summarize only after review samples are available
   - keep representative review snippets
   - separate positive signals, pain points, opportunities, version risks, and action items
4. For quick manual use, send the user to the live site:
   - `https://appreview.qiaomu.ai`
5. For API or automation use, call the local/deployed service:
   - `POST /api/research`
   - `POST /api/research/regenerate`
   - `GET /api/health`
6. For source deployment, use the website repo:
   - `https://github.com/joeseesun/qiaomu-app-review-insights`

## API Shape

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

The website uses OpenAI-compatible API calls. The expected environment variables are:

```env
QIAOMU_LLM_API_KEY=your_api_key
QIAOMU_LLM_BASE_URL=https://api.deepseek.com/v1
QIAOMU_LLM_MODEL=deepseek-v4-flash
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
