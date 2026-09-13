const crypto = require('crypto');
const https = require('https');

function makeJWT(creds) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: creds.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly https://www.googleapis.com/auth/drive.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  })).toString('base64url');
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(header + '.' + payload);
  const sig = sign.sign(creds.private_key, 'base64url');
  return `${header}.${payload}.${sig}`;
}

function post(url, data) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(data).toString();
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function get(url, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https.get({
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: { Authorization: `Bearer ${token}` },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}

async function getToken() {
  const creds = {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  };
  const jwt = makeJWT(creds);
  const result = await post('https://oauth2.googleapis.com/token', {
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt,
  });
  return result.access_token;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate');

  const MASTER_ID = process.env.MASTER_SHEET_ID;

  try {
    const token = await getToken();

    // Master sheet: A=Sheet ID, B=Nombre del evento, C=Activo (TRUE/FALSE)
    const master = await get(
      `https://sheets.googleapis.com/v4/spreadsheets/${MASTER_ID}/values/A2:C50`,
      token
    );

    const eventos = [];

    for (const row of master.values || []) {
      const [id, nombre, activo] = row;
      if (!id || (activo || '').toUpperCase() !== 'TRUE') continue;

      // Leer J1:K5 del sheet del evento (J5 = última actualización)
      const data = await get(
        `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/J1:K5`,
        token
      );

      const rows = data.values || [];
      const titulo = rows[0]?.[0] || nombre;

      const tandas = [];
      for (let i = 1; i <= 2; i++) {
        if (rows[i]?.[0]) {
          tandas.push({
            tipo: rows[i][0],
            cantidad: parseInt(rows[i][1]) || 0,
          });
        }
      }

      const total = parseInt(rows[3]?.[1]) || 0;
      const ultimaActualizacion = rows[4]?.[0] || null;

      eventos.push({ titulo, tandas, total, ultimaActualizacion });
    }

    res.json({ ok: true, eventos, updatedAt: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
};
