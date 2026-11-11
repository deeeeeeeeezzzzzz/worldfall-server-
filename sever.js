
"use strict";

const http = require("http");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;

const MAPS = [
  "forest", "desert", "arctic",
  "city", "tropical", "volcanic"
];

const biome = MAPS[Math.floor(Math.random() * MAPS.length)];
const seed = Math.floor(Math.random() * 2147483646) + 1;

const players = new Map();

const guns = [
  { damage: 22, delay: 110, range: 150, pellets: 1, spread: .012 },
  { damage: 17, delay: 650, range: 45, pellets: 8, spread: .075 },
  { damage: 150, delay: 1100, range: 300, pellets: 1, spread: 0 },
  { damage: 13, delay: 65, range: 95, pellets: 1, spread: .026 },
  { damage: 130, delay: 900, range: 250, pellets: 1, spread: 0 }
];

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const valid = v => typeof v === "number" && Number.isFinite(v);

const server = http.createServer((req, res) => {
  res.writeHead(200, {
    "content-type": "text/plain",
    "access-control-allow-origin": "*"
  });

  res.end(
    "WORLDFALL online server running; players: " + players.size
  );
});

const io = new Server(server, {
  cors: { origin: true, methods: ["GET", "POST"] },
  maxHttpBufferSize: 1e5
});

const snap = p => ({
  id: p.id,
  x: p.x,
  y: p.y,
  z: p.z,
  yaw: p.yaw,
  pitch: p.pitch,
  skin: p.skin,
  gun: p.gun,
  hp: p.hp,
  kills: p.kills
});

function spawn() {
  return {
    x: (Math.random() - .5) * 30,
    y: 2,
    z: (Math.random() - .5) * 30
  };
}

function respawn(p) {
  Object.assign(p, spawn(), {
    hp: 100,
    invulnerableUntil: Date.now() + 2000
  });

  io.emit("wf:respawn", snap(p));
}

io.on("connection", socket => {

  socket.on("wf:join", data => {
    if (players.has(socket.id)) return;

    if (players.size >= 16) {
      socket.emit("wf:error", "Public match full (16 players).");
      return;
    }

    const pos = spawn();

    const p = {
      id: socket.id,
      ...pos,
      yaw: 0,
      pitch: 0,
      skin: clamp(Math.trunc(Number(data?.skin) || 0), 0, 26),
      gun: clamp(Math.trunc(Number(data?.gun) || 0), 0, 4),
      hp: 100,
      kills: 0,
      lastShot: 0,
      lastMove: Date.now(),
      invulnerableUntil: Date.now() + 2000
    };

    players.set(socket.id, p);

    socket.emit("wf:welcome", {
      id: socket.id,
      biome,
      seed,
      players: [...players.values()].map(snap)
    });

    socket.broadcast.emit("wf:joined", snap(p));
  });

  socket.on("wf:move", data => {
    const p = players.get(socket.id);
    if (!p || !data) return;

    const { x, y, z, yaw, pitch, gun } = data;

    if (![x, y, z, yaw, pitch].every(valid)) return;

    if (Math.abs(x) > 198 || Math.abs(z) > 198 || y < 1 || y > 55) {
      return;
    }

    const now = Date.now();
    const elapsed = clamp((now - p.lastMove) / 1000, .015, .25);
    const distance = Math.hypot(x - p.x, y - p.y, z - p.z);

    if (distance > Math.max(8, 35 * elapsed + 4)) return;

    Object.assign(p, {
      x,
      y,
      z,
      yaw: clamp(yaw, -1e6, 1e6),
      pitch: clamp(pitch, -1.6, 1.6),
      gun: clamp(Math.trunc(Number(gun) || 0), 0, 4),
      lastMove: now
    });
  });

  socket.on("wf:shoot", data => {
    const p = players.get(socket.id);
    if (!p || !data) return;

    const weapon = guns[p.gun];
    const now = Date.now();

    if (now - p.lastShot < weapon.delay - 20) return;
    p.lastShot = now;

    const dx = data.dx;
    const dy = data.dy;
    const dz = data.dz;

    if (![dx, dy, dz].every(valid)) return;

    const len = Math.hypot(dx, dy, dz);
    if (len < .9 || len > 1.1) return;

    const dir = {
      x: dx / len,
      y: dy / len,
      z: dz / len
    };

    io.emit("wf:shot", {
      id: p.id,
      x: p.x,
      y: p.y,
      z: p.z,
      dx: dir.x,
      dy: dir.y,
      dz: dir.z,
      gun: p.gun
    });

    for (const target of players.values()) {
      if (target.id === p.id || now < target.invulnerableUntil) {
        continue;
      }

      const tx = target.x - p.x;
      const ty = target.y - p.y;
      const tz = target.z - p.z;

      const along = tx * dir.x + ty * dir.y + tz * dir.z;

      if (along < 0 || along > weapon.range) continue;

      const miss = Math.hypot(
        tx - dir.x * along,
        ty - dir.y * along,
        tz - dir.z * along
      );

      const radius = p.gun === 1 ? 3.4 : p.gun === 4 ? 5 : 1.7;

      if (miss > radius) continue;

      const damage = p.gun === 1
        ? Math.round(weapon.damage * clamp(7 - miss * 1.4, 1, 7))
        : weapon.damage;

      target.hp = Math.max(0, target.hp - damage);

      io.to(target.id).emit("wf:health", {
        hp: target.hp,
        attacker: p.id
      });

      io.to(p.id).emit("wf:hit", { damage });

      if (target.hp === 0) {
        p.kills++;

        io.emit("wf:kill", {
          killer: p.id,
          victim: target.id,
          kills: p.kills
        });

        respawn(target);
      }
    }
  });

  socket.on("wf:leave", () => {
    if (players.delete(socket.id)) {
      io.emit("wf:left", socket.id);
    }
  });

  socket.on("disconnect", () => {
    if (players.delete(socket.id)) {
      io.emit("wf:left", socket.id);
    }
  });

});

setInterval(() => {
  io.emit("wf:state", [...players.values()].map(snap));
}, 50);

server.listen(PORT, "0.0.0.0", () => {
  console.log("WORLDFALL server listening on " + PORT);
});
