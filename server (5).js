import http from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = __dirname;
const dbPath = path.join(__dirname, "db.json");
const port = Number(process.env.PORT || 3333);
const adminPin = process.env.ADMIN_PIN || "1606";

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function json(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function cleanText(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 80);
}

function scoreValue(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 99) return null;
  return number;
}

function resultType(a, b) {
  if (a > b) return "home";
  if (b > a) return "away";
  return "draw";
}

function pointsFor(game, guess) {
  if (!guess) return 0;
  if (game.homeScore === null || game.awayScore === null) return 0;
  if (guess.homeScore === null || guess.awayScore === null) return 0;

  if (guess.homeScore === game.homeScore && guess.awayScore === game.awayScore) return 5;
  return 0;
}

async function readDb() {
  return JSON.parse(await readFile(dbPath, "utf8"));
}

async function saveDb(db) {
  await writeFile(dbPath, JSON.stringify(db, null, 2));
}

async function body(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function requireAdmin(req, res) {
  const pin = req.headers["x-admin-pin"];
  if (pin !== adminPin) {
    json(res, 401, { error: "PIN de admin invalido." });
    return false;
  }
  return true;
}

function publicGame(game) {
  return {
    id: game.id,
    date: game.date,
    home: game.home,
    away: game.away,
    homeScore: game.homeScore,
    awayScore: game.awayScore
  };
}

function rankingFor(db, date = "") {
  const games = db.games.filter((game) => !date || game.date === date);
  const gameIds = new Set(games.map((game) => game.id));
  const byName = new Map();

  for (const guess of db.guesses) {
    if (!gameIds.has(guess.gameId)) continue;
    if (!byName.has(guess.name)) {
      byName.set(guess.name, {
        name: guess.name,
        points: 0,
        exact: 0,
        correctResult: 0,
        guesses: 0
      });
    }

    const game = games.find((item) => item.id === guess.gameId);
    const pts = pointsFor(game, guess);
    const row = byName.get(guess.name);
    row.points += pts;
    row.guesses += 1;
    if (pts === 5) row.exact += 1;
    if (pts === 3) row.correctResult += 1;
  }

  return [...byName.values()].sort((a, b) => {
    return b.points - a.points || b.exact - a.exact || a.name.localeCompare(b.name);
  });
}

function guessesFor(db, date = "") {
  const games = db.games
    .filter((game) => !date || game.date === date)
    .sort((a, b) => a.id.localeCompare(b.id));
  const gameMap = new Map(games.map((game) => [game.id, game]));
  const byName = new Map();

  for (const guess of db.guesses) {
    const game = gameMap.get(guess.gameId);
    if (!game) continue;

    if (!byName.has(guess.name)) byName.set(guess.name, []);
    byName.get(guess.name).push({
      gameId: game.id,
      home: game.home,
      away: game.away,
      homeScore: guess.homeScore,
      awayScore: guess.awayScore,
      points: pointsFor(game, guess)
    });
  }

  return [...byName.entries()]
    .map(([name, guesses]) => ({ name, guesses }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function api(req, res, url) {
  if (url.pathname === "/api/state" && req.method === "GET") {
    const db = await readDb();
    const date = url.searchParams.get("date") || "";
    const games = db.games
      .filter((game) => !date || game.date === date)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(publicGame);

    return json(res, 200, {
      settings: db.settings,
      games,
      dates: [...new Set(db.games.map((game) => game.date))].sort(),
      ranking: db.settings.showRanking ? rankingFor(db, date) : null,
      guesses: db.settings.showRanking ? guessesFor(db, date) : null
    });
  }

  if (url.pathname === "/api/guess" && req.method === "POST") {
    const db = await readDb();
    const payload = await body(req);
    const date = cleanText(payload.date);
    const name = cleanText(payload.name);
    const guesses = Array.isArray(payload.guesses) ? payload.guesses : [];

    if (!date || !name) return json(res, 400, { error: "Informe nome e dia." });

    const validGames = new Map(
      db.games.filter((game) => game.date === date).map((game) => [game.id, game])
    );

    for (const item of guesses) {
      if (!validGames.has(item.gameId)) continue;
      const homeScore = scoreValue(item.homeScore);
      const awayScore = scoreValue(item.awayScore);
      if (homeScore === null || awayScore === null) continue;

      const existing = db.guesses.find((guess) => {
        return guess.date === date && guess.name.toLowerCase() === name.toLowerCase() && guess.gameId === item.gameId;
      });

      if (existing) {
        existing.name = name;
        existing.homeScore = homeScore;
        existing.awayScore = awayScore;
        existing.updatedAt = new Date().toISOString();
      } else {
        db.guesses.push({
          id: crypto.randomUUID(),
          date,
          name,
          gameId: item.gameId,
          homeScore,
          awayScore,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
      }
    }

    await saveDb(db);
    return json(res, 200, { ok: true });
  }

  if (url.pathname === "/api/admin/state" && req.method === "GET") {
    if (!requireAdmin(req, res)) return;
    const db = await readDb();
    return json(res, 200, {
      ...db,
      rankingToday: rankingFor(db, url.searchParams.get("date") || "")
    });
  }

  if (url.pathname === "/api/admin/game" && req.method === "POST") {
    if (!requireAdmin(req, res)) return;
    const db = await readDb();
    const payload = await body(req);
    const date = cleanText(payload.date);
    const home = cleanText(payload.home);
    const away = cleanText(payload.away);

    if (!date || !home || !away) return json(res, 400, { error: "Preencha dia e times." });

    db.games.push({
      id: crypto.randomUUID(),
      date,
      home,
      away,
      homeScore: null,
      awayScore: null
    });
    await saveDb(db);
    return json(res, 200, { ok: true });
  }

  if (url.pathname === "/api/admin/result" && req.method === "PATCH") {
    if (!requireAdmin(req, res)) return;
    const db = await readDb();
    const payload = await body(req);
    const game = db.games.find((item) => item.id === payload.gameId);
    if (!game) return json(res, 404, { error: "Jogo nao encontrado." });

    game.homeScore = scoreValue(payload.homeScore);
    game.awayScore = scoreValue(payload.awayScore);
    await saveDb(db);
    return json(res, 200, { ok: true });
  }

  if (url.pathname === "/api/admin/game" && req.method === "DELETE") {
    if (!requireAdmin(req, res)) return;
    const db = await readDb();
    const gameId = url.searchParams.get("id");
    db.games = db.games.filter((game) => game.id !== gameId);
    db.guesses = db.guesses.filter((guess) => guess.gameId !== gameId);
    await saveDb(db);
    return json(res, 200, { ok: true });
  }

  if (url.pathname === "/api/admin/settings" && req.method === "PATCH") {
    if (!requireAdmin(req, res)) return;
    const db = await readDb();
    const payload = await body(req);
    db.settings.showRanking = Boolean(payload.showRanking);
    await saveDb(db);
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: "Rota nao encontrada." });
}

async function serveStatic(req, res, url) {
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(publicDir, requested));

  if (!filePath.startsWith(publicDir) || !existsSync(filePath)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Nao encontrado");
    return;
  }

  const ext = path.extname(filePath);
  res.writeHead(200, { "content-type": mime[ext] || "application/octet-stream" });
  res.end(await readFile(filePath));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    return await serveStatic(req, res, url);
  } catch (error) {
    console.error(error);
    return json(res, 500, { error: "Erro interno." });
  }
});

server.listen(port, () => {
  console.log(`Bolao rodando em http://localhost:${port}`);
  console.log(`PIN admin: ${adminPin}`);
});
