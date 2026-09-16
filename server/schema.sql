-- =========================================================
--  Presto Pressing — schéma MySQL
--  Import possible via phpMyAdmin (hPanel Hostinger) ou `npm run init-db`
-- =========================================================
SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

CREATE TABLE IF NOT EXISTS agencies (
  id        VARCHAR(24)  NOT NULL PRIMARY KEY,
  name      VARCHAR(120) NOT NULL,
  ville     VARCHAR(160) DEFAULT NULL,
  tel       VARCHAR(60)  DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS users (
  id            VARCHAR(24)  NOT NULL PRIMARY KEY,
  nom           VARCHAR(120) NOT NULL,
  login         VARCHAR(60)  NOT NULL UNIQUE,
  role          VARCHAR(60)  NOT NULL,
  actif         TINYINT(1)   NOT NULL DEFAULT 1,
  password_hash VARCHAR(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS clients (
  id         VARCHAR(24)  NOT NULL PRIMARY KEY,
  agency_id  VARCHAR(24)  NOT NULL,
  nom        VARCHAR(120) NOT NULL,
  prenom     VARCHAR(120) NOT NULL,
  tel        VARCHAR(60)  DEFAULT NULL,
  email      VARCHAR(160) DEFAULT NULL,
  adresse    VARCHAR(200) DEFAULT NULL,
  points     INT          NOT NULL DEFAULT 0,
  created_at DATE         DEFAULT NULL,
  KEY idx_clients_agency (agency_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS orders (
  id         VARCHAR(24)  NOT NULL PRIMARY KEY,
  num        VARCHAR(40)  NOT NULL UNIQUE,
  agency_id  VARCHAR(24)  NOT NULL,
  client_id  VARCHAR(24)  DEFAULT NULL,
  depot_date DATE         DEFAULT NULL,
  due_date   DATE         DEFAULT NULL,
  status     VARCHAR(40)  NOT NULL DEFAULT 'Reçu',
  prod_stage VARCHAR(40)  NOT NULL DEFAULT 'Réception',
  remise     INT          NOT NULL DEFAULT 0,
  montant    INT          NOT NULL DEFAULT 0,
  paye       INT          NOT NULL DEFAULT 0,
  notes      TEXT,
  created_at DATE         DEFAULT NULL,
  livre_at   DATE         DEFAULT NULL,
  KEY idx_orders_agency (agency_id),
  KEY idx_orders_client (client_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS order_items (
  id        INT AUTO_INCREMENT PRIMARY KEY,
  order_id  VARCHAR(24) NOT NULL,
  type      VARCHAR(80) NOT NULL,
  qty       INT         NOT NULL DEFAULT 1,
  etat      VARCHAR(40) DEFAULT 'Normal',
  prix_unit INT         NOT NULL DEFAULT 0,
  prestation VARCHAR(20) DEFAULT 'Nettoyage',
  KEY idx_items_order (order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS employees (
  id        VARCHAR(24)  NOT NULL PRIMARY KEY,
  agency_id VARCHAR(24)  NOT NULL,
  matricule VARCHAR(40)  DEFAULT NULL,
  nom       VARCHAR(120) NOT NULL,
  prenom    VARCHAR(120) NOT NULL,
  poste     VARCHAR(120) DEFAULT NULL,
  tel       VARCHAR(60)  DEFAULT NULL,
  adresse   VARCHAR(200) DEFAULT NULL,
  embauche  DATE         DEFAULT NULL,
  salaire   INT          NOT NULL DEFAULT 0,
  statut    VARCHAR(20)  NOT NULL DEFAULT 'Actif',
  KEY idx_emp_agency (agency_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS expenses (
  id        VARCHAR(24) NOT NULL PRIMARY KEY,
  agency_id VARCHAR(24) NOT NULL,
  date      DATE        DEFAULT NULL,
  categorie VARCHAR(80) DEFAULT NULL,
  libelle   VARCHAR(200) DEFAULT NULL,
  montant   INT         NOT NULL DEFAULT 0,
  KEY idx_exp_agency (agency_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS stock (
  id        VARCHAR(24)  NOT NULL PRIMARY KEY,
  agency_id VARCHAR(24)  NOT NULL,
  nom       VARCHAR(160) NOT NULL,
  categorie VARCHAR(80)  DEFAULT NULL,
  qty       INT          NOT NULL DEFAULT 0,
  seuil     INT          NOT NULL DEFAULT 0,
  unite     VARCHAR(40)  DEFAULT NULL,
  KEY idx_stock_agency (agency_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tarifs (
  type VARCHAR(80) NOT NULL PRIMARY KEY,
  prix INT         NOT NULL DEFAULT 0,
  prix_repassage INT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS settings (
  k VARCHAR(60)  NOT NULL PRIMARY KEY,
  v VARCHAR(255) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;
