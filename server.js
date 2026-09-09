const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const DATA_FILE = path.join(DATA_DIR, "raffle-data.json");
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "123456";
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const sessions = new Set();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8"
};

function defaultState() {
  return {
    registrations: [],
    prizes: [
      { id: crypto.randomUUID(), name: "Pris 1", productText: "", sponsorName: "", winnerId: "" },
      { id: crypto.randomUUID(), name: "Pris 2", productText: "", sponsorName: "", winnerId: "" }
    ],
    publicUrl: ""
  };
}

function ensureDataFile() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) writeState(defaultState());
}

function readState() {
  ensureDataFile();
  const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  const prizes = Array.isArray(parsed.prizes) && parsed.prizes.length ? parsed.prizes : defaultState().prizes;
  return {
    registrations: Array.isArray(parsed.registrations) ? parsed.registrations : [],
    prizes: prizes.map(prize => ({
      id: prize.id || crypto.randomUUID(),
      name: clean(prize.name || "Pris", 180),
      productText: clean(prize.productText, 1000),
      sponsorName: clean(prize.sponsorName, 180),
      winnerId: prize.winnerId || ""
    })),
    publicUrl: typeof parsed.publicUrl === "string" ? parsed.publicUrl : ""
  };
}

function writeState(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
}

function send(res, status, body, contentType = "application/json; charset=utf-8", headers = {}) {
  res.writeHead(status, { "Content-Type": contentType, "Cache-Control": "no-store", ...headers });
  res.end(body);
}

function json(res, status, data, headers) {
  send(res, status, JSON.stringify(data), "application/json; charset=utf-8", headers);
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").filter(Boolean).map(part => {
    const index = part.indexOf("=");
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1))];
  }));
}

function isAdmin(req) {
  const token = parseCookies(req).raffle_session;
  return Boolean(token && sessions.has(token));
}

function requireAdmin(req, res) {
  if (isAdmin(req)) return true;
  json(res, 401, { error: "Du behöver logga in som admin." });
  return false;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body is too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function clean(value, max = 500) {
  return String(value || "").trim().slice(0, max);
}

function normalizeIdentity(value) {
  return clean(value, 300).toLowerCase().replace(/\s+/g, " ");
}

function publicOrigin(req) {
  const proto = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

function serveFile(req, res, requestedPath) {
  const safePath = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const file = path.join(ROOT, safePath);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    send(res, 404, "Not found", "text/plain; charset=utf-8");
    return;
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

async function handleApi(req, res, pathname) {
  try {
    if (req.method === "GET" && pathname === "/api/public-state") {
      const state = readState();
      return json(res, 200, {
        count: state.registrations.length,
        prizes: state.prizes.map(prize => ({
          id: prize.id,
          name: prize.name,
          productText: prize.productText || "",
          sponsorName: prize.sponsorName || ""
        })),
        publicUrl: state.publicUrl || `${publicOrigin(req)}/raffle`
      });
    }

    if (req.method === "POST" && pathname === "/api/register") {
      const body = await readBody(req);
      const email = clean(body.email, 200).toLowerCase();
      if (!clean(body.organization) || !clean(body.firstName) || !clean(body.lastName) || !email) {
        return json(res, 400, { error: "Fyll i organisation, namn och mailadress." });
      }
      const state = readState();
      const firstName = clean(body.firstName, 100);
      const lastName = clean(body.lastName, 100);
      const requestedName = normalizeIdentity(`${firstName} ${lastName}`);
      const duplicate = state.registrations.find(reg =>
        String(reg.email).toLowerCase() === email ||
        normalizeIdentity(`${reg.firstName} ${reg.lastName}`) === requestedName
      );
      if (duplicate) {
        return json(res, 409, { error: "Du är redan anmäld och kan inte delta mer än 1 gång." });
      }
      state.registrations.push({
        id: crypto.randomUUID(),
        organization: clean(body.organization, 160),
        firstName,
        lastName,
        email,
        founded: clean(body.founded, 40),
        expectations: clean(body.expectations, 1000),
        contactConsent: clean(body.contactConsent, 160),
        createdAt: new Date().toISOString()
      });
      writeState(state);
      return json(res, 201, { ok: true, count: state.registrations.length });
    }

    if (req.method === "POST" && pathname === "/api/login") {
      const body = await readBody(req);
      if (body.username !== ADMIN_USERNAME || body.password !== ADMIN_PASSWORD) {
        return json(res, 401, { error: "Fel användarnamn eller lösenord." });
      }
      const token = crypto.createHmac("sha256", SESSION_SECRET).update(crypto.randomUUID()).digest("hex");
      sessions.add(token);
      return json(res, 200, { ok: true }, {
        "Set-Cookie": `raffle_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`
      });
    }

    if (req.method === "POST" && pathname === "/api/logout") {
      const token = parseCookies(req).raffle_session;
      if (token) sessions.delete(token);
      return json(res, 200, { ok: true }, {
        "Set-Cookie": "raffle_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
      });
    }

    if (pathname.startsWith("/api/admin") && !requireAdmin(req, res)) return;

    if (req.method === "GET" && pathname === "/api/admin/state") {
      return json(res, 200, readState());
    }

    if (req.method === "PATCH" && pathname === "/api/admin/public-url") {
      const body = await readBody(req);
      const state = readState();
      state.publicUrl = clean(body.publicUrl, 500);
      writeState(state);
      return json(res, 200, state);
    }

    if (req.method === "POST" && pathname === "/api/admin/prizes") {
      const body = await readBody(req);
      const state = readState();
      const name = clean(body.name, 180);
      if (!name) return json(res, 400, { error: "Skriv namnet på priset." });
      state.prizes.push({
        id: crypto.randomUUID(),
        name,
        productText: clean(body.productText, 1000),
        sponsorName: clean(body.sponsorName, 180),
        winnerId: ""
      });
      writeState(state);
      return json(res, 201, state);
    }

    const prizeMatch = pathname.match(/^\/api\/admin\/prizes\/([^/]+)$/);
    if (prizeMatch && req.method === "PATCH") {
      const body = await readBody(req);
      const state = readState();
      const prize = state.prizes.find(item => item.id === prizeMatch[1]);
      if (!prize) return json(res, 404, { error: "Priset finns inte." });
      prize.name = clean(body.name, 180) || prize.name;
      prize.productText = clean(body.productText, 1000);
      prize.sponsorName = clean(body.sponsorName, 180);
      writeState(state);
      return json(res, 200, state);
    }
    if (prizeMatch && req.method === "DELETE") {
      const state = readState();
      state.prizes = state.prizes.filter(item => item.id !== prizeMatch[1]);
      writeState(state);
      return json(res, 200, state);
    }

    if (req.method === "POST" && pathname === "/api/admin/reset-draw") {
      const state = readState();
      state.prizes.forEach(prize => prize.winnerId = "");
      writeState(state);
      return json(res, 200, state);
    }

    if (req.method === "DELETE" && pathname === "/api/admin/registrations") {
      const state = readState();
      state.registrations = [];
      state.prizes.forEach(prize => prize.winnerId = "");
      writeState(state);
      return json(res, 200, state);
    }

    if (req.method === "POST" && pathname === "/api/admin/draw") {
      const body = await readBody(req);
      const state = readState();
      const prize = state.prizes.find(item => item.id === body.prizeId && !item.winnerId);
      if (!prize) return json(res, 404, { error: "Priset finns inte eller är redan draget." });
      const used = new Set(state.prizes.map(item => item.winnerId).filter(Boolean));
      const candidates = state.registrations.filter(reg => !used.has(reg.id));
      if (!candidates.length) return json(res, 409, { error: "Det finns inga deltagare kvar att dra." });
      const winner = candidates[crypto.randomInt(candidates.length)];
      prize.winnerId = winner.id;
      writeState(state);
      return json(res, 200, { state, prize, winner });
    }

    json(res, 404, { error: "API-routen finns inte." });
  } catch (error) {
    json(res, 500, { error: error.message || "Serverfel." });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname.startsWith("/api/")) {
    handleApi(req, res, pathname);
    return;
  }

  if (pathname === "/health") return json(res, 200, { ok: true });
  if (pathname === "/" || pathname === "/index.html") return serveFile(req, res, "index.html");
  if (pathname === "/raffle" || pathname === "/raffle/" || pathname === "/raffle/admin" || pathname === "/raffle/draw") {
    return serveFile(req, res, "raffle.html");
  }

  serveFile(req, res, pathname.slice(1));
});

server.listen(PORT, () => {
  ensureDataFile();
  console.log(`Net at Once event app listening on ${PORT}`);
});
