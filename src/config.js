const fs = require('fs');
const path = require('path');

const raw = fs.readFileSync(path.join(__dirname, '..', '.api_creds'), 'utf-8');
const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);

// Support key=value format or legacy label/value alternating lines
const kv = {};
for (const line of lines) {
  const eq = line.indexOf('=');
  if (eq > 0) { kv[line.slice(0, eq).trim().toLowerCase()] = line.slice(eq + 1).trim(); }
}

const clientId = kv.client_id || kv.clientid || lines[1];
const clientSecret = kv.client_secret || kv.clientsecret || lines[3];

if (!clientId || !clientSecret) {
  console.error('Missing credentials in .api_creds. Expected key=value pairs (client_id, client_secret) or label/value lines.');
  process.exit(1);
}

module.exports = {
  clientId,
  clientSecret,
  redirectUri: 'http://localhost:8080/callback',
  authUrl: 'https://flow.polar.com/oauth2/authorization',
  tokenUrl: 'https://polarremote.com/v2/oauth2/token',
  apiBase: 'https://www.polaraccesslink.com/v3',
};
