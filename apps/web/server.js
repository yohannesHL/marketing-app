const http = require("http");
const next = require("next");

const port = Number.parseInt(process.env.PORT || "3000", 10);
const dev = process.env.NODE_ENV !== "production";
const app = next({ dev, dir: __dirname });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  http
    .createServer((req, res) => {
      return handle(req, res);
    })
    .listen(port, () => {
      // eslint-disable-next-line no-console
      console.log(`> Custom Next server ready on http://127.0.0.1:${port}`);
    });
});
