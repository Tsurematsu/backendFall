import { Pool } from 'pg';
// Este e sun function para el entorno de vercel
// ─── VARIABLES DE ENTORNO REQUERIDAS ─────────────────────────────────────────
//
//  Agrega estas variables en:
//  · Local:  archivo .env.local
//  · Vercel: Settings → Environment Variables
//
//  Opción A — cadena de conexión única:
//    POSTGRES_URL=postgresql://usuario:contraseña@host:5432/nombre_db
//
//  Opción B — variables individuales (si no usas POSTGRES_URL):
//    POSTGRES_HOST=localhost
//    POSTGRES_PORT=5432
//    POSTGRES_DB=testDB
//    POSTGRES_USER=daniel_db_user
//    POSTGRES_PASSWORD=tu_contraseña_aqui
//    POSTGRES_SSL=true          ← pon "false" si es local sin SSL
//
//  ⚠ Nunca subas valores reales al repositorio. Usa siempre variables de entorno.
//
// ─────────────────────────────────────────────────────────────────────────────

// ─── CONTRASEÑA DE BORRADO ────────────────────────────────────────────────────
//  Cámbiala aquí o agrégala al .env como DELETE_PASSWORD=tu_clave_secreta
//  ⚠ Mover a variable de entorno antes de subir a producción.

const DELETE_PASSWORD = process.env.DELETE_PASSWORD || 'admin1234';

// ─── CONFIGURACIÓN EXPLÍCITA ──────────────────────────────────────────────────
//  Cambia estos valores o (mejor) usa las variables de entorno de arriba.

const DB_CONFIG = {
  connectionString: process.env.POSTGRES_URL, // tiene prioridad si existe
  host:     process.env.POSTGRES_HOST     || 'localhost',
  port:     Number(process.env.POSTGRES_PORT)  || 5432,
  database: process.env.POSTGRES_DB       || 'testDB',
  user:     process.env.POSTGRES_USER     || 'daniel_db_user',
  password: process.env.POSTGRES_PASSWORD || 'CAMBIA_ESTA_CONTRASEÑA',
  ssl:      process.env.POSTGRES_SSL === 'false'
              ? false
              : { rejectUnauthorized: false }, // true por defecto (Vercel/Neon/Supabase)
};

// ─── POOL DE CONEXIONES ───────────────────────────────────────────────────────

let pool;
function getPool() {
  if (!pool) {
    pool = new Pool(
      DB_CONFIG.connectionString
        ? { connectionString: DB_CONFIG.connectionString, ssl: DB_CONFIG.ssl }
        : DB_CONFIG
    );
  }
  return pool;
}

// ─── INICIALIZACIÓN DE TABLA ──────────────────────────────────────────────────
//  Se ejecuta en cada cold-start; si la tabla ya existe, no hace nada.

async function ensureTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS personas (
      id         SERIAL PRIMARY KEY,
      nombre     VARCHAR(255) NOT NULL UNIQUE,
      carrera    VARCHAR(255) NOT NULL,
      edad       INTEGER      NOT NULL,
      total      INTEGER      NOT NULL DEFAULT 0,
      razon      TEXT,
      creado_en  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      actualizado_en TIMESTAMPTZ
    );
  `);

  // Agrega la columna razon si la tabla ya existía sin ella (migración segura)
  await client.query(`
    ALTER TABLE personas ADD COLUMN IF NOT EXISTS razon TEXT;
  `);

  // Índice único funcional sobre LOWER(nombre) para evitar duplicados por
  // diferencias de mayúsculas/minúsculas que el UNIQUE estándar no detecta.
  // Si la tabla ya tiene filas con variantes del mismo nombre normalizadas,
  // este índice fallará hasta que se limpien manualmente esas filas.
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_personas_nombre_lower ON personas (LOWER(nombre));
  `);

  // Índice para ordenar por total rápidamente
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_personas_total ON personas (total DESC);
  `);
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

/**
 * Normaliza el nombre: elimina espacios extremos y convierte a minúsculas.
 * Es el determinante único para identificar a una persona en el sistema.
 */
function normalizarNombre(nombre) {
  return nombre.trim().toLowerCase();
}

function getMedal(pos) {
  if (pos === 1) return 'gold';
  if (pos === 2) return 'silver';
  if (pos === 3) return 'bronze';
  return '';
}

function toLeaderboardRow(row, pos) {
  return {
    pos,
    id:      row.id,
    nombre:  row.nombre,
    carrera: row.carrera,
    edad:    row.edad,
    total:   row.total,
    razon:   row.razon ?? null,
    medal:   getMedal(pos),
  };
}

// ─── CORS ─────────────────────────────────────────────────────────────────────

function handleCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}

// ─── HANDLER PRINCIPAL ────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  const client = await getPool().connect();

  try {
    // Garantiza que la tabla exista antes de cualquier operación
    await ensureTable(client);

    const { method, body } = req;
    const url = req.url.replace(/\?.*$/, '');

    const match = url.match(/\/api\/personas\/?([^/]*)?\/?([^/]*)?$/);
    const id  = match?.[1] || null;
    const sub = match?.[2] || null;

    // ── GET /api/personas ────────────────────────────────────────────────────
    if (method === 'GET' && !id) {
      const { rows } = await client.query(
        'SELECT * FROM personas ORDER BY total DESC'
      );
      const leaderboard = rows.map((row, i) => toLeaderboardRow(row, i + 1));
      return res.status(200).json({ success: true, data: leaderboard });
    }

    // ── GET /api/personas/:id ────────────────────────────────────────────────
    if (method === 'GET' && id) {
      const { rows } = await client.query(
        'SELECT * FROM personas WHERE id = $1',
        [id]
      );
      if (!rows.length) {
        return res.status(404).json({ success: false, error: 'Persona no encontrada' });
      }
      const persona = rows[0];
      const { rows: countRows } = await client.query(
        'SELECT COUNT(*) FROM personas WHERE total > $1',
        [persona.total]
      );
      const pos = Number(countRows[0].count) + 1;
      return res.status(200).json({ success: true, data: toLeaderboardRow(persona, pos) });
    }

    // ── POST /api/personas ───────────────────────────────────────────────────
    //  El nombre se normaliza (trim + lowercase) antes de cualquier operación.
    //  Si no existe se crea con total: 1; si ya existe solo incrementa el total.
    //  - edad y carrera se guardan únicamente en el insert inicial; se ignoran en conflicto.
    //  - razon se concatena al valor existente separado por ", " en cada llamada.
    if (method === 'POST' && !id) {
      const { nombre, edad, carrera, razon } = body || {};
      if (!nombre || !edad || !carrera) {
        return res.status(400).json({ success: false, error: 'nombre, edad y carrera son requeridos' });
      }

      const nombreNormalizado = normalizarNombre(nombre);

      const { rows } = await client.query(
        `INSERT INTO personas (nombre, edad, carrera, total, razon)
         VALUES ($1, $2, $3, 1, $4)
         ON CONFLICT (nombre) DO UPDATE
           SET total          = personas.total + 1,
               razon          = CASE
                                  WHEN $4 IS NULL       THEN personas.razon
                                  WHEN personas.razon IS NULL THEN $4
                                  ELSE personas.razon || ', ' || $4
                                END,
               actualizado_en = NOW()
         RETURNING *`,
        [nombreNormalizado, Number(edad), carrera, razon ?? null]
      );
      const persona = rows[0];
      const { rows: countRows } = await client.query(
        'SELECT COUNT(*) FROM personas WHERE total > $1',
        [persona.total]
      );
      const pos = Number(countRows[0].count) + 1;
      return res.status(200).json({ success: true, data: toLeaderboardRow(persona, pos) });
    }

    // ── PUT /api/personas/:id ────────────────────────────────────────────────
    //  Solo permite actualizar razon (se concatena) y total.
    //  nombre, edad y carrera se ignoran en este endpoint.
    if (method === 'PUT' && id && sub !== 'total') {
      const { total, razon } = body || {};

      const setClauses = [];
      const values     = [];
      let   idx        = 1;

      if (total !== undefined) { setClauses.push(`total = $${idx++}`); values.push(Number(total)); }
      if (razon !== undefined) {
        setClauses.push(`razon = CASE WHEN razon IS NULL THEN $${idx} ELSE razon || ', ' || $${idx} END`);
        idx++;
        values.push(razon);
      }

      if (!setClauses.length) {
        return res.status(400).json({ success: false, error: 'No se enviaron campos para actualizar' });
      }

      setClauses.push(`actualizado_en = NOW()`);
      values.push(id);

      const { rows } = await client.query(
        `UPDATE personas SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
        values
      );
      if (!rows.length) {
        return res.status(404).json({ success: false, error: 'Persona no encontrada' });
      }
      const persona = rows[0];
      const { rows: countRows } = await client.query(
        'SELECT COUNT(*) FROM personas WHERE total > $1',
        [persona.total]
      );
      const pos = Number(countRows[0].count) + 1;
      return res.status(200).json({ success: true, data: toLeaderboardRow(persona, pos) });
    }

    // ── PUT /api/personas/:id/total ──────────────────────────────────────────
    //  Incrementa o decrementa el total en 1.
    //  razon es opcional; si se envía, se concatena al valor existente.
    if (method === 'PUT' && id && sub === 'total') {
      const { accion, razon } = body || {};
      if (!['incrementar', 'decrementar'].includes(accion)) {
        return res.status(400).json({ success: false, error: 'accion debe ser "incrementar" o "decrementar"' });
      }

      const delta = accion === 'incrementar' ? 1 : -1;
      const { rows } = await client.query(
        `UPDATE personas
         SET total          = total + $1,
             razon          = CASE
                                WHEN $2 IS NULL            THEN razon
                                WHEN razon IS NULL         THEN $2
                                ELSE razon || ', ' || $2
                              END,
             actualizado_en = NOW()
         WHERE id = $3
         RETURNING *`,
        [delta, razon ?? null, id]
      );
      if (!rows.length) {
        return res.status(404).json({ success: false, error: 'Persona no encontrada' });
      }
      const persona = rows[0];
      const { rows: countRows } = await client.query(
        'SELECT COUNT(*) FROM personas WHERE total > $1',
        [persona.total]
      );
      const pos = Number(countRows[0].count) + 1;
      return res.status(200).json({ success: true, data: toLeaderboardRow(persona, pos) });
    }

    // ── DELETE /api/personas/:id ─────────────────────────────────────────────
    //  Requiere { password: "..." } en el body para autorizar el borrado.
    if (method === 'DELETE' && id) {
      const { password } = body || {};

      if (!password) {
        return res.status(400).json({ success: false, error: 'Se requiere el campo password' });
      }
      if (password !== DELETE_PASSWORD) {
        return res.status(401).json({ success: false, error: 'Contraseña incorrecta' });
      }

      const { rows } = await client.query(
        'DELETE FROM personas WHERE id = $1 RETURNING *',
        [id]
      );
      if (!rows.length) {
        return res.status(404).json({ success: false, error: 'Persona no encontrada' });
      }
      return res.status(200).json({ success: true, data: { deleted: rows[0] } });
    }

    return res.status(405).json({ success: false, error: 'Ruta no encontrada' });

  } catch (e) {
    console.error('[personas API]', e);
    return res.status(500).json({ success: false, error: e.message });
  } finally {
    client.release();
  }
}