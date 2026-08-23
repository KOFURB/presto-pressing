'use strict';
const jwt = require('jsonwebtoken');
require('dotenv').config();

const SECRET = process.env.JWT_SECRET || 'change-me-please';
const EXPIRES = '12h';

// Modules accessibles par rôle (doit rester aligné avec le frontend)
const ROLE_ACCESS = {
  'Administrateur': ['dashboard','clients','commandes','production','facturation','finances','employes','utilisateurs','stocks','parametres'],
  'Caissier': ['dashboard','clients','commandes','facturation'],
  'Agent de réception': ['dashboard','clients','commandes','production'],
  'Responsable de production': ['dashboard','production','commandes','stocks']
};

function sign(user) {
  return jwt.sign({ id: user.id, login: user.login, role: user.role, nom: user.nom }, SECRET, { expiresIn: EXPIRES });
}

function authRequired(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentification requise' });
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Session expirée, reconnectez-vous' });
  }
}

// Autorise si le rôle a accès au module donné
function requireModule(mod) {
  return (req, res, next) => {
    const allowed = ROLE_ACCESS[req.user.role] || [];
    if (!allowed.includes(mod)) return res.status(403).json({ error: 'Accès refusé pour votre rôle' });
    next();
  };
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'Administrateur') return res.status(403).json({ error: 'Réservé à l\'administrateur' });
  next();
}

module.exports = { sign, authRequired, requireModule, requireAdmin, ROLE_ACCESS, SECRET };
