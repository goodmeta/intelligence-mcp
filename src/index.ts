#!/usr/bin/env node
/**
 * Intelligence MCP Server
 *
 * Exposes agent payments ecosystem intelligence as MCP tools.
 * Scans GitHub, TechCrunch, HN, npm for signals. Classifies and scores.
 *
 * Tools:
 *   scan_opportunities  — scan ecosystem for actionable BD opportunities
 *   search_landscape    — query the protocol comparison matrix
 *   get_protocol_info   — get details on AP2, ACP, x402, MPP, or UCP
 *
 * Env:
 *   GITHUB_PAT          — GitHub personal access token
 *   ANTHROPIC_API_KEY   — for Haiku classification
 */

import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Signal {
  source: string;
  type: string;
  title: string;
  description: string;
  url: string;
  date: string;
  stars?: number;
}

interface Opportunity {
  title: string;
  source: string;
  url: string;
  category: string;
  total_score: number;
  recommended_action: string;
  reasoning: string;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const GITHUB_PAT = process.env.GITHUB_PAT || "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

const KEYWORDS = [
  "agent payments", "agentic payments", "agentic commerce",
  "x402", "AP2 protocol", "machine payments protocol",
  "agent spending", "agent verification", "payment mandate",
  "agent checkout", "AI payment", "agent wallet",
];

const GITHUB_ORGS = [
  "google-agentic-commerce", "tempoxyz", "wevm",
  "agentic-commerce-protocol", "Universal-Commerce-Protocol",
];

const PROTOCOL_DATA: Record<string, {
  name: string; creator: string; layer: string; maturity: string;
  repo: string; description: string;
}> = {
  ap2: {
    name: "AP2 (Agent Payments Protocol)",
    creator: "Google",
    layer: "Authorization",
    maturity: "V0.1 (spec + samples)",
    repo: "https://github.com/google-agentic-commerce/AP2",
    description: "Authorization and accountability layer. Defines mandates (IntentMandate, CartMandate, PaymentMandate) that prove a human authorized an agent to buy something. 125 partners including Mastercard, PayPal, Adyen.",
  },
  acp: {
    name: "ACP (Agentic Commerce Protocol)",
    creator: "OpenAI + Stripe",
    layer: "Commerce (checkout)",
    maturity: "Beta (4 releases)",
    repo: "https://github.com/agentic-commerce-protocol/agentic-commerce-protocol",
    description: "Commerce checkout layer. REST APIs for checkout sessions with Delegate Payment tokens and Allowance constraints. Signatories: Stripe, OpenAI, Adyen, Wix, commercetools, Affirm, Meta.",
  },
  x402: {
    name: "x402",
    creator: "Coinbase",
    layer: "Settlement",
    maturity: "V2 (production SDKs)",
    repo: "https://github.com/coinbase/x402",
    description: "Per-request stablecoin payments via HTTP 402. EIP-3009 gasless signing. Multi-chain (Base, Ethereum, Polygon, Solana, Algorand, Aptos, Hedera, Stellar, Sui). Budget management explicitly out of scope.",
  },
  mpp: {
    name: "MPP (Machine Payments Protocol)",
    creator: "Tempo Labs + Stripe",
    layer: "Settlement",
    maturity: "IETF draft-00",
    repo: "https://github.com/tempoxyz/mpp-specs",
    description: "Multi-rail settlement via HTTP 402. Supports Tempo stablecoins, Stripe cards, Lightning, Solana, Stellar. Challenge/credential/receipt flow. Agent delegation explicitly left to higher layers.",
  },
  ucp: {
    name: "UCP (Universal Commerce Protocol)",
    creator: "Google (+ Shopify)",
    layer: "Commerce (full-stack)",
    maturity: "Pre-release draft",
    repo: "https://github.com/Universal-Commerce-Protocol/ucp",
    description: "Full-stack commerce orchestration. Capabilities (checkout, identity, orders, payment tokens) + extensions (AP2 mandates, discounts, fulfillment). Multi-transport: REST, MCP, A2A. Powers checkout in Gemini.",
  },
};

// ---------------------------------------------------------------------------
// GitHub scanning
// ---------------------------------------------------------------------------

async function ghFetch(url: string): Promise<Response> {
  return fetch(url, {
    headers: {
      Authorization: `token ${GITHUB_PAT}`,
      Accept: "application/vnd.github.v3+json",
    },
  });
}

async function scanGitHubNewRepos(days: number): Promise<Signal[]> {
  const since = new Date(Date.now() - days * 86400000);
  const signals: Signal[] = [];

  for (const org of GITHUB_ORGS) {
    try {
      const r = await ghFetch(
        `https://api.github.com/orgs/${org}/repos?sort=created&direction=desc&per_page=10`
      );
      if (!r.ok) continue;
      const repos = (await r.json()) as any[];
      for (const repo of repos) {
        if (new Date(repo.created_at) >= since) {
          signals.push({
            source: "github",
            type: "new_repo",
            title: `New repo: ${repo.full_name}`,
            description: repo.description || "",
            url: repo.html_url,
            date: repo.created_at,
            stars: repo.stargazers_count,
          });
        }
      }
    } catch {}
    await sleep(300);
  }
  return signals;
}

async function scanGitHubKeywords(days: number): Promise<Signal[]> {
  const since = new Date(Date.now() - days * 86400000);
  const dateStr = since.toISOString().split("T")[0];
  const signals: Signal[] = [];
  const seen = new Set<string>();

  for (const kw of KEYWORDS.slice(0, 6)) {
    try {
      const q = encodeURIComponent(`${kw} created:>${dateStr}`);
      const r = await ghFetch(
        `https://api.github.com/search/repositories?q=${q}&sort=created&order=desc&per_page=5`
      );
      if (!r.ok) continue;
      const data = (await r.json()) as any;
      for (const repo of data.items || []) {
        if (seen.has(repo.html_url)) continue;
        seen.add(repo.html_url);
        signals.push({
          source: "github",
          type: "new_repo",
          title: `New repo: ${repo.full_name}`,
          description: repo.description || "",
          url: repo.html_url,
          date: repo.created_at,
          stars: repo.stargazers_count,
        });
      }
    } catch {}
    await sleep(1000);
  }
  return signals;
}

// ---------------------------------------------------------------------------
// HN scanning
// ---------------------------------------------------------------------------

async function scanHN(days: number): Promise<Signal[]> {
  const since = Math.floor((Date.now() - days * 86400000) / 1000);
  const signals: Signal[] = [];
  const seen = new Set<string>();

  for (const kw of ["agent payments", "x402", "agentic commerce", "AI payment", "machine payments"]) {
    try {
      const r = await fetch(
        `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(kw)}&tags=story&numericFilters=created_at_i>${since}&hitsPerPage=5`
      );
      if (!r.ok) continue;
      const data = (await r.json()) as any;
      for (const hit of data.hits || []) {
        if (seen.has(hit.objectID)) continue;
        seen.add(hit.objectID);
        signals.push({
          source: "hackernews",
          type: "story",
          title: hit.title || "",
          description: `Points: ${hit.points || 0}, Comments: ${hit.num_comments || 0}`,
          url: `https://news.ycombinator.com/item?id=${hit.objectID}`,
          date: hit.created_at || "",
        });
      }
    } catch {}
    await sleep(300);
  }
  return signals;
}

// ---------------------------------------------------------------------------
// npm scanning
// ---------------------------------------------------------------------------

async function scanNpm(days: number): Promise<Signal[]> {
  const since = new Date(Date.now() - days * 86400000);
  const signals: Signal[] = [];
  const seen = new Set<string>();

  for (const term of ["x402", "agent-payment", "agentic-payment", "mpp payment", "payment-mandate"]) {
    try {
      const r = await fetch(
        `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(term)}&size=10`
      );
      if (!r.ok) continue;
      const data = (await r.json()) as any;
      for (const obj of data.objects || []) {
        const pkg = obj.package;
        if (seen.has(pkg.name)) continue;
        seen.add(pkg.name);
        if (pkg.date && new Date(pkg.date) < since) continue;
        signals.push({
          source: "npm",
          type: "package",
          title: `npm: ${pkg.name}`,
          description: pkg.description || "",
          url: `https://www.npmjs.com/package/${pkg.name}`,
          date: pkg.date || "",
        });
      }
    } catch {}
    await sleep(300);
  }
  return signals;
}

// ---------------------------------------------------------------------------
// Classification (Haiku)
// ---------------------------------------------------------------------------

async function classifySignals(signals: Signal[]): Promise<Opportunity[]> {
  if (!signals.length || !ANTHROPIC_API_KEY) return [];

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 8000,
      system: `You evaluate signals from the agent payments ecosystem. Score each on pain (0-5), code_hook (0-5), fit (0-5), actionability (0-5). Return JSON array of opportunities scoring 12+ total. Fields: title, source, url, category (prospect|contribution|content-idea|competitive-intel), total_score, recommended_action, reasoning. Return [] if nothing qualifies.`,
      messages: [{
        role: "user",
        content: `Evaluate these ${signals.length} signals. Return only those scoring 12+/20:\n\n${JSON.stringify(signals.slice(0, 50), null, 2)}`,
      }],
    }),
  });

  if (!r.ok) return [];
  const data = (await r.json()) as any;
  const raw = data.content?.[0]?.text || "[]";
  const cleaned = raw.replace(/^```json\n?/, "").replace(/\n?```$/, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "intelligence",
  version: "0.1.0",
});

// Tool: scan_opportunities
server.tool(
  "scan_opportunities",
  "Scan the agent payments ecosystem for actionable opportunities (new repos, funding, issues, packages). Returns scored and classified results.",
  {
    days: z.number().default(7).describe("How many days to look back (default 7)"),
    min_score: z.number().default(12).describe("Minimum score threshold (default 12/20)"),
  },
  async ({ days, min_score }) => {
    if (!GITHUB_PAT) {
      return { content: [{ type: "text" as const, text: "Error: GITHUB_PAT not configured" }] };
    }

    const signals: Signal[] = [];

    const [ghRepos, ghKeywords, hn, npm] = await Promise.all([
      scanGitHubNewRepos(days),
      scanGitHubKeywords(days),
      scanHN(days),
      scanNpm(days),
    ]);

    signals.push(...ghRepos, ...ghKeywords, ...hn, ...npm);

    if (!signals.length) {
      return { content: [{ type: "text" as const, text: "No signals found in the last " + days + " days." }] };
    }

    const opportunities = await classifySignals(signals);
    const filtered = opportunities.filter((o) => o.total_score >= min_score);

    if (!filtered.length) {
      return {
        content: [{
          type: "text" as const,
          text: `Scanned ${signals.length} signals. No opportunities scored ${min_score}+/20.`,
        }],
      };
    }

    const sorted = filtered.sort((a, b) => b.total_score - a.total_score);
    const lines = sorted.map(
      (o) =>
        `[${o.total_score}/20] [${o.category}] ${o.title}\n  Action: ${o.recommended_action}\n  Why: ${o.reasoning}\n  ${o.url}`
    );

    return {
      content: [{
        type: "text" as const,
        text: `Found ${sorted.length} opportunities (${signals.length} signals scanned):\n\n${lines.join("\n\n")}`,
      }],
    };
  }
);

// Tool: get_protocol_info
server.tool(
  "get_protocol_info",
  "Get details about a specific agent payment protocol (ap2, acp, x402, mpp, ucp).",
  {
    protocol: z
      .enum(["ap2", "acp", "x402", "mpp", "ucp"])
      .describe("Protocol to look up"),
  },
  async ({ protocol }) => {
    const p = PROTOCOL_DATA[protocol];
    if (!p) {
      return { content: [{ type: "text" as const, text: `Unknown protocol: ${protocol}` }] };
    }

    const text = [
      `# ${p.name}`,
      `**Creator:** ${p.creator}`,
      `**Layer:** ${p.layer}`,
      `**Maturity:** ${p.maturity}`,
      `**Repo:** ${p.repo}`,
      "",
      p.description,
    ].join("\n");

    return { content: [{ type: "text" as const, text }] };
  }
);

// Tool: compare_protocols
server.tool(
  "compare_protocols",
  "Compare agent payment protocols across key dimensions. Returns the comparison matrix.",
  {},
  async () => {
    const matrix = `
| Dimension | AP2 | ACP | x402 | MPP | UCP |
|-----------|-----|-----|------|-----|-----|
| Creator | Google | OpenAI + Stripe | Coinbase | Tempo + Stripe | Google + Shopify |
| Layer | Authorization | Commerce | Settlement | Settlement | Commerce |
| Maturity | V0.1 | Beta | V2 production | IETF draft | Pre-release |
| Agent Delegation | Yes (mandates) | Yes (allowance) | No (out of scope) | No (out of scope) | Yes (via AP2) |
| Budget Limits | Yes | Yes (per-merchant) | No | No | Yes (via AP2) |
| Cross-Merchant | Roadmap only | No | No | No | No |
| MCP Integration | Planned | No | Yes | Yes | Yes |

The gap nobody fills: cross-protocol budget tracking. An agent shopping via UCP, paying APIs via MPP, and settling via x402 has no unified spending verification.

Full comparison: https://github.com/goodmeta/agent-payments-landscape`;

    return { content: [{ type: "text" as const, text: matrix.trim() }] };
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Intelligence MCP server running");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
