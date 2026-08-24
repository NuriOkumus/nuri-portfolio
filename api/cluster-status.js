import { createHash, timingSafeEqual } from 'node:crypto';

const REDIS_KEY = 'cluster:status';

function timingSafeEqualStrings(a, b) {
  const hashA = createHash('sha256').update(String(a)).digest();
  const hashB = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(hashA, hashB);
}

function isIsoDateString(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isNonNegativeInt(value) {
  return Number.isInteger(value) && value >= 0;
}

function validatePayload(body) {
  if (!body || typeof body !== 'object') return false;
  if (!isIsoDateString(body.generated_at)) return false;
  if (!isIsoDateString(body.oldest_node_created_at)) return false;

  const nodes = body.nodes;
  if (!nodes || typeof nodes !== 'object') return false;
  if (!isNonNegativeInt(nodes.ready) || !isNonNegativeInt(nodes.total)) return false;
  if (nodes.ready > nodes.total) return false;

  const applications = body.applications;
  if (!applications || typeof applications !== 'object') return false;
  if (!isNonNegativeInt(applications.synced_healthy) || !isNonNegativeInt(applications.total)) return false;
  if (applications.synced_healthy > applications.total) return false;

  return true;
}

function sanitizePayload(body) {
  return {
    generated_at: body.generated_at,
    nodes: { ready: body.nodes.ready, total: body.nodes.total },
    oldest_node_created_at: body.oldest_node_created_at,
    applications: { synced_healthy: body.applications.synced_healthy, total: body.applications.total },
  };
}

function upstashHeaders() {
  return { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` };
}

async function redisSet(value) {
  const url = `${process.env.KV_REST_API_URL}/set/${encodeURIComponent(REDIS_KEY)}`;
  const res = await fetch(url, { method: 'POST', headers: upstashHeaders(), body: value });
  if (!res.ok) throw new Error(`redis set failed: ${res.status}`);
}

async function redisGet() {
  const url = `${process.env.KV_REST_API_URL}/get/${encodeURIComponent(REDIS_KEY)}`;
  const res = await fetch(url, { headers: upstashHeaders() });
  if (!res.ok) throw new Error(`redis get failed: ${res.status}`);
  const data = await res.json();
  return data.result;
}

async function handlePost(req, res) {
  const expectedToken = process.env.CLUSTER_INGEST_TOKEN;
  const authHeader = req.headers['authorization'] || '';
  const [scheme, providedToken] = authHeader.split(' ');

  if (!expectedToken || scheme !== 'Bearer' || !providedToken || !timingSafeEqualStrings(providedToken, expectedToken)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  let body;
  try {
    body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);
  } catch {
    res.status(400).json({ error: 'invalid_json' });
    return;
  }

  if (!validatePayload(body)) {
    res.status(400).json({ error: 'invalid_payload' });
    return;
  }

  try {
    await redisSet(JSON.stringify(sanitizePayload(body)));
  } catch {
    res.status(502).json({ error: 'upstream_failure' });
    return;
  }

  res.status(204).end();
}

async function handleGet(req, res) {
  let raw;
  try {
    raw = await redisGet();
  } catch {
    res.status(502).json({ error: 'upstream_failure' });
    return;
  }

  if (!raw) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    res.status(502).json({ error: 'corrupt_data' });
    return;
  }

  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
  res.status(200).json(parsed);
}

export default async function handler(req, res) {
  if (req.method === 'POST') {
    await handlePost(req, res);
    return;
  }
  if (req.method === 'GET') {
    await handleGet(req, res);
    return;
  }
  res.setHeader('Allow', 'GET, POST');
  res.status(405).json({ error: 'method_not_allowed' });
}
