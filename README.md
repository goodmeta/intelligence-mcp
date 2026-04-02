# Intelligence MCP Server

MCP server that gives AI agents access to agent payments ecosystem intelligence. Scans GitHub, Hacker News, and npm for signals, classifies and scores them, and returns actionable opportunities.

## Tools

| Tool | What it does |
|------|-------------|
| `scan_opportunities` | Scan ecosystem for new repos, issues, packages, and discussions. Returns scored and classified opportunities. |
| `get_protocol_info` | Get details on AP2, ACP, x402, MPP, or UCP. |
| `compare_protocols` | Full comparison matrix across all five protocols. |

## Install

```bash
git clone https://github.com/goodmeta/intelligence-mcp.git
cd intelligence-mcp
npm install
cp .env.example .env  # add your keys
npm run build
```

## Usage with Claude Code

Add to your Claude Code MCP config:

```json
{
  "mcpServers": {
    "intelligence": {
      "command": "node",
      "args": ["/path/to/intelligence-mcp/dist/index.js"],
      "env": {
        "GITHUB_PAT": "ghp_...",
        "ANTHROPIC_API_KEY": "sk-ant-..."
      }
    }
  }
}
```

Then ask Claude: "Scan for agent payment opportunities from the last 7 days"

## Example

```
> scan_opportunities(days=7, min_score=12)

Found 23 opportunities (99 signals scanned):

[19/20] [contribution] paygraph-ai/paygraph: Policy engine needs cross-gateway budget tracking
  Action: File issue about cross-wallet coordination gap
  Why: Building agent wallet with spend controls but no cross-gateway budget
  https://github.com/paygraph-ai/paygraph

[18/20] [prospect] sentinelx402: Looking for x402 beta testers
  Action: Offer to test with agent-verifier integration
  ...
```

## Data Sources

- GitHub: new repos in tracked orgs + keyword search across all of GitHub
- Hacker News: stories matching agent payment keywords (via Algolia API)
- npm: new packages matching protocol keywords

## Built by

[Eric Tsang](https://linkedin.com/in/tsangeric) / [Good Meta](https://goodmeta.co)

Part of the [Agent Payments Landscape](https://github.com/goodmeta/agent-payments-landscape) project.
