// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mysql = require("mysql2/promise");
const { randomUUID } = require("crypto");

const app = express();

/* ===== CORS ===== */
app.use(cors({
  origin: true,
  methods: ["GET", "POST", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
  optionsSuccessStatus: 204
}));

/* ===== Body parser ===== */
app.use(express.json({ limit: "1mb" }));

/* ===== MySQL pool Railwway ===== */
const pool = mysql.createPool({
  host: process.env.MYSQLHOST,
  user: process.env.MYSQLUSER,
  password: process.env.MYSQLPASSWORD,
  database: process.env.MYSQLDATABASE,
  port: process.env.MYSQLPORT,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Healthcheck DB
(async () => {
  try {
    const c = await pool.getConnection(); await c.ping(); c.release();
    console.log("✅ Connecté à MySQL !");
  } catch (e) {
    console.error("❌ Connexion MySQL échouée:", e.message);
    process.exit(1);
  }
})();

app.get("/ping", (req, res) => res.json({ ok: true }));

/* ===== POST /confirmCommande =====
   Reçoit:
   {
     table_numero: "12",
     items: [{ plat_id, plat_nom, quantite, prix_unitaire, prix_total, accompagnements, commentaire }]
   }
*/
app.post("/confirmCommande", async (req, res) => {
  try {
    const { table_numero, items } = req.body || {};
    if (!table_numero || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: "Paramètres invalides" });
    }

    const commandeId = randomUUID();
    const now = new Date(); // JS Date → MySQL DATETIME
    const createdAt = new Date(now.getTime() - now.getTimezoneOffset()*60000).toISOString().slice(0, 19).replace('T',' ');

    const rows = items.map(it => ([
      commandeId,
      String(table_numero),
      it.plat_id ?? null,
      it.plat_nom ?? null,
      Number(it.quantite) || 0,
      Number(it.prix_unitaire) || 0,
      Number(it.prix_total) || 0,
      it.accompagnements ?? "",
      it.commentaire ?? "",
      "RECEIVED",
      createdAt
    ]));

    const placeholders = rows.map(() => "(?,?,?,?,?,?,?,?,?,?,?)").join(",");
    const sql = `
      INSERT INTO commandes
      (commande_id, table_numero, plat_id, plat_nom, quantite, prix_unitaire, prix_total, accompagnements, commentaire, statut, created_at)
      VALUES ${placeholders}
    `;
    const flat = rows.flat();
    const [result] = await pool.execute(sql, flat);

    console.log(`✅ Commande ${commandeId} insérée (${result.affectedRows} lignes)`);
    return res.status(200).json({ success: true, commande_id: commandeId, inserted: result.affectedRows });
  } catch (err) {
    console.error("❌ Erreur /confirmCommande :", err);
    return res.status(500).json({ success: false, error: "Erreur serveur" });
  }
});

/* ===== GET /commandes =====
   Query params:
     - status: RECEIVED|PREPARING|COMPLETED|OUT_OF_STOCK (optionnel, sinon toutes)
     - since: timestamp ms (optionnel, filtre sur created_at)
     - limit: nombre max (optionnel, par défaut 200)
   Réponse: [{ id, table, createdAt, status, messageToClient, items:[{dish,qty,unit,total,accomp[],comment}]}]
*/
app.get("/commandes", async (req, res) => {
  try {
    const { status, since, limit } = req.query;
    const lim = Math.min(Number(limit) || 200, 1000);

    const where = [];
    const params = [];

    if (status) {
      where.push("statut = ?");
      params.push(status);
    }
    if (since) {
      // since = timestamp ms → DATETIME
      const d = new Date(Number(since));
      const iso = new Date(d.getTime() - d.getTimezoneOffset()*60000).toISOString().slice(0,19).replace('T',' ');
      where.push("created_at >= ?");
      params.push(iso);
    }

    const sql = `
      SELECT id, commande_id, table_numero, plat_id, plat_nom, quantite, prix_unitaire, prix_total,
             accompagnements, commentaire, statut, created_at, message_client
      FROM commandes
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY created_at DESC, id ASC
      LIMIT ?
    `;
    params.push(lim);

    const [rows] = await pool.query(sql, params);

    // Agrégation par commande_id
    const map = new Map();
    for (const r of rows) {
      if (!map.has(r.commande_id)) {
        map.set(r.commande_id, {
          id: r.commande_id,
          table: r.table_numero,
          createdAt: new Date(r.created_at).getTime(),
          status: r.statut,
          messageToClient: r.message_client || "",
          items: []
        });
      }
      const o = map.get(r.commande_id);
      o.items.push({
        dish: r.plat_nom,
        qty: Number(r.quantite) || 0,
        unit: Number(r.prix_unitaire) || 0,
        total: Number(r.prix_total) || 0,
        accomp: (r.accompagnements ? String(r.accompagnements) : "").trim()
                  ? String(r.accompagnements).split(",").map(s => s.trim())
                  : (r.accompagnements ? [String(r.accompagnements)] : []),
        comment: r.commentaire || ""
      });
    }
    return res.json(Array.from(map.values()));
  } catch (err) {
    console.error("❌ Erreur /commandes :", err);
    return res.status(500).json({ success: false, error: "Erreur serveur" });
  }
});

/* ===== PATCH /commandes/:id/status =====
   Body JSON: { status: 'PREPARING'|'COMPLETED'|'OUT_OF_STOCK'|'RECEIVED', message?: string }
   Met à jour toutes les lignes de la commande (même commande_id)
*/
app.patch("/commandes/:id/status", async (req, res) => {
  try {
    const { id } = req.params; // commande_id
    const { status, message } = req.body || {};
    const ALLOWED = new Set(['RECEIVED','PREPARING','COMPLETED','OUT_OF_STOCK']);
    if (!ALLOWED.has(status)) return res.status(400).json({ success:false, error:"Statut invalide" });

    const sql = `UPDATE commandes SET statut = ?, message_client = ? WHERE commande_id = ?`;
    const [result] = await pool.execute(sql, [status, message || null, id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ success:false, error:"Commande introuvable" });
    }
    return res.json({ success:true, updated: result.affectedRows });
  } catch (err) {
    console.error("❌ Erreur PATCH /commandes/:id/status :", err);
    return res.status(500).json({ success:false, error:"Erreur serveur" });
  }
});

/* ===== GET /order-status =====
   Permet au MENU (client) de récupérer la dernière commande et son message pour une table.
   Query: ?table=12
   Réponse: { commande_id, status, message, createdAt } ou {empty:true}
*/
app.get("/order-status", async (req, res) => {
  try {
    const { table } = req.query;
    if (!table) return res.status(400).json({ success:false, error:"table manquante" });

    const sql = `
      SELECT commande_id, statut, message_client, MAX(created_at) AS created_at
      FROM commandes
      WHERE table_numero = ?
      GROUP BY commande_id, statut, message_client
      ORDER BY created_at DESC
      LIMIT 1
    `;
    const [rows] = await pool.query(sql, [String(table)]);
    if (!rows.length) return res.json({ empty: true });

    const r = rows[0];
    return res.json({
      commande_id: r.commande_id,
      status: r.statut,
      message: r.message_client || "",
      createdAt: new Date(r.created_at).getTime()
    });
  } catch (err) {
    console.error("❌ Erreur /order-status :", err);
    return res.status(500).json({ success:false, error:"Erreur serveur" });
  }
});

/* ===== Start ===== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Serveur Node.js lancé sur http://0.0.0.0:${PORT}`);
});
