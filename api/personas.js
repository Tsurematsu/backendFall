import { MongoClient, ObjectId } from 'mongodb';

// ─── CONFIGURACIÓN DE BASE DE DATOS ──────────────────────────────────────────
//
//  Agrega esta variable en:
//  · Local:  archivo .env.local
//  · Vercel: Settings → Environment Variables
//
//  MONGODB_URI=mongodb://atlas-sql-69135898220f000c4f972a52-zvfuz.a.query.mongodb.net/testDB?ssl=true&authSource=admin
//
const DB_NAME         = 'testDB';
const COLLECTION_NAME = 'personas';
//
// ─────────────────────────────────────────────────────────────────────────────

const uri = "mongodb+srv://daniel20802_db_user:N7DzSYT9b7nockxx@cluster0.8lrfr0o.mongodb.net/testDB?retryWrites=true&w=majority&appName=Cluster0";
if (!uri) throw new Error('Falta MONGODB_URI en las variables de entorno');

let clientPromise;
if (process.env.NODE_ENV === 'development') {
  if (!global._mongoClientPromise) {
    global._mongoClientPromise = new MongoClient(uri).connect();
  }
  clientPromise = global._mongoClientPromise;
} else {
  clientPromise = new MongoClient(uri).connect();
}

// ─── CORS ─────────────────────────────────────────────────────────────────────

function handleCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

/**
 * Asigna medalla según posición
 * @param {number} pos
 * @returns {string}
 */
function getMedal(pos) {
  if (pos === 1) return 'gold';
  if (pos === 2) return 'silver';
  if (pos === 3) return 'bronze';
  return '';
}

/**
 * Convierte documento MongoDB → LeaderboardRow
 * @typedef {{ pos: number, nombre: string, carrera: string, edad: number, total: number, medal: string }} LeaderboardRow
 * @param {object} doc
 * @param {number} pos
 * @returns {LeaderboardRow}
 */
function toLeaderboardRow(doc, pos) {
  return {
    pos,
    nombre:  doc.nombre,
    carrera: doc.carrera,
    edad:    doc.edad,
    total:   doc.total,
    medal:   getMedal(pos),
  };
}

// ─── HANDLER PRINCIPAL ────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  const client     = await clientPromise;
  const collection = client.db(DB_NAME).collection(COLLECTION_NAME);

  const { url, method, body } = req;

  const match = url.replace(/\?.*$/, '').match(/\/api\/personas\/?([^/]*)?\/?([^/]*)?$/);
  const id  = match?.[1] || null;
  const sub = match?.[2] || null;

  // ── GET /api/personas ──────────────────────────────────────────────────────
  if (method === 'GET' && !id) {
    try {
      const docs        = await collection.find({}).sort({ total: -1 }).toArray();
      const leaderboard = docs.map((doc, i) => toLeaderboardRow(doc, i + 1));
      return res.status(200).json({ success: true, data: leaderboard });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  // ── GET /api/personas/:id ──────────────────────────────────────────────────
  if (method === 'GET' && id) {
    if (!ObjectId.isValid(id)) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
      const persona = await collection.findOne({ _id: new ObjectId(id) });
      if (!persona) return res.status(404).json({ success: false, error: 'Persona no encontrada' });
      const pos = (await collection.countDocuments({ total: { $gt: persona.total } })) + 1;
      return res.status(200).json({ success: true, data: toLeaderboardRow(persona, pos) });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  // ── POST /api/personas ─────────────────────────────────────────────────────
  if (method === 'POST' && !id) {
    const { nombre, edad, carrera } = body || {};
    if (!nombre || !edad || !carrera) {
      return res.status(400).json({ success: false, error: 'nombre, edad y carrera son requeridos' });
    }
    try {
      const updated = await collection.findOneAndUpdate(
        { nombre },
        {
          $inc: { total: 1 },
          $setOnInsert: { edad: Number(edad), carrera, creadoEn: new Date() },
        },
        { upsert: true, returnDocument: 'after' }
      );
      const pos = (await collection.countDocuments({ total: { $gt: updated.total } })) + 1;
      return res.status(200).json({ success: true, data: toLeaderboardRow(updated, pos) });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  // ── PUT /api/personas/:id ──────────────────────────────────────────────────
  if (method === 'PUT' && id && !sub) {
    if (!ObjectId.isValid(id)) return res.status(400).json({ success: false, error: 'ID inválido' });
    const { nombre, edad, carrera, total } = body || {};
    const update = {};
    if (nombre  !== undefined) update.nombre  = nombre;
    if (edad    !== undefined) update.edad    = Number(edad);
    if (carrera !== undefined) update.carrera = carrera;
    if (total   !== undefined) update.total   = Number(total);
    if (Object.keys(update).length === 0) {
      return res.status(400).json({ success: false, error: 'No se enviaron campos para actualizar' });
    }
    update.actualizadoEn = new Date();
    try {
      const updated = await collection.findOneAndUpdate(
        { _id: new ObjectId(id) },
        { $set: update },
        { returnDocument: 'after' }
      );
      if (!updated) return res.status(404).json({ success: false, error: 'Persona no encontrada' });
      const pos = (await collection.countDocuments({ total: { $gt: updated.total } })) + 1;
      return res.status(200).json({ success: true, data: toLeaderboardRow(updated, pos) });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  // ── PUT /api/personas/:id/total ────────────────────────────────────────────
  if (method === 'PUT' && id && sub === 'total') {
    if (!ObjectId.isValid(id)) return res.status(400).json({ success: false, error: 'ID inválido' });
    const { accion } = body || {};
    if (!['incrementar', 'decrementar'].includes(accion)) {
      return res.status(400).json({ success: false, error: 'accion debe ser "incrementar" o "decrementar"' });
    }
    try {
      const updated = await collection.findOneAndUpdate(
        { _id: new ObjectId(id) },
        {
          $inc: { total: accion === 'incrementar' ? 1 : -1 },
          $set: { actualizadoEn: new Date() },
        },
        { returnDocument: 'after' }
      );
      if (!updated) return res.status(404).json({ success: false, error: 'Persona no encontrada' });
      const pos = (await collection.countDocuments({ total: { $gt: updated.total } })) + 1;
      return res.status(200).json({ success: true, data: toLeaderboardRow(updated, pos) });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  return res.status(405).json({ success: false, error: 'Ruta no encontrada' });
}