'use strict';
/* Crée les tables (schema.sql) et, avec --seed, insère des données de démonstration.
   Usage : node server/init-db.js [--seed] */
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');
require('dotenv').config();

const uid = () => Math.random().toString(36).slice(2, 10);
const todayISO = () => new Date().toISOString().slice(0, 10);
const addDays = (iso, d) => { const t = new Date(iso); t.setDate(t.getDate() + d); return t.toISOString().slice(0, 10); };

// Comptes par défaut (À CHANGER après le premier déploiement)
const DEFAULT_USERS = [
  { id: 'u1', nom: 'Konan Alexis', login: 'admin',      role: 'Administrateur',           pass: 'admin123' },
  { id: 'u2', nom: 'Sangaré Mariam', login: 'caisse',   role: 'Caissier',                 pass: 'caisse123' },
  { id: 'u3', nom: 'Kablan Yves', login: 'reception',   role: 'Agent de réception',       pass: 'reception123' },
  { id: 'u4', nom: 'Ouattara Salif', login: 'production', role: 'Responsable de production', pass: 'production123' }
];

async function main() {
  const seedFlag = process.argv.includes('--seed');
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'presto',
    multipleStatements: true
  });

  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await conn.query(schema);
  console.log('✓ Tables créées / vérifiées.');

  // Toujours garantir au moins les comptes utilisateurs + tarifs + agence + settings
  const [uRows] = await conn.query('SELECT COUNT(*) AS n FROM users');
  if (uRows[0].n === 0) {
    for (const u of DEFAULT_USERS) {
      const hash = bcrypt.hashSync(u.pass, 10);
      await conn.query('INSERT INTO users (id,nom,login,role,actif,password_hash) VALUES (?,?,?,?,1,?)',
        [u.id, u.nom, u.login, u.role, hash]);
    }
    console.log('✓ Comptes par défaut créés :');
    DEFAULT_USERS.forEach(u => console.log(`   - ${u.login} / ${u.pass}  (${u.role})`));
  }

  const [tRows] = await conn.query('SELECT COUNT(*) AS n FROM tarifs');
  if (tRows[0].n === 0) {
    const tarifs = [['Chemise',500],['Pantalon',700],['Costume 2 pièces',2500],['Robe',1500],['Veste',1200],
      ['Manteau',2000],['Jean',800],['Pull',700],['Drap',1000],['Couette',3500],['Rideau',2500],
      ['Nappe',1200],['Boubou',2000],['Tailleur',2500]];
    for (const [type, prix] of tarifs) await conn.query('INSERT INTO tarifs (type,prix) VALUES (?,?)', [type, prix]);
    console.log('✓ Grille tarifaire initialisée.');
  }

  const [sRows] = await conn.query('SELECT COUNT(*) AS n FROM settings');
  if (sRows[0].n === 0) {
    const settings = { loyaltyRate: '1000', smsProvider: 'HSMS.CI', shopName: 'Presto Pressing', seq: '0' };
    for (const [k, v] of Object.entries(settings)) await conn.query('INSERT INTO settings (k,v) VALUES (?,?)', [k, v]);
    console.log('✓ Paramètres initialisés.');
  }

  const [aRows] = await conn.query('SELECT COUNT(*) AS n FROM agencies');
  if (aRows[0].n === 0) {
    await conn.query('INSERT INTO agencies (id,name,ville,tel) VALUES (?,?,?,?)',
      ['ag1', 'Presto Cocody', 'Abidjan — Cocody', '27 22 44 55 66']);
    console.log('✓ Agence par défaut créée.');
  }

  if (seedFlag) {
    await seedDemo(conn);
  }

  await conn.end();
  console.log('\nTerminé.');
}

async function seedDemo(conn) {
  const [c] = await conn.query('SELECT COUNT(*) AS n FROM clients');
  if (c[0].n > 0) { console.log('• Données déjà présentes — seed démo ignoré.'); return; }

  // 2e agence
  await conn.query('INSERT INTO agencies (id,name,ville,tel) VALUES (?,?,?,?)',
    ['ag2', 'Presto Marcory', 'Abidjan — Marcory', '27 21 33 22 11']);

  const A1 = 'ag1', A2 = 'ag2';
  const clientsSeed = [
    ['Kouassi','Aya','0708112233','Cocody Angré',A1,340],
    ['Traoré','Ibrahim','0501445566','Marcory Zone 4',A1,120],
    ["N'Guessan",'Marie-Claire','0777889900','Plateau',A1,880],
    ['Diabaté','Souleymane','0546332211','Yopougon Selmer',A1,60],
    ['Koné','Fatou','0709001122','Riviera Palmeraie',A1,510],
    ['Yao','Hervé','0505778899','Treichville',A2,210],
    ['Bamba','Aminata','0788445511','Abobo',A2,40],
    ['Assi','Jean-Marc','0544120987','Bingerville',A2,300]
  ];
  const clientIds = [];
  for (let i = 0; i < clientsSeed.length; i++) {
    const cx = clientsSeed[i]; const id = 'c' + (i + 1); clientIds.push(id);
    await conn.query('INSERT INTO clients (id,agency_id,nom,prenom,tel,email,adresse,points,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [id, cx[4], cx[0], cx[1], cx[2], '', cx[3], cx[5], addDays(todayISO(), -(40 - i * 3))]);
  }

  const tarifMap = {};
  const [tr] = await conn.query('SELECT type,prix FROM tarifs');
  tr.forEach(t => tarifMap[t.type] = t.prix);
  const price = t => tarifMap[t] || 1000;

  let seq = 0;
  async function mkOrder(agencyId, clientId, items, daysAgo, status, stage, payRatio, remise) {
    seq++; const num = 'PR-2026-' + String(seq).padStart(4, '0');
    const brut = items.reduce((s, it) => s + it.qty * price(it.type), 0);
    const montant = Math.max(0, brut - (remise || 0));
    const depot = addDays(todayISO(), -daysAgo);
    const id = uid();
    await conn.query('INSERT INTO orders (id,num,agency_id,client_id,depot_date,due_date,status,prod_stage,remise,montant,paye,notes,created_at,livre_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, num, agencyId, clientId, depot, addDays(depot, 3), status, stage, remise || 0, montant, Math.round(montant * payRatio), '', depot, status === 'Livré' ? addDays(depot, 3) : null]);
    for (const it of items) {
      await conn.query('INSERT INTO order_items (order_id,type,qty,etat,prix_unit) VALUES (?,?,?,?,?)',
        [id, it.type, it.qty, it.etat || 'Normal', price(it.type)]);
    }
  }
  const it = (type, qty, etat) => ({ type, qty, etat });
  await mkOrder(A1,'c1',[it('Chemise',5),it('Pantalon',2)],1,'En cours','Lavage',1,0);
  await mkOrder(A1,'c2',[it('Costume 2 pièces',1),it('Chemise',3)],2,'En cours','Repassage',.5,0);
  await mkOrder(A1,'c3',[it('Robe',2,'Délicat'),it('Veste',1)],1,'Reçu','Réception',0,0);
  await mkOrder(A1,'c5',[it('Couette',1),it('Drap',2)],3,'Prêt','Prêt à livrer',1,500);
  await mkOrder(A1,'c1',[it('Jean',3),it('Pull',2)],6,'Livré','Livré',1,0);
  await mkOrder(A1,'c4',[it('Rideau',4)],5,'Livré','Livré',1,1000);
  await mkOrder(A1,'c3',[it('Boubou',2),it('Tailleur',1)],0,'Reçu','Réception',.3,0);
  await mkOrder(A1,'c5',[it('Chemise',8)],4,'Livré','Livré',1,0);
  await mkOrder(A2,'c6',[it('Costume 2 pièces',2)],1,'En cours','Séchage',.5,0);
  await mkOrder(A2,'c7',[it('Nappe',3),it('Drap',4)],2,'Prêt','Prêt à livrer',1,0);
  await mkOrder(A2,'c8',[it('Manteau',1),it('Veste',2)],3,'Livré','Livré',1,0);
  await conn.query('UPDATE settings SET v=? WHERE k=?', [String(seq), 'seq']);

  const employees = [
    [A1,'EMP-001','Ouattara','Salif','Responsable de production','0701234567','Cocody','2023-02-15',150000,'Actif'],
    [A1,'EMP-002','Coulibaly','Awa','Repasseuse','0555112233','Adjamé','2024-01-10',110000,'Actif'],
    [A1,'EMP-003','Kablan','Yves','Agent de réception','0508887766','Yopougon','2024-06-01',100000,'Actif'],
    [A2,'EMP-004','Sangaré','Mariam','Caissière','0544009988','Marcory','2023-09-20',120000,'Actif'],
    [A2,'EMP-005','Gnagne','Patrick','Livreur','0709998877','Koumassi','2022-11-05',95000,'Inactif']
  ];
  for (const e of employees) {
    await conn.query('INSERT INTO employees (id,agency_id,matricule,nom,prenom,poste,tel,adresse,embauche,salaire,statut) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [uid(), e[0], e[1], e[2], e[3], e[4], e[5], e[6], e[7], e[8], e[9]]);
  }

  const cats = ['Salaires','Lessive & produits','Loyer','Électricité','Eau','Emballages','Transport','Maintenance'];
  const amounts = [5000,12000,3000,8000,25000,4500];
  for (let i = 0; i < 14; i++) {
    await conn.query('INSERT INTO expenses (id,agency_id,date,categorie,libelle,montant) VALUES (?,?,?,?,?,?)',
      [uid(), i % 3 === 0 ? A2 : A1, addDays(todayISO(), -(i * 2)), cats[i % cats.length], cats[i % cats.length], amounts[i % amounts.length]]);
  }

  const stock = [
    [A1,'Lessive liquide (bidon 5L)','Lessive',12,5,'bidon'],
    [A1,'Assouplissant (5L)','Lessive',3,4,'bidon'],
    [A1,'Cintres plastique','Cintres',420,150,'pièce'],
    [A1,'Housses plastique','Emballages',80,100,'pièce'],
    [A1,'Sacs kraft','Emballages',250,100,'pièce'],
    [A2,'Détachant pro (1L)','Lessive',6,3,'flacon'],
    [A2,'Cintres bois','Cintres',60,80,'pièce']
  ];
  for (const s of stock) {
    await conn.query('INSERT INTO stock (id,agency_id,nom,categorie,qty,seuil,unite) VALUES (?,?,?,?,?,?,?)',
      [uid(), s[0], s[1], s[2], s[3], s[4], s[5]]);
  }
  console.log('✓ Données de démonstration insérées.');
}

main().catch(e => { console.error('Erreur init-db:', e.message); process.exit(1); });
