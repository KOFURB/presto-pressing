# Presto Pressing

Application web de gestion de pressing (clients, commandes, suivi de production,
facturation, finances, employés, utilisateurs, stocks, multi-agences).

Application **100 % statique** : un seul fichier `index.html` autonome.
Les données sont enregistrées dans le navigateur de chaque poste (localStorage).

## Déploiement (Hostinger — Git intégré)
1. Sous-domaine `pressing.racekof.com` créé dans hPanel.
2. hPanel → Avancé → GIT → dépôt `https://github.com/KOFURB/presto-pressing.git`,
   branche `main`, dossier = celui du sous-domaine.
3. Cliquer sur **Déployer**, puis activer le SSL du sous-domaine.

Aucune étape de build : le contenu du dépôt est copié tel quel dans le dossier web.
