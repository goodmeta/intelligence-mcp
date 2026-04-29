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
import { Mppx, tempo } from "mppx/server";
import { Transport as McpMppTransport } from "mppx/mcp-sdk/server";
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
const X402_FACILITATOR_URL = process.env.X402_FACILITATOR_URL || "https://x402.goodmeta.co";
const X402_NETWORK = "eip155:8453"; // Base mainnet
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SCAN_PRICE = "$0.01";

// MPP config
const MPP_SECRET_KEY = process.env.MPP_SECRET_KEY || "";
const MPP_RECIPIENT = process.env.MPP_RECIPIENT || ""; // Tempo address
const MPP_CURRENCY = process.env.MPP_CURRENCY || "0x20c0000000000000000000000000000000000000"; // Tempo USDC

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

// ---------------------------------------------------------------------------
// Payment config — initialized once at startup, shared across sessions
// ---------------------------------------------------------------------------

interface PaymentConfig {
  paidScan: any;
  mppPayment: any;
  paymentMethods: string[];
}

async function initPayments(): Promise<PaymentConfig> {
  let paidScan: any = null;
  let mppPayment: any = null;
  const paymentMethods: string[] = [];

  // x402 setup
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
      paymentMethods.push("x402 (USDC on Base)");
      console.error(`x402 payment gating enabled (${SCAN_PRICE} per scan)`);
    } catch (e) {
      console.error("x402 setup failed:", e);
    }
  }

  // MPP setup
  if (MPP_SECRET_KEY && MPP_RECIPIENT) {
    try {
      mppPayment = Mppx.create({
        methods: [
          tempo.charge({
            currency: MPP_CURRENCY as `0x${string}`,
            recipient: MPP_RECIPIENT as `0x${string}`,
          }),
        ],
        secretKey: MPP_SECRET_KEY,
        transport: McpMppTransport.mcpSdk(),
      });
      paymentMethods.push("MPP (Tempo USDC)");
      console.error("MPP payment gating enabled");
    } catch (e) {
      console.error("MPP setup failed:", e);
    }
  }

  if (!paymentMethods.length) {
    console.error("No payment methods configured, running in free mode");
  } else {
    console.error(`Payment methods: ${paymentMethods.join(", ")}`);
  }

  return { paidScan, mppPayment, paymentMethods };
}

// ---------------------------------------------------------------------------
// MCP Server Factory — creates a new instance per session
// ---------------------------------------------------------------------------

function createServer(payments: PaymentConfig): McpServer {
  const server = new McpServer({
    name: "intelligence",
    title: "Good Meta Intelligence",
    description: "Agent payments ecosystem intelligence. Scans GitHub, Hacker News, and npm for activity across AP2, ACP, x402, MPP, and UCP. Returns scored and classified opportunities. Use to research agent payment protocols, compare them, or find new developments in the space.",
    version: "0.1.5",
    websiteUrl: "https://intel.goodmeta.co",
    icons: [
      { src: "https://goodmeta.co/images/gm-logo-1024.png", mimeType: "image/png", sizes: ["1024x1024"] },
    ],
  });

  const { paidScan, mppPayment, paymentMethods } = payments;

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

  const payDesc = paymentMethods.length
    ? `Costs ${SCAN_PRICE} USDC. Accepts: ${paymentMethods.join(" or ")}.`
    : "";

  // Build the scan handler callback based on payment configuration
  let scanCallback: any;
  if (paidScan && !mppPayment) {
    scanCallback = paidScan(async (args: any) => scanHandler(args));
  } else if (mppPayment && !paidScan) {
    scanCallback = async (args: any, extra: any) => {
      const result = await mppPayment.tempo.charge({ amount: "10000" })(extra);
      if (result.status === 402) throw result.challenge;
      return result.withReceipt(await scanHandler(args));
    };
  } else if (paidScan && mppPayment) {
    // Both — x402 as primary wrapper. Agent sending MPP credential will get 402, retry with x402.
    scanCallback = paidScan(async (args: any) => scanHandler(args));
  } else {
    scanCallback = async (args: any) => scanHandler(args);
  }

  server.registerTool(
    "scan_opportunities",
    {
      title: "Scan Agent Payments Ecosystem",
      description: paymentMethods.length
        ? `Scan GitHub, Hacker News, and npm for new repos, packages, and discussions in the agent payments ecosystem (AP2, ACP, x402, MPP, UCP). Returns AI-classified and scored opportunities with recommended actions. Use when the user asks about recent activity, new developments, or opportunities in agent payments ('what's new in agent payments?', 'any new x402 repos?', 'scan for opportunities'). Use get_protocol_info instead for static protocol details, or compare_protocols for side-by-side comparison. ${payDesc}`
        : "Scan GitHub, Hacker News, and npm for new repos, packages, and discussions in the agent payments ecosystem (AP2, ACP, x402, MPP, UCP). Returns AI-classified and scored opportunities with recommended actions. Use when the user asks about recent activity, new developments, or opportunities in agent payments ('what's new in agent payments?', 'any new x402 repos?', 'scan for opportunities'). Use get_protocol_info instead for static protocol details, or compare_protocols for side-by-side comparison.",
      inputSchema: {
        days: z.number().default(7).describe("Look-back window in days (e.g., 7 for last week, 30 for last month). Default 7."),
        min_score: z.number().default(12).describe("Minimum opportunity score out of 20 (e.g., 12 for high-quality only, 8 for broader results). Default 12."),
      },
      annotations: {
        title: "Scan Agent Payments Ecosystem",
        readOnlyHint: true,
        openWorldHint: true,
        idempotentHint: false,
      },
    },
    scanCallback,
  );

  // Tool: get_protocol_info (always free)
  server.registerTool(
    "get_protocol_info",
    {
      title: "Get Protocol Info",
      description: "Get the canonical description of an agent payment protocol including creator, maturity level, repo URL, and what layer it operates at (authorization, commerce, or settlement). Use when the user asks about a specific protocol ('what is AP2?', 'who created MPP?', 'is x402 production ready?', 'what layer does ACP operate at?'). Use compare_protocols instead when comparing multiple protocols against each other.",
      inputSchema: {
        protocol: z.enum(["ap2", "acp", "x402", "mpp", "ucp"]).describe("Protocol identifier (e.g., 'ap2' for Google's authorization layer, 'x402' for Coinbase's settlement layer)."),
      },
      annotations: {
        title: "Get Protocol Info",
        readOnlyHint: true,
        openWorldHint: false,
        idempotentHint: true,
      },
    },
    async ({ protocol }) => {
      const p = PROTOCOL_DATA[protocol];
      const text = [
        `# ${p.name}`, `**Creator:** ${p.creator}`, `**Layer:** ${p.layer}`,
        `**Maturity:** ${p.maturity}`, `**Repo:** ${p.repo}`, "", p.description,
      ].join("\n");
      return { content: [{ type: "text" as const, text }] };
    },
  );

  // Tool: compare_protocols (always free)
  server.registerTool(
    "compare_protocols",
    {
      title: "Compare Protocols",
      description: "Get a side-by-side comparison matrix of all five agent payment protocols (AP2, ACP, x402, MPP, UCP) across creator, layer, agent delegation, budget limits, cross-merchant coordination, and MCP integration. Use when the user asks to compare protocols ('AP2 vs ACP', 'which protocol handles budgets?', 'what's the difference between x402 and MPP?', 'show me the landscape'). Use get_protocol_info instead for deep details on a single protocol.",
      inputSchema: {},
      annotations: {
        title: "Compare Protocols",
        readOnlyHint: true,
        openWorldHint: false,
        idempotentHint: true,
      },
    },
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
    },
  );

  // Prompt: agent-payments-briefing — guides the agent on how to use this server effectively
  server.registerPrompt(
    "agent_payments_briefing",
    {
      title: "Agent Payments Briefing",
      description: "Walk an LLM through how to research the agent payments ecosystem using this server's tools.",
      argsSchema: {
        focus: z.string().optional().describe("Optional protocol to focus on (ap2, acp, x402, mpp, ucp)."),
      },
    },
    ({ focus }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: focus
              ? `Use the get_protocol_info tool with protocol=${focus} to get the canonical description, then call compare_protocols to see how it relates to the others. If you need fresh activity, call scan_opportunities (paid: $0.01 USDC via x402).`
              : `Start with compare_protocols to see the landscape. Then use get_protocol_info on any specific protocol you want to dig into. For fresh activity from GitHub/HN/npm, call scan_opportunities (paid: $0.01 USDC via x402).`,
          },
        },
      ],
    }),
  );

  // Resource: ecosystem-overview — static reference to the comparison matrix repo
  server.registerResource(
    "ecosystem-overview",
    "https://github.com/goodmeta/agent-payments-landscape",
    {
      title: "Agent Payments Landscape",
      description: "Living comparison matrix of AP2, ACP, x402, MPP, and UCP. Source repo for this server's protocol data.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: "Reference: https://github.com/goodmeta/agent-payments-landscape\n\nFor structured access, call the compare_protocols tool.",
        },
      ],
    }),
  );

  return server;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  const payments = await initPayments();

  if (isHttpMode) {
    // Streamable HTTP transport via Hono
    const app = new Hono();
    const sessions = new Map<string, { transport: WebStandardStreamableHTTPServerTransport; server: McpServer }>();

    // Structured access log — every request gets one JSON line on stderr
    app.use("*", async (c, next) => {
      const start = Date.now();
      const ua = c.req.header("user-agent") || "";
      const ref = c.req.header("referer") || "";
      const fwd = c.req.header("fly-client-ip") || c.req.header("x-forwarded-for") || "";
      const region = c.req.header("fly-region") || "";
      const mcpSession = c.req.header("mcp-session-id") || "";
      await next();
      const entry = {
        t: new Date().toISOString(),
        m: c.req.method,
        p: c.req.path,
        s: c.res.status,
        ms: Date.now() - start,
        ua,
        ref,
        ip: fwd,
        reg: region,
        sid: mcpSession,
      };
      console.error("ACCESS " + JSON.stringify(entry));
    });

    app.all("/mcp", async (c) => {
      const sessionId = c.req.header("mcp-session-id");

      if (c.req.method === "GET" || c.req.method === "POST") {
        // Check for existing session
        if (sessionId && sessions.has(sessionId)) {
          const { transport } = sessions.get(sessionId)!;
          return transport.handleRequest(c.req.raw);
        }

        if (c.req.method === "GET") {
          // Browser visitor gets redirected to landing page
          const accept = c.req.header("accept") || "";
          if (accept.includes("text/html")) {
            return c.redirect("/");
          }
          return new Response("No session. This is the MCP endpoint — connect via an MCP client. See https://intel.goodmeta.co for setup instructions.", { status: 400 });
        }

        // New session (POST only) — each session gets its own McpServer instance
        const server = createServer(payments);
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
          sessions.set(newSessionId, { transport, server });
        }

        return response;
      }

      if (c.req.method === "DELETE") {
        if (sessionId && sessions.has(sessionId)) {
          const { transport } = sessions.get(sessionId)!;
          await transport.close();
          sessions.delete(sessionId);
        }
        return new Response(null, { status: 204 });
      }

      return new Response("Method not allowed", { status: 405 });
    });

    // Static server card for Smithery and other discovery layers
    app.get("/.well-known/mcp/server-card.json", (c) => {
      return c.json({
        serverInfo: {
          name: "intelligence",
          title: "Good Meta Intelligence",
          description: "Agent payments ecosystem intelligence. Scans GitHub, Hacker News, and npm for activity across AP2, ACP, x402, MPP, and UCP.",
          version: "0.1.5",
          websiteUrl: "https://intel.goodmeta.co",
          icons: [
            { src: "https://goodmeta.co/images/gm-logo-1024.png", mimeType: "image/png", sizes: ["1024x1024"] },
          ],
        },
        capabilities: {
          tools: { listChanged: false },
          prompts: { listChanged: false },
          resources: { listChanged: false, subscribe: false },
        },
        authentication: {
          required: false,
          schemes: ["x402", "mpp"],
          notes: "scan_opportunities requires payment ($0.01 USDC via x402 on Base, or MPP Tempo USDC). Other tools are free. Authentication is per-request via the payment protocols, not session-level.",
        },
        configSchema: {
          type: "object",
          description: "Optional configuration. Remote server uses internal credentials; these are only required when self-hosting via the npm package.",
          properties: {
            GITHUB_PAT: {
              type: "string",
              description: "GitHub Personal Access Token. Required when self-hosting.",
              format: "password",
            },
            ANTHROPIC_API_KEY: {
              type: "string",
              description: "Anthropic API key for signal classification. Required when self-hosting.",
              format: "password",
            },
          },
          required: [],
        },
        contact: {
          repository: "https://github.com/goodmeta/intelligence-mcp",
          homepage: "https://intel.goodmeta.co",
          email: "eric@goodmeta.co",
        },
      });
    });

    app.get("/health", (c) => c.json({ ok: true, mode: "http", x402: !!X402_PAY_TO }));
    app.get("/api/info", (c) => c.json({
      name: "Intelligence MCP Server",
      version: "0.1.0",
      endpoint: "/mcp",
      tools: ["scan_opportunities", "get_protocol_info", "compare_protocols"],
      x402: X402_PAY_TO ? { enabled: true, price: SCAN_PRICE, network: X402_NETWORK } : { enabled: false },
    }));
    app.get("/", (c) => {
      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Intel — Agent Payments Intelligence</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0f; color: #e2e8f0; line-height: 1.7; }
    .container { max-width: 720px; margin: 0 auto; padding: 80px 24px; }
    h1 { font-size: 2.2em; font-weight: 700; letter-spacing: -1px; color: #f8fafc; margin-bottom: 8px; }
    .subtitle { color: #64748b; font-size: 1.1em; margin-bottom: 48px; }
    .badge { display: inline-block; background: #1e293b; color: #3b82f6; padding: 3px 10px; border-radius: 4px; font-size: 0.8em; font-weight: 600; margin-bottom: 24px; letter-spacing: 0.5px; }
    h2 { font-size: 1.1em; color: #94a3b8; margin-top: 48px; margin-bottom: 16px; text-transform: uppercase; letter-spacing: 1px; font-weight: 500; }
    .tool { background: #111827; border: 1px solid #1e293b; border-radius: 8px; padding: 20px; margin-bottom: 12px; }
    .tool-name { font-family: ui-monospace, monospace; color: #3b82f6; font-weight: 600; font-size: 0.95em; }
    .tool-price { float: right; color: #22c55e; font-size: 0.85em; }
    .tool-desc { color: #94a3b8; font-size: 0.9em; margin-top: 6px; }
    pre { background: #111827; border: 1px solid #1e293b; border-radius: 8px; padding: 20px; overflow-x: auto; font-size: 0.85em; line-height: 1.6; margin-bottom: 12px; }
    code { font-family: ui-monospace, monospace; }
    .comment { color: #475569; }
    .string { color: #22c55e; }
    .key { color: #3b82f6; }
    a { color: #3b82f6; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .footer { margin-top: 64px; padding-top: 24px; border-top: 1px solid #1e293b; color: #475569; font-size: 0.85em; }
    .protocols { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 32px; }
    .protocols span { background: #1e293b; padding: 4px 12px; border-radius: 4px; font-size: 0.8em; color: #94a3b8; }
  </style>
</head>
<body>
  <div class="container">
    <div class="badge">MCP SERVER</div>
    <h1>Agent Payments Intelligence</h1>
    <p class="subtitle">AI agents scanning the agent payments ecosystem. GitHub, Hacker News, npm. Classified, scored, actionable.</p>

    <div class="protocols">
      <span>AP2</span><span>ACP</span><span>x402</span><span>MPP</span><span>UCP</span><span>MCP</span>
    </div>

    <h2>Tools</h2>

    <div class="tool">
      <span class="tool-name">scan_opportunities</span>
      <span class="tool-price">${X402_PAY_TO ? "$0.01 USDC" : "free"}</span>
      <p class="tool-desc">Scan GitHub, HN, npm for new repos, issues, packages, and funding signals in the agent payments ecosystem. Returns scored and classified opportunities with recommended actions.</p>
    </div>

    <div class="tool">
      <span class="tool-name">get_protocol_info</span>
      <span class="tool-price">free</span>
      <p class="tool-desc">Get details on any of the five agent payment protocols: AP2, ACP, x402, MPP, or UCP.</p>
    </div>

    <div class="tool">
      <span class="tool-name">compare_protocols</span>
      <span class="tool-price">free</span>
      <p class="tool-desc">Full comparison matrix across all five protocols. Authorization, settlement, commerce layers.</p>
    </div>

    <h2>Connect</h2>

    <pre><code><span class="comment">// Claude Code / Cursor — add to MCP config:</span>
{
  <span class="key">"mcpServers"</span>: {
    <span class="key">"intelligence"</span>: {
      <span class="key">"type"</span>: <span class="string">"url"</span>,
      <span class="key">"url"</span>: <span class="string">"https://intel.goodmeta.co/mcp"</span>
    }
  }
}</code></pre>

    <pre><code><span class="comment"># Then ask your agent:</span>
"Scan for agent payment opportunities from the last 7 days"
"Compare AP2 vs MPP vs x402"
"Tell me about the UCP protocol"</code></pre>

    <h2>Try It</h2>

    <pre><code><span class="comment"># List available tools</span>
curl -X POST https://intel.goodmeta.co/mcp \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json, text/event-stream" \\
  -H "MCP-Protocol-Version: 2025-06-18" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","clientInfo":{"name":"curl","version":"1.0"},"capabilities":{}}}'</code></pre>

    <div class="footer">
      <p>Built by <a href="https://linkedin.com/in/tsangeric">Eric Tsang</a> / <a href="https://goodmeta.co">Good Meta</a></p>
      <p style="margin-top: 8px;">
        <a href="https://github.com/goodmeta/intelligence-mcp">GitHub</a> ·
        <a href="https://github.com/goodmeta/agent-payments-landscape">Protocol Comparison</a> ·
        <a href="https://linkedin.com/in/tsangeric">Agent Payments Weekly</a>
      </p>
    </div>
  </div>
</body>
</html>`;
      return c.html(html);
    });

    serve({ fetch: app.fetch, port: PORT });
    console.error(`Intelligence MCP server running on http://localhost:${PORT}/mcp`);
  } else {
    // Stdio transport (local testing)
    const server = createServer(payments);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Intelligence MCP server running (stdio)");
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
