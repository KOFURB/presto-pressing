'use strict';
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const path = require('path');
require('dotenv').config();

const pool = require('./db');
const { sign, authRequired, requireModule, requireAdmin, ROLE_ACCESS } = require('./auth');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ---- helpers ----
const uid = () => Math.random().toString(36).slice(2, 10);
const todayISO = () => new Date().toISOString().slice(0, 10);
const ah = fn => (req, res) => Promise.resolve(fn(req, res)).catch(err => {
  console.error(err);
  res.status(500).json({ error: 'Erreur serveur : ' + err.message });
});

// row mappers (snake_case -> camelCase attendu par le frontend)
const mapClient = r => ({ id: r.id, agencyId: r.agency_id, nom: r.nom, prenom: r.prenom, tel: r.tel, email: r.email, adresse: r.adresse, points: r.points, createdAt: r.created_at });
const mapEmp = r => ({ id: r.id, agencyId: r.agency_id, matricule: r.matricule, nom: r.nom, prenom: r.prenom, poste: r.poste, tel: r.tel, adresse: r.adresse, embauche: r.embauche, salaire: r.salaire, statut: r.statut });
const mapExpense = r => ({ id: r.id, agencyId: r.agency_id, date: r.date, categorie: r.categorie, libelle: r.libelle, montant: r.montant });
const mapStock = r => ({ id: r.id, agencyId: r.agency_id, nom: r.nom, categorie: r.categorie, qty: r.qty, seuil: r.seuil, unite: r.unite });
const mapUser = r => ({ id: r.id, nom: r.nom, login: r.login, role: r.role, actif: !!r.actif });
const mapAgency = r => ({ id: r.id, name: r.name, ville: r.ville, tel: r.tel });
const mapOrder = (r, items) => ({ id: r.id, num: r.num, agencyId: r.agency_id, clientId: r.client_id, depotDate: r.depot_date, dueDate: r.due_date, status: r.status, prodStage: r.prod_stage, remise: r.remise, montant: r.montant, paye: r.paye, notes: r.notes, createdAt: r.created_at, livreAt: r.livre_at, items: items || [] });
const mapItem = r => ({ type: r.type, qty: r.qty, etat: r.etat, prixUnit: r.prix_unit });

async function getSetting(k, def) { const [r] = await pool.query('SELECT v FROM settings WHERE k=?', [k]); return r.length ? r[0].v : def; }
async function setSetting(k, v) { await pool.query('INSERT INTO settings (k,v) VALUES (?,?) ON DUPLICATE KEY UPDATE v=VALUES(v)', [k, String(v)]); }

async function fetchOrderFull(id) {
  const [o] = await pool.query('SELECT * FROM orders WHERE id=?', [id]);
  if (!o.length) return null;
  const [items] = await pool.query('SELECT * FROM order_items WHERE order_id=?', [id]);
  return mapOrder(o[0], items.map(mapItem));
}

function computeMontant(items, remise) {
  const brut = items.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.prixUnit) || 0), 0);
  return Math.max(0, brut - (Number(remise) || 0));
}

// ============ AUTH ============
app.post('/api/auth/login', ah(async (req, res) => {
  const { login, password } = req.body || {};
  if (!login || !password) return res.status(400).json({ error: 'Identifiant et mot de passe requis' });
  const [rows] = await pool.query('SELECT * FROM users WHERE login=? LIMIT 1', [login]);
  if (!rows.length) return res.status(401).json({ error: 'Identifiants incorrects' });
  const u = rows[0];
  if (!u.actif) return res.status(403).json({ error: 'Compte désactivé' });
  if (!bcrypt.compareSync(password, u.password_hash)) return res.status(401).json({ error: 'Identifiants incorrects' });
  res.json({ token: sign(u), user: mapUser(u) });
}));

app.get('/api/auth/me', authRequired, (req, res) => {
  res.json({ user: { id: req.user.id, nom: req.user.nom, login: req.user.login, role: req.user.role }, access: ROLE_ACCESS[req.user.role] || [] });
});

// ============ BOOTSTRAP (toutes les données) ============
app.get('/api/bootstrap', authRequired, ah(async (req, res) => {
  const [agencies] = await pool.query('SELECT * FROM agencies ORDER BY name');
  const [clients] = await pool.query('SELECT * FROM clients');
  const [orders] = await pool.query('SELECT * FROM orders');
  const [items] = await pool.query('SELECT * FROM order_items');
  const [employees] = await pool.query('SELECT * FROM employees');
  const [users] = await pool.query('SELECT * FROM users');
  const [expenses] = await pool.query('SELECT * FROM expenses');
  const [stock] = await pool.query('SELECT * FROM stock');
  const [tarifs] = await pool.query('SELECT * FROM tarifs');
  const [settingsRows] = await pool.query('SELECT * FROM settings');

  const itemsByOrder = {};
  items.forEach(it => { (itemsByOrder[it.order_id] = itemsByOrder[it.order_id] || []).push(mapItem(it)); });
  const settings = {};
  settingsRows.forEach(s => settings[s.k] = s.v);

  res.json({
    me: { id: req.user.id, nom: req.user.nom, login: req.user.login, role: req.user.role },
    access: ROLE_ACCESS[req.user.role] || [],
    agencies: agencies.map(mapAgency),
    clients: clients.map(mapClient),
    orders: orders.map(o => mapOrder(o, itemsByOrder[o.id] || [])),
    employees: employees.map(mapEmp),
    users: users.map(mapUser),
    expenses: expenses.map(mapExpense),
    stock: stock.map(mapStock),
    tarifs: tarifs.map(t => ({ type: t.type, prix: t.prix })),
    settings: { loyaltyRate: Number(settings.loyaltyRate) || 1000, smsProvider: settings.smsProvider || 'HSMS.CI', shopName: settings.shopName || 'Presto Pressing' }
  });
}));

// ============ CLIENTS ============
app.post('/api/clients', authRequired, requireModule('clients'), ah(async (req, res) => {
  const b = req.body || {};
  if (!b.prenom || !b.nom || !b.tel) return res.status(400).json({ error: 'Prénom, nom et téléphone requis' });
  const id = 'c' + uid();
  await pool.query('INSERT INTO clients (id,agency_id,nom,prenom,tel,email,adresse,points,created_at) VALUES (?,?,?,?,?,?,?,0,?)',
    [id, b.agencyId, b.nom, b.prenom, b.tel, b.email || '', b.adresse || '', todayISO()]);
  const [r] = await pool.query('SELECT * FROM clients WHERE id=?', [id]);
  res.json(mapClient(r[0]));
}));

app.put('/api/clients/:id', authRequired, requireModule('clients'), ah(async (req, res) => {
  const b = req.body || {};
  await pool.query('UPDATE clients SET nom=?,prenom=?,tel=?,email=?,adresse=?,points=? WHERE id=?',
    [b.nom, b.prenom, b.tel, b.email || '', b.adresse || '', Number(b.points) || 0, req.params.id]);
  const [r] = await pool.query('SELECT * FROM clients WHERE id=?', [req.params.id]);
  if (!r.length) return res.status(404).json({ error: 'Client introuvable' });
  res.json(mapClient(r[0]));
}));

// ============ ORDERS ============
app.post('/api/orders', authRequired, requireModule('commandes'), ah(async (req, res) => {
  const b = req.body || {};
  const items = (b.items || []).filter(it => Number(it.qty) > 0);
  if (!items.length) return res.status(400).json({ error: 'Au moins un article requis' });
  if (!b.clientId) return res.status(400).json({ error: 'Client requis' });
  const seq = (Number(await getSetting('seq', '0')) || 0) + 1;
  await setSetting('seq', seq);
  const year = new Date().getFullYear();
  const num = 'PR-' + year + '-' + String(seq).padStart(4, '0');
  const montant = computeMontant(items, b.remise);
  const paye = Math.min(montant, Number(b.paye) || 0);
  const status = b.status || 'Reçu';
  const id = uid();
  await pool.query('INSERT INTO orders (id,num,agency_id,client_id,depot_date,due_date,status,prod_stage,remise,montant,paye,notes,created_at,livre_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [id, num, b.agencyId, b.clientId, b.depotDate, b.dueDate, status, b.prodStage || 'Réception', Number(b.remise) || 0, montant, paye, b.notes || '', todayISO(), status === 'Livré' ? todayISO() : null]);
  for (const it of items) {
    await pool.query('INSERT INTO order_items (order_id,type,qty,etat,prix_unit) VALUES (?,?,?,?,?)',
      [id, it.type, Number(it.qty) || 1, it.etat || 'Normal', Number(it.prixUnit) || 0]);
  }
  // fidélité
  const rate = Number(await getSetting('loyaltyRate', '1000')) || 1000;
  const pts = Math.floor(montant / rate);
  if (pts > 0) await pool.query('UPDATE clients SET points = points + ? WHERE id=?', [pts, b.clientId]);
  res.json(await fetchOrderFull(id));
}));

app.put('/api/orders/:id', authRequired, requireModule('commandes'), ah(async (req, res) => {
  const b = req.body || {};
  const id = req.params.id;
  const [ex] = await pool.query('SELECT * FROM orders WHERE id=?', [id]);
  if (!ex.length) return res.status(404).json({ error: 'Commande introuvable' });
  const items = (b.items || []).filter(it => Number(it.qty) > 0);
  if (!items.length) return res.status(400).json({ error: 'Au moins un article requis' });
  const montant = computeMontant(items, b.remise);
  const paye = Math.min(montant, Number(b.paye) || 0);
  const status = b.status || ex[0].status;
  let livreAt = ex[0].livre_at;
  if (status === 'Livré' && !livreAt) livreAt = todayISO();
  if (status !== 'Livré') livreAt = null;
  await pool.query('UPDATE orders SET client_id=?,depot_date=?,due_date=?,status=?,prod_stage=?,remise=?,montant=?,paye=?,notes=?,livre_at=? WHERE id=?',
    [b.clientId, b.depotDate, b.dueDate, status, b.prodStage, Number(b.remise) || 0, montant, paye, b.notes || '', livreAt, id]);
  await pool.query('DELETE FROM order_items WHERE order_id=?', [id]);
  for (const it of items) {
    await pool.query('INSERT INTO order_items (order_id,type,qty,etat,prix_unit) VALUES (?,?,?,?,?)',
      [id, it.type, Number(it.qty) || 1, it.etat || 'Normal', Number(it.prixUnit) || 0]);
  }
  res.json(await fetchOrderFull(id));
}));

app.patch('/api/orders/:id/pay', authRequired, requireModule('facturation'), ah(async (req, res) => {
  const amount = Number(req.body.amount) || 0;
  const [ex] = await pool.query('SELECT * FROM orders WHERE id=?', [req.params.id]);
  if (!ex.length) return res.status(404).json({ error: 'Commande introuvable' });
  const paye = Math.min(ex[0].montant, ex[0].paye + amount);
  await pool.query('UPDATE orders SET paye=? WHERE id=?', [paye, req.params.id]);
  res.json(await fetchOrderFull(req.params.id));
}));

app.patch('/api/orders/:id/stage', authRequired, requireModule('production'), ah(async (req, res) => {
  const stage = req.body.prodStage;
  let status = 'En cours';
  if (stage === 'Réception') status = 'Reçu';
  else if (stage === 'Prêt à livrer') status = 'Prêt';
  else if (stage === 'Livré') status = 'Livré';
  const [ex] = await pool.query('SELECT * FROM orders WHERE id=?', [req.params.id]);
  if (!ex.length) return res.status(404).json({ error: 'Commande introuvable' });
  let livreAt = ex[0].livre_at;
  if (status === 'Livré' && !livreAt) livreAt = todayISO();
  await pool.query('UPDATE orders SET prod_stage=?,status=?,livre_at=? WHERE id=?', [stage, status, livreAt, req.params.id]);
  res.json(await fetchOrderFull(req.params.id));
}));

// ============ EMPLOYEES ============
app.post('/api/employees', authRequired, requireModule('employes'), ah(async (req, res) => {
  const b = req.body || {};
  if (!b.prenom || !b.nom) return res.status(400).json({ error: 'Prénom et nom requis' });
  const id = uid();
  await pool.query('INSERT INTO employees (id,agency_id,matricule,nom,prenom,poste,tel,adresse,embauche,salaire,statut) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [id, b.agencyId, b.matricule || '', b.nom, b.prenom, b.poste || '', b.tel || '', b.adresse || '', b.embauche || null, Number(b.salaire) || 0, b.statut || 'Actif']);
  const [r] = await pool.query('SELECT * FROM employees WHERE id=?', [id]);
  res.json(mapEmp(r[0]));
}));

app.put('/api/employees/:id', authRequired, requireModule('employes'), ah(async (req, res) => {
  const b = req.body || {};
  await pool.query('UPDATE employees SET matricule=?,nom=?,prenom=?,poste=?,tel=?,adresse=?,embauche=?,salaire=?,statut=? WHERE id=?',
    [b.matricule || '', b.nom, b.prenom, b.poste || '', b.tel || '', b.adresse || '', b.embauche || null, Number(b.salaire) || 0, b.statut || 'Actif', req.params.id]);
  const [r] = await pool.query('SELECT * FROM employees WHERE id=?', [req.params.id]);
  if (!r.length) return res.status(404).json({ error: 'Employé introuvable' });
  res.json(mapEmp(r[0]));
}));

app.delete('/api/employees/:id', authRequired, requireModule('employes'), ah(async (req, res) => {
  await pool.query('DELETE FROM employees WHERE id=?', [req.params.id]);
  res.json({ ok: true });
}));

// ============ USERS (admin) ============
app.post('/api/users', authRequired, requireAdmin, ah(async (req, res) => {
  const b = req.body || {};
  if (!b.nom || !b.login || !b.password) return res.status(400).json({ error: 'Nom, identifiant et mot de passe requis' });
  const [dup] = await pool.query('SELECT id FROM users WHERE login=?', [b.login]);
  if (dup.length) return res.status(409).json({ error: 'Cet identifiant existe déjà' });
  const id = 'u' + uid();
  await pool.query('INSERT INTO users (id,nom,login,role,actif,password_hash) VALUES (?,?,?,?,?,?)',
    [id, b.nom, b.login, b.role, b.actif ? 1 : 0, bcrypt.hashSync(b.password, 10)]);
  const [r] = await pool.query('SELECT * FROM users WHERE id=?', [id]);
  res.json(mapUser(r[0]));
}));

app.put('/api/users/:id', authRequired, requireAdmin, ah(async (req, res) => {
  const b = req.body || {};
  if (b.password) {
    await pool.query('UPDATE users SET nom=?,login=?,role=?,actif=?,password_hash=? WHERE id=?',
      [b.nom, b.login, b.role, b.actif ? 1 : 0, bcrypt.hashSync(b.password, 10), req.params.id]);
  } else {
    await pool.query('UPDATE users SET nom=?,login=?,role=?,actif=? WHERE id=?',
      [b.nom, b.login, b.role, b.actif ? 1 : 0, req.params.id]);
  }
  const [r] = await pool.query('SELECT * FROM users WHERE id=?', [req.params.id]);
  if (!r.length) return res.status(404).json({ error: 'Utilisateur introuvable' });
  res.json(mapUser(r[0]));
}));

// ============ EXPENSES ============
app.post('/api/expenses', authRequired, requireModule('finances'), ah(async (req, res) => {
  const b = req.body || {};
  if (!(Number(b.montant) > 0)) return res.status(400).json({ error: 'Montant invalide' });
  const id = uid();
  await pool.query('INSERT INTO expenses (id,agency_id,date,categorie,libelle,montant) VALUES (?,?,?,?,?,?)',
    [id, b.agencyId, b.date || todayISO(), b.categorie || 'Autre', b.libelle || b.categorie || 'Autre', Number(b.montant)]);
  const [r] = await pool.query('SELECT * FROM expenses WHERE id=?', [id]);
  res.json(mapExpense(r[0]));
}));

// ============ STOCK ============
app.post('/api/stock', authRequired, requireModule('stocks'), ah(async (req, res) => {
  const b = req.body || {};
  if (!b.nom) return res.status(400).json({ error: 'Nom requis' });
  const id = uid();
  await pool.query('INSERT INTO stock (id,agency_id,nom,categorie,qty,seuil,unite) VALUES (?,?,?,?,?,?,?)',
    [id, b.agencyId, b.nom, b.categorie || 'Autre', Number(b.qty) || 0, Number(b.seuil) || 0, b.unite || 'pièce']);
  const [r] = await pool.query('SELECT * FROM stock WHERE id=?', [id]);
  res.json(mapStock(r[0]));
}));

app.put('/api/stock/:id', authRequired, requireModule('stocks'), ah(async (req, res) => {
  const b = req.body || {};
  await pool.query('UPDATE stock SET nom=?,categorie=?,qty=?,seuil=?,unite=? WHERE id=?',
    [b.nom, b.categorie || 'Autre', Number(b.qty) || 0, Number(b.seuil) || 0, b.unite || 'pièce', req.params.id]);
  const [r] = await pool.query('SELECT * FROM stock WHERE id=?', [req.params.id]);
  if (!r.length) return res.status(404).json({ error: 'Article introuvable' });
  res.json(mapStock(r[0]));
}));

app.patch('/api/stock/:id/adjust', authRequired, requireModule('stocks'), ah(async (req, res) => {
  const d = Number(req.body.delta) || 0;
  const [ex] = await pool.query('SELECT * FROM stock WHERE id=?', [req.params.id]);
  if (!ex.length) return res.status(404).json({ error: 'Article introuvable' });
  await pool.query('UPDATE stock SET qty=? WHERE id=?', [Math.max(0, ex[0].qty + d), req.params.id]);
  const [r] = await pool.query('SELECT * FROM stock WHERE id=?', [req.params.id]);
  res.json(mapStock(r[0]));
}));

app.delete('/api/stock/:id', authRequired, requireModule('stocks'), ah(async (req, res) => {
  await pool.query('DELETE FROM stock WHERE id=?', [req.params.id]);
  res.json({ ok: true });
}));

// ============ TARIFS / SETTINGS / AGENCIES (admin via parametres) ============
app.put('/api/tarifs', authRequired, requireModule('parametres'), ah(async (req, res) => {
  const { type, prix } = req.body || {};
  if (!type) return res.status(400).json({ error: 'Type requis' });
  await pool.query('INSERT INTO tarifs (type,prix) VALUES (?,?) ON DUPLICATE KEY UPDATE prix=VALUES(prix)', [type, Number(prix) || 0]);
  res.json({ type, prix: Number(prix) || 0 });
}));

app.put('/api/settings', authRequired, requireModule('parametres'), ah(async (req, res) => {
  const b = req.body || {};
  if (b.loyaltyRate != null) await setSetting('loyaltyRate', Number(b.loyaltyRate) || 1000);
  if (b.smsProvider != null) await setSetting('smsProvider', b.smsProvider);
  if (b.shopName != null) await setSetting('shopName', b.shopName);
  res.json({ ok: true });
}));

app.post('/api/agencies', authRequired, requireModule('parametres'), ah(async (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Nom requis' });
  const id = 'ag' + uid();
  await pool.query('INSERT INTO agencies (id,name,ville,tel) VALUES (?,?,?,?)', [id, b.name, b.ville || '', b.tel || '']);
  const [r] = await pool.query('SELECT * FROM agencies WHERE id=?', [id]);
  res.json(mapAgency(r[0]));
}));

// ============ static frontend ============
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Route inconnue' });
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Presto Pressing — serveur démarré sur le port ' + PORT));
