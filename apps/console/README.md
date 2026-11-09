# Console (moved)

The console is served by the firewall API itself at `/console` (no separate app to deploy): see [apps/firewall-api/console](../firewall-api/console) and `apps/firewall-api/src/console.ts`.

```bash
npm run console:demo        # API + console on http://127.0.0.1:8787/console, replays fixture purchases and attacks
```

The demo key is written to `data/console-demo.key` (gitignored); paste it into the page.
