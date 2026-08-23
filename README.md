# Presto Pressing — application full-stack (Node.js + MySQL)

Application de gestion de pressing : clients, commandes, suivi de production,
facturation, finances, employés, utilisateurs (rôles), stocks et multi-agences.
Données **partagées sur un serveur** (MySQL), authentification par mot de passe (JWT).

- **Backend** : Node.js + Express + MySQL (mysql2), JWT + bcrypt.
- **Frontend** : application web servie par le même serveur (`public/index.html`).
- Un seul service à déployer : le serveur Node sert l'API **et** l'interface.

---

## 1. Structure

```
presto-pressing/
├── server/
│   ├── server.js       # serveur Express (API + fichiers statiques) — point d'entrée
│   ├── db.js           # pool de connexions MySQL
│   ├── auth.js         # JWT + contrôle d'accès par rôle
│   ├── init-db.js      # crée les tables et (option --seed) les données de démo
│   └── schema.sql      # schéma MySQL (importable via phpMyAdmin)
├── public/
│   └── index.html      # interface complète (une seule page)
├── package.json
├── .env.example        # modèle de configuration (à copier en .env)
└── .gitignore
```

## 2. Comptes par défaut (À CHANGER après le 1er déploiement)

| Identifiant | Mot de passe   | Rôle                      |
|-------------|----------------|---------------------------|
| `admin`     | `admin123`     | Administrateur            |
| `caisse`    | `caisse123`    | Caissier                  |
| `reception` | `reception123` | Agent de réception        |
| `production`| `production123`| Responsable de production |

Chaque rôle ne voit que les modules autorisés. Changez ces mots de passe dans
le module **Utilisateurs** dès la première connexion.

## 3. Configuration (`.env`)

Copiez `.env.example` en `.env` et renseignez les valeurs (base MySQL créée dans
hPanel, et une clé `JWT_SECRET` longue et aléatoire) :

```
DB_HOST=localhost
DB_PORT=3306
DB_USER=uXXXXXX_presto
DB_PASSWORD=********
DB_NAME=uXXXXXX_presto
JWT_SECRET=une-longue-chaine-aleatoire-unique
PORT=3000
```

## 4. Installation / initialisation

```bash
npm install
npm run init-db     # crée les tables + comptes/tarifs/agence de base
# ou, pour aussi charger des données de démonstration :
npm run seed
npm start           # démarre le serveur sur $PORT
```

---

## 5. Déploiement sur Hostinger

> Node.js nécessite une offre compatible : **Hostinger Cloud** (outil « Setup
> Node.js App ») ou un **VPS**. L'hébergement mutualisé Premium/Business seul ne
> fait tourner que PHP — pour Node il faut Cloud ou VPS.

### A. Créer la base MySQL
hPanel → **Bases de données → MySQL** : créez une base + un utilisateur, notez
`nom de base`, `utilisateur`, `mot de passe`, `hôte` (souvent `localhost`).

### B. Pousser le code sur GitHub (KOFURB)
Créez le dépôt `presto-pressing` sous KOFURB puis poussez ces fichiers
(sans `node_modules` ni `.env`, déjà exclus par `.gitignore`).

### C. Option 1 — Hostinger Cloud (Setup Node.js App)
1. hPanel → **Avancé → Node.js** → *Créer une application*.
2. Version Node **18+**, **Application root** = dossier du dépôt, **Startup file** =
   `server/server.js`, et reliez le dépôt GitHub (branche `main`).
3. Ajoutez les **variables d'environnement** (`DB_HOST`, `DB_USER`,
   `DB_PASSWORD`, `DB_NAME`, `JWT_SECRET`) dans l'interface Node de hPanel.
4. Cliquez **Run NPM Install**, puis lancez `npm run seed` une fois via la
   console SSH (ou importez `server/schema.sql` dans phpMyAdmin puis lancez
   `npm run seed` pour créer les comptes avec mots de passe hachés).
5. **Démarrez** l'application, puis associez le sous-domaine
   `pressing.racekof.com` à cette application Node.
6. Activez le **SSL** du sous-domaine (obligatoire : le presse-papier et les
   notifications ne marchent qu'en HTTPS).

### C. Option 2 — VPS Hostinger
```bash
# sur le VPS (Ubuntu) :
sudo apt update && sudo apt install -y nodejs npm mysql-server
git clone https://github.com/KOFURB/presto-pressing.git
cd presto-pressing
cp .env.example .env && nano .env        # renseigner la base + JWT_SECRET
npm install
npm run seed
sudo npm install -g pm2
pm2 start server/server.js --name presto && pm2 save && pm2 startup
```
Puis nginx en reverse-proxy pour `pressing.racekof.com` → `http://localhost:3000`,
et `certbot` pour le certificat SSL.

### D. DNS
Si `racekof.com` est géré par Hostinger, le sous-domaine résout automatiquement.
Sinon, ajoutez un enregistrement **A** `pressing` → IP du serveur (ou un CNAME).

---

## 6. Sécurité — à faire en production
- Changez **tous** les mots de passe par défaut et `JWT_SECRET`.
- Gardez `.env` hors du dépôt (déjà dans `.gitignore`).
- Activez HTTPS.

## 7. Sauvegarde
Sauvegardez régulièrement la base MySQL (export phpMyAdmin ou `mysqldump`).
