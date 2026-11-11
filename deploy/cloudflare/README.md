# Deploying the public demo on Cloudflare

The demo is one container (built from the repo's [Dockerfile](../../Dockerfile)) running the MWF firewall API, FreshCart, Errand and the [Playground](../../examples/playground) page. A small Worker ([src/index.js](src/index.js)) sends every request to that container. Everyone shares one container, so visitors see the same shop, queue and console.

| Piece | Where |
|---|---|
| Public URL | `https://mwf-demo.<your-subdomain>.workers.dev` (the Worker) |
| Container | `standard-1` (½ vCPU, 4 GiB RAM), no Internet access, sleeps after 30 idle minutes |
| Data | Inside the container, reset whenever it sleeps or is redeployed. The console shows runs since it last woke up |
| Secrets | None needed. The demo's MWF keys are created inside the container at startup and never leave it |

## One-time setup (a person does this, in the browser)

1. **Account.** One of you creates the Cloudflare account and switches on the **Workers Paid** plan ($5/month; Containers need it). To share it, invite the other person under **Manage Account → Members**. Don't share one login.
2. **Create the Worker from GitHub.** Go to **Workers & Pages → Create → Import a repository**. Pick this repository and set:
   - **Root directory:** `deploy/cloudflare`
   - **Build command:** `npm ci`
   - **Deploy command:** `npx wrangler deploy`
   - **Production branch:** `main`
3. Save and deploy. Cloudflare builds the image itself (about 10 minutes the first time), so nobody needs Docker. The first deploy also takes a few minutes to provision the container.

After that, every push to `main` redeploys automatically.

## Checking it

- Open the Worker URL. The Playground shows "Starting…" for one to two minutes after the container wakes, then "Ready".
- Run **Hidden text** with the firewall off, then on. Off ends with ATTACK SUCCEEDED, on with HELD BY FIREWALL.
- Open **Firewall console ↗**. It shows the decisions behind those runs, without asking for a key.
- Build and runtime logs: the Worker's **Builds** and **Logs** tabs in the dashboard, or `npx wrangler containers list`.

## Deploying from a laptop instead

This needs Docker (or another Docker-compatible engine) running, and a Cloudflare login (`npx wrangler login`):

```bash
cd deploy/cloudflare
npm ci
npx wrangler deploy
```

## Running the same image elsewhere

Any Docker host works (Fly.io, Railway, a VM). Give it about 2 GB of RAM and expose port 8080:

```bash
docker build -t mwf-demo .
docker run -p 8080:8080 mwf-demo
```
