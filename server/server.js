'use strict';
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const path = require('path');
require('dotenv').config();

const pool = require('./db');
const { sign, authRequired, requireModule, requireAdmin, ROLE_ACCESS } = require('./auth');
const nodemailer = require('nodemailer');

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

// ---- HSMS SMS ----
function normTel(t){ let d=String(t||'').replace(/\D/g,''); if(!d) return ''; if(d.startsWith('225')) return d; return '225'+d; }
async function smsConfig(){ const keys=['sms_url','sms_token','sms_clientid','sms_clientsecret','sms_sender']; const c={}; for(const k of keys) c[k]=await getSetting(k,''); return c; }
async function sendSMS(tel, message){
  const c=await smsConfig();
  const to=normTel(tel);
  if(!to) return { ok:false, skipped:true, reason:'Numero de telephone manquant' };
  if(!c.sms_token || !c.sms_clientid || !c.sms_clientsecret) return { ok:false, skipped:true, reason:'Configuration SMS incomplete (token/clientid/clientsecret)' };
  const url=c.sms_url || 'https://hsms.ci/api/envoi-sms';
  const body={ clientid:c.sms_clientid, clientsecret:c.sms_clientsecret, telephone:to, message, unicode:true };
  if(c.sms_sender) body.expediteur=c.sms_sender;
  try{
    const r=await fetch(url,{ method:'POST', headers:{ 'Authorization':'Bearer '+c.sms_token, 'Content-Type':'application/json' }, body:JSON.stringify(body) });
    let data={}; try{ data=await r.json(); }catch(e){}
    const ok = r.ok && data.success!==false;
    if(!ok) console.error('SMS echec', r.status, JSON.stringify(data));
    return { ok, status:r.status, data };
  }catch(e){ console.error('SMS erreur', e.message); return { ok:false, error:e.message }; }
}
async function orderSMS(orderId, kind){
  const [o]=await pool.query('SELECT * FROM orders WHERE id=?',[orderId]);
  if(!o.length) return { ok:false, skipped:true };
  const ord=o[0];
  const [cl]=await pool.query('SELECT * FROM clients WHERE id=?',[ord.client_id]);
  if(!cl.length || !cl[0].tel) return { ok:false, skipped:true, reason:'Client sans numero de telephone' };
  const [ag]=await pool.query('SELECT * FROM agencies WHERE id=?',[ord.agency_id]);
  const shop=(ag.length && ag[0].name) ? ag[0].name : (await getSetting('shopName','Presto Pressing'));
  const reste=Math.max(0, ord.montant - ord.paye);
  const prenom=cl[0].prenom||'';
  const resteTxt = reste>0 ? (' Reste a payer: '+reste+' FCFA.') : '';
  let msg;
  if(kind==='reminder') msg='Bonjour '+prenom+', rappel : votre commande '+ord.num+' vous attend chez '+shop+'.'+resteTxt+' Merci de venir la retirer.';
  else msg='Bonjour '+prenom+', votre commande '+ord.num+' chez '+shop+' est prete.'+resteTxt+' Merci !';
  return await sendSMS(cl[0].tel, msg);
}

// ---- Email (SMTP via nodemailer) ----
function eMoney(n){ return (Math.round(n||0)).toLocaleString('fr-FR').replace(/ | /g,' ')+' FCFA'; }
function invoiceHTML(ord, items, cl, ag){
  const brut=items.reduce((s,it)=>s+it.qty*it.prix_unit,0);
  const reste=Math.max(0, ord.montant - ord.paye);
  const rows=items.map(it=>`<tr><td style="padding:6px;border-bottom:1px solid #eee">${it.type}</td><td style="padding:6px;border-bottom:1px solid #eee;color:#777">${it.etat||''}</td><td style="padding:6px;border-bottom:1px solid #eee;text-align:center">${it.qty}</td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">${eMoney(it.prix_unit)}</td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">${eMoney(it.qty*it.prix_unit)}</td></tr>`).join('');
  const shop=ag&&ag.name?ag.name:'Pressing';
  return `<div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;color:#111">
    <div style="display:flex;justify-content:space-between;align-items:flex-start">
      <div><div style="font-size:20px;font-weight:800;color:#143a70">${shop}</div><div style="font-size:12px;color:#555">${ag&&ag.ville?ag.ville:''}<br>${ag&&ag.tel?('Tel. '+ag.tel):''}</div></div>
      <div style="text-align:right"><div style="font-weight:800">FACTURE</div><div style="font-size:12px;color:#555">N&deg; ${ord.num.replace('PR','FAC')}<br>Date : ${ord.depot_date}</div></div>
    </div>
    <div style="margin:16px 0;padding:10px;background:#f4f7fb;border-radius:8px">
      <div style="font-size:11px;text-transform:uppercase;color:#777">Factur&eacute; &agrave;</div>
      <div style="font-weight:700">${cl?cl.prenom+' '+cl.nom:''}</div>
      <div style="font-size:12px;color:#555">${cl?cl.tel||'':''} ${cl&&cl.adresse?('&middot; '+cl.adresse):''}</div>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="border-bottom:2px solid #143a70;color:#143a70;text-align:left"><th style="padding:6px">Article</th><th>&Eacute;tat</th><th style="text-align:center">Qt&eacute;</th><th style="text-align:right">P.U.</th><th style="text-align:right">Montant</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div style="display:flex;justify-content:flex-end;margin-top:14px"><table style="font-size:13px;min-width:240px">
      <tr><td style="padding:3px 10px;color:#555">Sous-total</td><td style="text-align:right">${eMoney(brut)}</td></tr>
      ${ord.remise?`<tr><td style="padding:3px 10px;color:#555">Remise</td><td style="text-align:right">- ${eMoney(ord.remise)}</td></tr>`:''}
      <tr style="border-top:2px solid #143a70"><td style="padding:6px 10px;font-weight:800">TOTAL</td><td style="text-align:right;font-weight:800;color:#143a70">${eMoney(ord.montant)}</td></tr>
      <tr><td style="padding:3px 10px;color:#555">Pay&eacute;</td><td style="text-align:right">${eMoney(ord.paye)}</td></tr>
      <tr><td style="padding:3px 10px;font-weight:700">Reste d&ucirc;</td><td style="text-align:right;font-weight:700;color:${reste>0?'#c33b4d':'#1c8f5a'}">${eMoney(reste)}</td></tr>
    </table></div>
    <p style="margin-top:22px;text-align:center;font-size:11px;color:#999">Merci de votre confiance &mdash; ${shop}</p>
  </div>`;
}
async function sendInvoiceEmail(orderId){
  const [o]=await pool.query('SELECT * FROM orders WHERE id=?',[orderId]);
  if(!o.length) return { ok:false, skipped:true };
  const ord=o[0];
  const [cl]=await pool.query('SELECT * FROM clients WHERE id=?',[ord.client_id]);
  if(!cl.length || !cl[0].email) return { ok:false, skipped:true, reason:'Client sans adresse email' };
  const [items]=await pool.query('SELECT * FROM order_items WHERE order_id=?',[orderId]);
  const [ag]=await pool.query('SELECT * FROM agencies WHERE id=?',[ord.agency_id]);
  const keys=['notif_email','smtp_server','smtp_login','smtp_password','smtp_port'];
  const c={}; for(const k of keys) c[k]=await getSetting(k,'');
  if(!c.smtp_server || !c.smtp_login || !c.smtp_password) return { ok:false, skipped:true, reason:'Configuration SMTP incomplete' };
  const port=Number(c.smtp_port)||587;
  try{
    const transporter=nodemailer.createTransport({ host:c.smtp_server, port, secure:port===465, auth:{ user:c.smtp_login, pass:c.smtp_password } });
    const shop=(ag.length&&ag[0].name)?ag[0].name:(await getSetting('shopName','Pressing'));
    await transporter.sendMail({ from:c.notif_email||c.smtp_login, to:cl[0].email, subject:'Votre facture '+ord.num.replace('PR','FAC')+' - '+shop, html:invoiceHTML(ord, items, cl[0], ag[0]) });
    return { ok:true };
  }catch(e){ console.error('Email erreur', e.message); return { ok:false, error:e.message }; }
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
    settings: { loyaltyRate: Number(settings.loyaltyRate) || 1000, smsProvider: settings.smsProvider || 'HSMS.CI', shopName: settings.shopName || 'Presto Pressing' },
    notifConfig: req.user.role==='Administrateur' ? ['notif_email','smtp_server','smtp_login','smtp_password','smtp_port','sms_url','sms_apikey','sms_sender','sms_clientsecret','sms_clientid','sms_token'].reduce((o,k)=>{o[k]=settings[k]||'';return o;},{}) : {}
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
  sendInvoiceEmail(id).catch(()=>{});
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
  if (status === 'Prêt' && ex[0].status !== 'Prêt') { orderSMS(id, 'ready').catch(()=>{}); }
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
  if (status === 'Prêt' && ex[0].status !== 'Prêt') { orderSMS(req.params.id, 'ready').catch(()=>{}); }
  res.json(await fetchOrderFull(req.params.id));
}));

app.post('/api/orders/:id/remind', authRequired, requireModule('commandes'), ah(async (req, res) => {
  const r = await orderSMS(req.params.id, 'reminder');
  if (r.ok) return res.json({ ok: true });
  res.status(400).json({ error: r.reason || r.error || 'Echec de l\'envoi SMS' });
}));

app.post('/api/orders/:id/email', authRequired, requireModule('facturation'), ah(async (req, res) => {
  const r = await sendInvoiceEmail(req.params.id);
  if (r.ok) return res.json({ ok: true });
  res.status(400).json({ error: r.reason || r.error || 'Echec de l\'envoi email' });
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

app.delete('/api/tarifs/:type', authRequired, requireModule('parametres'), ah(async (req, res) => {
  await pool.query('DELETE FROM tarifs WHERE type=?', [req.params.type]);
  res.json({ ok: true });
}));

app.put('/api/settings', authRequired, requireModule('parametres'), ah(async (req, res) => {
  const b = req.body || {};
  if (b.loyaltyRate != null) await setSetting('loyaltyRate', Number(b.loyaltyRate) || 1000);
  if (b.smsProvider != null) await setSetting('smsProvider', b.smsProvider);
  if (b.shopName != null) await setSetting('shopName', b.shopName);
  const NKEYS = ['notif_email','smtp_server','smtp_login','smtp_password','smtp_port','sms_url','sms_apikey','sms_sender','sms_clientsecret','sms_clientid','sms_token'];
  for (const k of NKEYS) { if (b[k] != null) await setSetting(k, b[k]); }
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

app.put('/api/agencies/:id', authRequired, requireModule('parametres'), ah(async (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Nom requis' });
  await pool.query('UPDATE agencies SET name=?,ville=?,tel=? WHERE id=?', [b.name, b.ville || '', b.tel || '', req.params.id]);
  const [r] = await pool.query('SELECT * FROM agencies WHERE id=?', [req.params.id]);
  if (!r.length) return res.status(404).json({ error: 'Agence introuvable' });
  res.json(mapAgency(r[0]));
}));

app.post('/api/reset-demo', authRequired, requireAdmin, ah(async (req, res) => {
  await pool.query('DELETE FROM order_items');
  await pool.query('DELETE FROM orders');
  await pool.query('DELETE FROM clients');
  await pool.query('DELETE FROM employees');
  await pool.query('DELETE FROM expenses');
  await pool.query('DELETE FROM stock');
  await setSetting('seq', '0');
  res.json({ ok: true });
}));

// ============ static frontend ============
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Route inconnue' });
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Presto Pressing — serveur démarré sur le port ' + PORT));
