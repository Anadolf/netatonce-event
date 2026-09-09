const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const DATA_FILE = path.join(DATA_DIR, "raffle-data.json");
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "123456";
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const DATABASE_URL = process.env.DATABASE_URL || "";
const pool = DATABASE_URL ? new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3
}) : null;
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

function normalizeState(parsed) {
  const base = parsed && typeof parsed === "object" ? parsed : defaultState();
  const prizes = Array.isArray(base.prizes) && base.prizes.length ? base.prizes : defaultState().prizes;
  return {
    registrations: Array.isArray(base.registrations) ? base.registrations : [],
    prizes: prizes.map(prize => ({
      id: prize.id || crypto.randomUUID(),
      name: clean(prize.name || "Pris", 180),
      productText: clean(prize.productText, 1000),
      sponsorName: clean(prize.sponsorName, 180),
      winnerId: prize.winnerId || ""
    })),
    publicUrl: typeof base.publicUrl === "string" ? base.publicUrl : ""
  };
}

async function ensureDatabase() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS raffle_state (
      id text PRIMARY KEY,
      data jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(
    `INSERT INTO raffle_state (id, data)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    ["main", JSON.stringify(defaultState())]
  );
}

function ensureDataFile() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) writeState(defaultState());
}

async function readState() {
  if (pool) {
    const result = await pool.query("SELECT data FROM raffle_state WHERE id = $1", ["main"]);
    return normalizeState(result.rows[0]?.data);
  }
  ensureDataFile();
  const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  return normalizeState(parsed);
}

async function writeState(state) {
  const normalized = normalizeState(state);
  if (pool) {
    await pool.query(
      `UPDATE raffle_state SET data = $2::jsonb, updated_at = now() WHERE id = $1`,
      ["main", JSON.stringify(normalized)]
    );
    return normalized;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(normalized, null, 2));
  return normalized;
}

async function updateState(mutator) {
  if (!pool) {
    const state = await readState();
    const result = await mutator(state);
    await writeState(state);
    return result ?? state;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query("SELECT data FROM raffle_state WHERE id = $1 FOR UPDATE", ["main"]);
    const state = normalizeState(result.rows[0]?.data);
    const mutatorResult = await mutator(state);
    await client.query(
      `UPDATE raffle_state SET data = $2::jsonb, updated_at = now() WHERE id = $1`,
      ["main", JSON.stringify(normalizeState(state))]
    );
    await client.query("COMMIT");
    return mutatorResult ?? state;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
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
      const state = await readState();
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
      const result = await updateState(state => {
        const firstName = clean(body.firstName, 100);
        const lastName = clean(body.lastName, 100);
        const requestedName = normalizeIdentity(`${firstName} ${lastName}`);
        const duplicate = state.registrations.find(reg =>
          String(reg.email).toLowerCase() === email ||
          normalizeIdentity(`${reg.firstName} ${reg.lastName}`) === requestedName
        );
        if (duplicate) {
          return { duplicate: true };
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
        return { duplicate: false, count: state.registrations.length };
      });
      if (result.duplicate) {
        return json(res, 409, { error: "Du är redan anmäld och kan inte delta mer än 1 gång." });
      }
      return json(res, 201, { ok: true, count: result.count });
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
      return json(res, 200, await readState());
    }

    if (req.method === "PATCH" && pathname === "/api/admin/public-url") {
      const body = await readBody(req);
      const state = await updateState(state => {
        state.publicUrl = clean(body.publicUrl, 500);
      });
      return json(res, 200, state);
    }

    if (req.method === "POST" && pathname === "/api/admin/prizes") {
      const body = await readBody(req);
      const name = clean(body.name, 180);
      if (!name) return json(res, 400, { error: "Skriv namnet på priset." });
      const state = await updateState(state => {
        state.prizes.push({
          id: crypto.randomUUID(),
          name,
          productText: clean(body.productText, 1000),
          sponsorName: clean(body.sponsorName, 180),
          winnerId: ""
        });
      });
      return json(res, 201, state);
    }

    const prizeMatch = pathname.match(/^\/api\/admin\/prizes\/([^/]+)$/);
    if (prizeMatch && req.method === "PATCH") {
      const body = await readBody(req);
      let found = false;
      const state = await updateState(state => {
        const prize = state.prizes.find(item => item.id === prizeMatch[1]);
        if (!prize) return;
        found = true;
        prize.name = clean(body.name, 180) || prize.name;
        prize.productText = clean(body.productText, 1000);
        prize.sponsorName = clean(body.sponsorName, 180);
      });
      if (!found) return json(res, 404, { error: "Priset finns inte." });
      return json(res, 200, state);
    }
    if (prizeMatch && req.method === "DELETE") {
      const state = await updateState(state => {
        state.prizes = state.prizes.filter(item => item.id !== prizeMatch[1]);
      });
      return json(res, 200, state);
    }

    if (req.method === "POST" && pathname === "/api/admin/reset-draw") {
      const state = await updateState(state => {
        state.prizes.forEach(prize => prize.winnerId = "");
      });
      return json(res, 200, state);
    }

    if (req.method === "DELETE" && pathname === "/api/admin/registrations") {
      const state = await updateState(state => {
        state.registrations = [];
        state.prizes.forEach(prize => prize.winnerId = "");
      });
      return json(res, 200, state);
    }

    if (req.method === "POST" && pathname === "/api/admin/draw") {
      const body = await readBody(req);
      let drawResult = null;
      await updateState(state => {
        const prize = state.prizes.find(item => item.id === body.prizeId && !item.winnerId);
        if (!prize) {
          drawResult = { status: 404 };
          return;
        }
        const used = new Set(state.prizes.map(item => item.winnerId).filter(Boolean));
        const candidates = state.registrations.filter(reg => !used.has(reg.id));
        if (!candidates.length) {
          drawResult = { status: 409 };
          return;
        }
        const winner = candidates[crypto.randomInt(candidates.length)];
        prize.winnerId = winner.id;
        drawResult = { status: 200, state, prize, winner };
      });
      if (drawResult?.status === 404) return json(res, 404, { error: "Priset finns inte eller är redan draget." });
      if (drawResult?.status === 409) return json(res, 409, { error: "Det finns inga deltagare kvar att dra." });
      return json(res, 200, drawResult);
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

async function start() {
  if (process.env.RENDER && !pool) {
    throw new Error("DATABASE_URL must be configured in Render so raffle data is persisted.");
  }
  if (pool) await ensureDatabase();
  else ensureDataFile();
  server.listen(PORT, () => {
    console.log(`Net at Once event app listening on ${PORT}`);
  });
}

start().catch(error => {
  console.error(error);
  process.exit(1);
});
