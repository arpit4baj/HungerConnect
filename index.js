import 'dotenv/config';
import express from 'express'; import cors from 'cors'; import helmet from 'helmet';
import rateLimit from 'express-rate-limit'; import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';

// Service-role key lives ONLY here, never in the frontend.
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const app = express();
app.use(helmet(), cors({ origin: process.env.FRONTEND_URL || 'http://localhost:5173' }), express.json({ limit: '100kb' }), rateLimit({ windowMs: 60000, limit: 120 }));

const wrap = f => (req, res) => f(req, res).catch(e => { console.error(e); res.status(500).json({ error: 'Server error' }); });
const notify = (user_id, message) => db.from('notifications').insert({ user_id, message });
const nowIso = () => new Date().toISOString();

// ---- auth: verify Supabase JWT, load profile (role-based access control)
async function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const { data } = await db.auth.getUser(token);
  if (!data?.user) return res.status(401).json({ error: 'Log in required' });
  const { data: p } = await db.from('profiles').select('*').eq('id', data.user.id).single();
  if (!p) return res.status(403).json({ error: 'No profile' });
  req.me = p; next();
}
const role = (...r) => (req, res, next) => r.includes(req.me.role) ? next() : res.status(403).json({ error: 'Not allowed for your role' });
const verifiedNgo = (req, res, next) => req.me.verified ? next() : res.status(403).json({ error: 'Organization not verified yet' });

// ---- expiry: also run on every read so listings never go stale
const expire = () => db.from('donations').update({ status: 'expired' }).in('status', ['available', 'requested']).lt('expires_at', nowIso());

const donationSchema = z.object({
  name: z.string().trim().min(3).max(120), food_type: z.enum(['Veg', 'Vegan', 'Non-veg', 'Packaged']),
  servings: z.number().int().min(1).max(1000), weight_kg: z.number().positive().max(2000).nullable().optional(),
  hours_since_prepared: z.number().min(0).max(48), safe_hours: z.number().min(1).max(24),
  storage_info: z.string().trim().min(5).max(300), allergens: z.string().trim().max(300).optional(),
  pickup_address: z.string().trim().min(5).max(250), lat: z.number().optional(), lng: z.number().optional(),
  image_path: z.string().max(300).optional(), safety_confirmed: z.literal(true)
}).refine(d => d.food_type === 'Packaged' || d.hours_since_prepared + d.safe_hours <= 24, { message: 'Cooked food must be donated within 24h of preparation' });

app.get('/api/health', (_, r) => r.json({ ok: true }));

// Public stats, computed from real rows. Measured and estimated kg are reported separately.
app.get('/api/stats', wrap(async (_, res) => {
  await expire();
  const { data: ds } = await db.from('donations').select('status,servings,weight_kg,donor_id');
  const del = ds.filter(d => d.status === 'delivered');
  const { count: ngos } = await db.from('profiles').select('*', { count: 'exact', head: true }).eq('role', 'ngo').eq('verified', true);
  res.json({ total: ds.length, deliveries: del.length, meals: del.reduce((a, d) => a + d.servings, 0), verified_ngos: ngos, active_donors: new Set(ds.map(d => d.donor_id)).size,
    kg_measured: del.filter(d => d.weight_kg).reduce((a, d) => a + +d.weight_kg, 0), kg_estimated: del.filter(d => !d.weight_kg).reduce((a, d) => a + d.servings * 0.4, 0),
    method: '1 meal = 1 donor-declared serving; unmeasured weight estimated at 0.4 kg per serving' });
}));

// Search, filter, sort, paginate. Hides pickup address from anonymous callers.
app.get('/api/donations', wrap(async (req, res) => {
  await expire();
  const { q, type, sort = 'deadline', page = 1, size = 12 } = req.query;
  let s = db.from('donations').select('id,name,food_type,servings,expires_at,prepared_at,allergens,status,image_path,lat,lng', { count: 'exact' }).eq('status', 'available');
  if (type) s = s.eq('food_type', type);
  if (q) s = s.ilike('name', `%${String(q).replace(/[%,]/g, '')}%`);
  s = sort === 'servings' ? s.order('servings', { ascending: false }) : s.order('expires_at');
  const from = (Math.max(1, +page) - 1) * Math.min(50, +size);
  const { data, count, error } = await s.range(from, from + Math.min(50, +size) - 1);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ items: data, total: count });
}));

app.get('/api/donations/:id', auth, wrap(async (req, res) => {
  const { data } = await db.from('donations').select('*, donor:profiles!donor_id(name)').eq('id', req.params.id).single();
  res.json(data || null);
}));

app.post('/api/donations', auth, role('donor'), wrap(async (req, res) => {
  const p = donationSchema.safeParse(req.body); if (!p.success) return res.status(400).json({ error: p.error.issues[0].message });
  const { hours_since_prepared, safe_hours, safety_confirmed, ...d } = p.data, t = Date.now();
  const { data, error } = await db.from('donations').insert({ ...d, donor_id: req.me.id, prepared_at: new Date(t - hours_since_prepared * 36e5).toISOString(), expires_at: new Date(t + safe_hours * 36e5).toISOString() }).select().single();
  if (error) return res.status(400).json({ error: error.message }); res.status(201).json(data);
}));

app.delete('/api/donations/:id', auth, role('donor'), wrap(async (req, res) => {   // owner only, only while available
  const { data } = await db.from('donations').delete().eq('id', req.params.id).eq('donor_id', req.me.id).eq('status', 'available').select();
  data?.length ? res.json({ ok: true }) : res.status(409).json({ error: 'Not yours, or already requested' });
}));

// Atomic claim: the conditional UPDATE means only one NGO can win; the unique index is a second guard.
app.post('/api/donations/:id/request', auth, role('ngo'), verifiedNgo, wrap(async (req, res) => {
  const { data } = await db.from('donations').update({ status: 'requested', ngo_id: req.me.id }).eq('id', req.params.id).eq('status', 'available').gt('expires_at', nowIso()).select().single();
  if (!data) return res.status(409).json({ error: 'Already claimed or expired' });
  const { error } = await db.from('donation_requests').insert({ donation_id: data.id, ngo_id: req.me.id });
  if (error) return res.status(409).json({ error: 'Already claimed' });
  await notify(data.donor_id, `${req.me.name} requested ${data.name}`); res.json(data);
}));

async function decide(req, res, ok) {
  const { data: r } = await db.from('donation_requests').select('*, donations(*)').eq('id', req.params.id).eq('status', 'pending').single();
  if (!r || r.donations.donor_id !== req.me.id) return res.status(404).json({ error: 'Request not found' });
  await db.from('donation_requests').update({ status: ok ? 'accepted' : 'rejected' }).eq('id', r.id);
  await db.from('donations').update(ok ? { status: 'accepted' } : { status: 'available', ngo_id: null }).eq('id', r.donation_id);
  await notify(r.ngo_id, `${ok ? 'Approved' : 'Declined'}: ${r.donations.name}`); res.json({ ok: true });
}
app.post('/api/requests/:id/accept', auth, role('donor'), wrap((q, s) => decide(q, s, true)));
app.post('/api/requests/:id/reject', auth, role('donor'), wrap((q, s) => decide(q, s, false)));

app.post('/api/donations/:id/take', auth, role('volunteer'), wrap(async (req, res) => {
  const { data } = await db.from('donations').update({ volunteer_id: req.me.id }).eq('id', req.params.id).eq('status', 'accepted').is('volunteer_id', null).select().single();
  if (!data) return res.status(409).json({ error: 'Task unavailable' }); await notify(data.donor_id, `${req.me.name} will collect ${data.name}`); res.json(data);
}));

// accepted -> picked_up -> delivered. Only the assigned volunteer or receiving NGO may advance.
app.post('/api/donations/:id/advance', auth, role('volunteer', 'ngo'), wrap(async (req, res) => {
  const { data: d } = await db.from('donations').select('*').eq('id', req.params.id).single();
  if (!d || ![d.volunteer_id, d.ngo_id].includes(req.me.id)) return res.status(403).json({ error: 'Not your delivery' });
  const next = { accepted: 'picked_up', picked_up: 'delivered' }[d.status]; if (!next) return res.status(409).json({ error: 'Cannot advance' });
  const proof = z.string().trim().min(3).max(300).safeParse(req.body.proof_note);
  if (next === 'delivered' && !proof.success) return res.status(400).json({ error: 'Delivery needs a proof note' });
  await db.from('donations').update({ status: next, ...(next === 'delivered' ? { proof_note: proof.data, proof_path: req.body.proof_path } : {}) }).eq('id', d.id);
  await Promise.all([d.donor_id, d.ngo_id].map(u => notify(u, `${d.name}: ${next.replace('_', ' ')}`))); res.json({ status: next });
}));

app.post('/api/donations/:id/report', auth, wrap(async (req, res) => {
  const r = z.string().trim().min(5).max(500).safeParse(req.body.reason); if (!r.success) return res.status(400).json({ error: 'Describe the problem (5+ chars)' });
  await db.from('reports').insert({ donation_id: req.params.id, reporter_id: req.me.id, reason: r.data });
  await db.from('donations').update({ flagged: true }).eq('id', req.params.id); res.json({ ok: true });
}));

app.get('/api/notifications', auth, wrap(async (req, res) => res.json((await db.from('notifications').select('*').eq('user_id', req.me.id).order('created_at', { ascending: false }).limit(30)).data)));

// ---- admin
app.get('/api/admin/pending', auth, role('admin'), wrap(async (_, res) => res.json((await db.from('profiles').select('*, verification_documents(*)').eq('role', 'ngo').eq('verified', false)).data)));
app.post('/api/admin/verify/:id', auth, role('admin'), wrap(async (req, res) => { await db.from('profiles').update({ verified: true }).eq('id', req.params.id); await notify(req.params.id, 'Your organization is verified'); res.json({ ok: true }); }));
app.post('/api/admin/remove/:id', auth, role('admin'), wrap(async (req, res) => { await db.from('donations').update({ status: 'removed' }).eq('id', req.params.id); res.json({ ok: true }); }));
app.get('/api/admin/reports', auth, role('admin'), wrap(async (_, res) => res.json((await db.from('reports').select('*, donations(name)').eq('status', 'open')).data)));

setInterval(expire, 5 * 60 * 1000);
app.listen(process.env.PORT || 4000, () => console.log('HungerConnect API up'));
