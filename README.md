# Framing Lab

Static build of the data visualization teaching tool. Two stocks, four framing dials, headline critique, live news.

## Put it on GitHub Pages

1. Create a repo (for example `stock_viz`) and add `index.html` to the root.
2. Settings > Pages > Source: Deploy from a branch, branch `main`, folder `/ (root)`.
3. The page lives at `https://unnatinarang.github.io/stock_viz/`.

Everything except the two AI buttons works right away.

## Turn on the AI buttons for a class

The page cannot hold your API key safely, so a small proxy does:

1. In Cloudflare, create a Worker and paste in `worker.js`.
2. Add a secret `ANTHROPIC_API_KEY` in the Worker settings.
3. Copy the Worker URL and set it in `index.html`:
   `window.FRAMING_LAB_PROXY_URL = "https://framing-lab.YOURNAME.workers.dev";`
4. Commit. Students can now use critique and news with no key.

Set `ALLOWED_ORIGIN` in `worker.js` to your Pages URL so only your page can use the proxy.

## Testing without a proxy

Leave the proxy URL empty and paste a key into the box at the bottom of the page. It stays in the tab and is not stored.

## Rebuilding after edits

Source is `App.jsx`. `npm install` then:
`npx esbuild main.jsx --bundle --minify --format=iife --loader:.jsx=jsx --jsx=automatic --outfile=bundle.js`
and paste the bundle back into `index.html`.
