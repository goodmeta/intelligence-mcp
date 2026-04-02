#!/usr/bin/env node
/**
 * Intelligence MCP Server — x402 gated
 *
 * Exposes agent payments ecosystem intelligence as paid MCP tools.
 * Agents pay $0.01 USDC per scan via x402.
 *
 * Tools:
 *   scan_opportunities  — PAID ($0.01) — scan ecosystem for BD opportunities
 *   get_protocol_info   — FREE — get details on AP2, ACP, x402, MPP, or UCP
 *   compare_protocols   — FREE — comparison matrix
 *
 * Transports:
 *   --stdio     run as stdio MCP server (default, for local testing)
 *   --http      run as HTTP server on port 3001 (for deployment)
 *
 * Env:
 *   GITHUB_PAT          — GitHub personal access token
 *   ANTHROPIC_API_KEY   — for Haiku classification
 *   X402_PAY_TO         — wallet address to receive payments
 *   X402_FACILITATOR_URL — facilitator URL (defaults to x402.org)
 */

import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { createPaymentWrapper } from "@x402/mcp";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { Hono } from "hono";
import { serve } from "@hono/node-server";

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

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const GITHUB_PAT = process.env.GITHUB_PAT || "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const X402_PAY_TO = process.env.X402_PAY_TO || "";
const X402_FACILITATOR_URL = process.env.X402_FACILITATOR_URL || "https://x402.org/facilitator";
const X402_NETWORK = "eip155:8453"; // Base mainnet
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SCAN_PRICE = "$0.01";

const isHttpMode = process.argv.includes("--http");
const PORT = parseInt(process.env.PORT || "3001");

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
    description: "Per-request stablecoin payments via HTTP 402. EIP-3009 gasless signing. Multi-chain. Budget management explicitly out of scope.",
  },
  mpp: {
    name: "MPP (Machine Payments Protocol)",
    creator: "Tempo Labs + Stripe",
    layer: "Settlement",
    maturity: "IETF draft-00",
    repo: "https://github.com/tempoxyz/mpp-specs",
    description: "Multi-rail settlement via HTTP 402. Supports Tempo stablecoins, Stripe cards, Lightning, Solana, Stellar. Agent delegation explicitly left to higher layers.",
  },
  ucp: {
    name: "UCP (Universal Commerce Protocol)",
    creator: "Google (+ Shopify)",
    layer: "Commerce (full-stack)",
    maturity: "Pre-release draft",
    repo: "https://github.com/Universal-Commerce-Protocol/ucp",
    description: "Full-stack commerce orchestration. AP2 mandates extension. Multi-transport: REST, MCP, A2A. Powers checkout in Gemini.",
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
            source: "github", type: "new_repo",
            title: `New repo: ${repo.full_name}`,
            description: repo.description || "",
            url: repo.html_url, date: repo.created_at,
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
          source: "github", type: "new_repo",
          title: `New repo: ${repo.full_name}`,
          description: repo.description || "",
          url: repo.html_url, date: repo.created_at,
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

  for (const kw of ["agent payments", "x402", "agentic commerce", "AI payment"]) {
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
          source: "hackernews", type: "story",
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

  for (const term of ["x402", "agent-payment", "agentic-payment", "mpp payment"]) {
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
          source: "npm", type: "package",
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

async function classifySignals(signals: Signal[]): Promise<any[]> {
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
      system: `You evaluate signals from the agent payments ecosystem. Score each on pain (0-5), code_hook (0-5), fit (0-5), actionability (0-5). Return JSON array of opportunities scoring 12+ total. Fields: title, source, url, category, total_score, recommended_action, reasoning. Return [] if nothing qualifies.`,
      messages: [{
        role: "user",
        content: `Evaluate these ${signals.length} signals:\n\n${JSON.stringify(signals.slice(0, 50), null, 2)}`,
      }],
    }),
  });

  if (!r.ok) return [];
  const data = (await r.json()) as any;
  const raw = data.content?.[0]?.text || "[]";
  const cleaned = raw.replace(/^```json\n?/, "").replace(/\n?```$/, "").trim();
  try { return JSON.parse(cleaned); } catch { return []; }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// MCP Server Setup
// ---------------------------------------------------------------------------

async function createServer(): Promise<McpServer> {
  const server = new McpServer({
    name: "intelligence",
    version: "0.1.0",
  });

  // Set up x402 payment wrapper (only if PAY_TO is configured)
  let paidScan: any = null;

  if (X402_PAY_TO) {
    try {
      const facilitatorClient = new HTTPFacilitatorClient({ url: X402_FACILITATOR_URL });
      const resourceServer = new x402ResourceServer(facilitatorClient);
      resourceServer.register(X402_NETWORK, new ExactEvmScheme());
      await resourceServer.initialize();

      const scanAccepts = await resourceServer.buildPaymentRequirements({
        scheme: "exact",
        network: X402_NETWORK,
        payTo: X402_PAY_TO,
        price: SCAN_PRICE,
        extra: { name: "USDC", version: "2" },
      });

      paidScan = createPaymentWrapper(resourceServer, { accepts: scanAccepts });
      console.error(`x402 payment gating enabled (${SCAN_PRICE} per scan, pay to ${X402_PAY_TO})`);
    } catch (e) {
      console.error("x402 setup failed, running in free mode:", e);
    }
  } else {
    console.error("No X402_PAY_TO configured, running in free mode");
  }

  // Tool: scan_opportunities (paid if x402 configured, free otherwise)
  const scanHandler = async (args: { days: number; min_score: number }) => {
    if (!GITHUB_PAT) {
      return { content: [{ type: "text" as const, text: "Error: GITHUB_PAT not configured" }] };
    }

    const signals: Signal[] = [];
    const [ghRepos, ghKeywords, hn, npm] = await Promise.all([
      scanGitHubNewRepos(args.days),
      scanGitHubKeywords(args.days),
      scanHN(args.days),
      scanNpm(args.days),
    ]);
    signals.push(...ghRepos, ...ghKeywords, ...hn, ...npm);

    if (!signals.length) {
      return { content: [{ type: "text" as const, text: `No signals found in the last ${args.days} days.` }] };
    }

    const opportunities = await classifySignals(signals);
    const filtered = opportunities.filter((o: any) => o.total_score >= args.min_score);

    if (!filtered.length) {
      return {
        content: [{ type: "text" as const, text: `Scanned ${signals.length} signals. No opportunities scored ${args.min_score}+/20.` }],
      };
    }

    const sorted = filtered.sort((a: any, b: any) => b.total_score - a.total_score);
    const lines = sorted.map(
      (o: any) => `[${o.total_score}/20] [${o.category}] ${o.title}\n  Action: ${o.recommended_action}\n  Why: ${o.reasoning}\n  ${o.url}`
    );

    return {
      content: [{ type: "text" as const, text: `Found ${sorted.length} opportunities (${signals.length} signals scanned):\n\n${lines.join("\n\n")}` }],
    };
  };

  if (paidScan) {
    server.tool(
      "scan_opportunities",
      `Scan the agent payments ecosystem for actionable opportunities. Costs ${SCAN_PRICE} USDC via x402.`,
      { days: z.number().default(7), min_score: z.number().default(12) },
      paidScan(async (args: any) => scanHandler(args))
    );
  } else {
    server.tool(
      "scan_opportunities",
      "Scan the agent payments ecosystem for actionable opportunities.",
      { days: z.number().default(7), min_score: z.number().default(12) },
      async (args: any) => scanHandler(args)
    );
  }

  // Tool: get_protocol_info (always free)
  server.tool(
    "get_protocol_info",
    "Get details about a specific agent payment protocol.",
    { protocol: z.enum(["ap2", "acp", "x402", "mpp", "ucp"]) },
    async ({ protocol }) => {
      const p = PROTOCOL_DATA[protocol];
      const text = [
        `# ${p.name}`, `**Creator:** ${p.creator}`, `**Layer:** ${p.layer}`,
        `**Maturity:** ${p.maturity}`, `**Repo:** ${p.repo}`, "", p.description,
      ].join("\n");
      return { content: [{ type: "text" as const, text }] };
    }
  );

  // Tool: compare_protocols (always free)
  server.tool(
    "compare_protocols",
    "Compare agent payment protocols across key dimensions.",
    {},
    async () => {
      const matrix = `| Dimension | AP2 | ACP | x402 | MPP | UCP |
|-----------|-----|-----|------|-----|-----|
| Creator | Google | OpenAI + Stripe | Coinbase | Tempo + Stripe | Google + Shopify |
| Layer | Authorization | Commerce | Settlement | Settlement | Commerce |
| Agent Delegation | Yes (mandates) | Yes (allowance) | No | No | Yes (via AP2) |
| Budget Limits | Yes | Yes (per-merchant) | No | No | Yes (via AP2) |
| Cross-Merchant | Roadmap only | No | No | No | No |
| MCP Integration | Planned | No | Yes | Yes | Yes |

The gap nobody fills: cross-protocol budget tracking.

Full comparison: https://github.com/goodmeta/agent-payments-landscape`;
      return { content: [{ type: "text" as const, text: matrix }] };
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  const server = await createServer();

  if (isHttpMode) {
    // Streamable HTTP transport via Hono
    const app = new Hono();
    const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();

    app.all("/mcp", async (c) => {
      const sessionId = c.req.header("mcp-session-id");

      if (c.req.method === "GET" || c.req.method === "POST") {
        // Check for existing session
        if (sessionId && sessions.has(sessionId)) {
          const transport = sessions.get(sessionId)!;
          return transport.handleRequest(c.req.raw);
        }

        if (c.req.method === "GET") {
          return new Response("No session", { status: 400 });
        }

        // New session (POST only)
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
        });

        transport.onclose = () => {
          const sid = (transport as any)._sessionId;
          if (sid) sessions.delete(sid);
        };

        await server.connect(transport);
        const response = await transport.handleRequest(c.req.raw);

        // Store session
        const newSessionId = response.headers.get("mcp-session-id");
        if (newSessionId) {
          sessions.set(newSessionId, transport);
        }

        return response;
      }

      if (c.req.method === "DELETE") {
        if (sessionId && sessions.has(sessionId)) {
          const transport = sessions.get(sessionId)!;
          await transport.close();
          sessions.delete(sessionId);
        }
        return new Response(null, { status: 204 });
      }

      return new Response("Method not allowed", { status: 405 });
    });

    app.get("/health", (c) => c.json({ ok: true, mode: "http", x402: !!X402_PAY_TO }));
    app.get("/", (c) => c.json({
      name: "Intelligence MCP Server",
      version: "0.1.0",
      endpoint: "/mcp",
      tools: ["scan_opportunities", "get_protocol_info", "compare_protocols"],
      x402: X402_PAY_TO ? { enabled: true, price: SCAN_PRICE, network: X402_NETWORK } : { enabled: false },
    }));

    serve({ fetch: app.fetch, port: PORT });
    console.error(`Intelligence MCP server running on http://localhost:${PORT}/mcp`);
  } else {
    // Stdio transport (local testing)
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Intelligence MCP server running (stdio)");
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
