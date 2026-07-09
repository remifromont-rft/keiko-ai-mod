# Ketchup Compta — Note de découverte migration

> Application de **comptabilité en partie double** (française), mono-société, en PHP procédural « façon 2006 » + SQLite. Document destiné au cadrage de la migration. Toutes les références pointent vers le code réel (`legacy/`).

---

## 1. Glossaire métier (tel qu'il est réellement codé)

| Terme | Ce que c'est | Réalité technique | Où |
|---|---|---|---|
| **Écriture** (« pièce ») | Une opération comptable complète (ex. une facture). Toujours équilibrée. | Table réelle `entries` (en-tête). Statut toujours `posted`, n° type `VE2026-000001`. | `sql/01_schema.sql:44-55` |
| **Ligne** | Une ligne d'une écriture : un compte + un montant, au débit **ou** au crédit. | Table réelle `entry_lines`. | `sql/01_schema.sql:63-72` |
| **Compte** | Une case du plan comptable où l'on impute l'argent (ex. `411000 Clients`). | Table réelle `accounts` (code + libellé + actif/inactif). | `sql/01_schema.sql:23-28` |
| **Débit / Crédit** | Les deux « sens » d'un montant. Sur chaque ligne, un seul est renseigné. | Deux colonnes `debit` / `credit` (`REAL`). Le code ne porte aucun sens économique : juste deux montants dont les **totaux doivent s'égaler**. | `entry_lines.debit/credit` |
| **Journal** | Le classeur qui regroupe les écritures par nature : Ventes (VE), Achats (AC), Banque (BK), Divers (OD). Porte le compteur de numérotation. | Table réelle `journals`. | `sql/01_schema.sql:34-40` |
| **Grand livre** | Vue des mouvements et du solde compte par compte. | **PAS une table** : état recalculé à la volée. | `www/modules/reports/ledger.php` |
| **Balance** | Récapitulatif débit/crédit/solde par compte + contrôle d'équilibre global. | État calculé à la volée. | `www/modules/reports/trial_balance.php` |
| **Exercice** | La période comptable annuelle de la société. | Champs `company.fiscal_year_start/end` (+ `fiscal_year_closed` **jamais utilisé**). | `sql/01_schema.sql:13-19` |

**Principe central (partie double) :** chaque euro a une origine et une destination → pour toute écriture, **total débit = total crédit** (tolérance 0,01 €).

**À retenir :** écriture / ligne / compte / journal = **vraies tables** ; grand livre / balance / journal imprimé = **vues calculées** au moment de l'affichage (aucune table dédiée, une seule source de vérité = les écritures).

---

## 2. Les pages de l'application (par parcours utilisateur)

Chaque page inclut en tête le socle commun (`lib/db.php`, `lib/auth.php`, `lib/utils.php`, `header.php`…`footer.php`).

| # | Page | Rôle métier | Qui (usage *attendu*) | Dépend de | Migr. |
|---|---|---|---|---|---|
| 1 | `index.php` | Accueil public vitrine, sans connexion. | Visiteur | Fichier `VERSION` | **S** |
| 2 | `login.php` | Connexion, ouverture de session. | Tous | Table `users` (MD5+sel) | **S** |
| 3 | `dashboard.php` | Tableau de bord : exercice, nb d'écritures, dernières écritures. | Connectés | `entries`, `journals`, `users` | **S** |
| 4 | `modules/entries/list.php` | Parcourir / rechercher les écritures. | Comptable, Admin | `entries`, `journals`, `users` | **M** |
| 5 | `modules/entries/edit.php` | **Cœur métier** : saisir une pièce équilibrée ; en consultation, verrouillée. | Comptable, Admin | `entries`, `entry_lines`, `journals`, `accounts` + helpers | **L** |
| 6 | `modules/reports/journal.php` | État : journal comptable. | Tous connectés | `entries`, `journals`, `entry_lines`, `accounts` | **M** |
| 7 | `modules/reports/ledger.php` | État : grand livre (mouvements + totaux par compte). | Tous connectés | `entry_lines`, `entries`, `accounts`, `journals` | **M** |
| 8 | `modules/reports/trial_balance.php` | État : balance générale + contrôle d'équilibre. | Tous connectés | `accounts`, `entry_lines`, `entries` | **M** |
| 9 | `modules/setup/company.php` | Paramètres société + dates d'exercice (début < fin). | Admin | `company` (1 enregistrement) | **S** |
| 10 | `modules/setup/accounts.php` | Gérer le plan comptable + **import CSV**. | Admin | `accounts`, `entry_lines` (contrôle usage) | **L** |
| 11 | `modules/setup/journals.php` | Gérer les journaux et leur compteur. | Admin | `journals`, `entries` (contrôle usage) | **M** |
| 12 | `modules/admin/users.php` | Gérer les comptes utilisateurs. | Admin | `users`, `entries`, `audit_log` | **M** |
| 13 | `logout.php` | Déconnexion + trace. | Connectés | session, `audit_log` | **S** |
| 14 | `test_reset.php` | Recharge une base de test propre. **Outil de test, hors appli.** | Tests | recharge le schéma + données | **S** |

> ⚠️ La colonne « Qui » est l'usage *métier attendu*. **Aucun rôle n'est réellement contrôlé dans le code** : toute page ne fait que `require_login()`, donc tout connecté accède à tout.

### Le socle commun (à livrer en premier)
| Brique | Fichier | Pourquoi tout en dépend |
|---|---|---|
| Accès données | `www/lib/db.php` | Seule couche d'accès à la base (connexion + requêtes). |
| Auth / session | `www/lib/auth.php` | Connexion, `require_login()`, CSRF, journal d'audit. |
| Utilitaires | `www/lib/utils.php` | Lecture des saisies, échappement `h()`, formatage, flash, listes déroulantes, règles métier. |
| Layout / navigation | `www/header.php` + `www/footer.php` | Habillage, menu, messages, JavaScript communs. |

---

## 3. Ordre de migration proposé

Découpage en lots (le socle d'abord, puis des tranches verticales du plus simple au plus subtil) :

| Lot | Contenu | Pourquoi cet ordre |
|---|---|---|
| **0 — Socle** | Schéma + données (`sql/*`), accès base, auth/session, utilitaires, layout/navigation. | Rien ne fonctionne sans. Chaîne de dépendances : layout → auth + utils → données. |
| **1 — Référentiels** | Société, plan comptable, journaux (`setup/*`). | Données de base nécessaires avant toute écriture ; CRUD relativement simples (attention au CSV des comptes). |
| **2 — Cœur métier** | Saisie d'écriture (`entries/edit.php`) + liste (`entries/list.php`). | Concentre toutes les règles métier. **Le morceau le plus risqué → à traiter avec le plus de soin et de validation.** |
| **3 — États** | Grand livre, balance, journal (`reports/*`). | Dépendent des écritures ; à faire une fois la saisie fiable. Centraliser ici la logique d'agrégation (aujourd'hui dupliquée). |
| **4 — Administration** | Utilisateurs (`admin/users.php`), + décision sur les rôles. | Peut arriver tard ; occasion d'introduire un **vrai contrôle d'accès** (voir risque §Rôles). |

---

## 4. Principaux risques de migration

Zones où la logique est subtile, cachée, ou facile à casser en réécrivant.

1. **Règles cachées dans les déclencheurs de base** — `sql/03_triggers.sql:8-34`
   Plafond de **999 999,99 € par ligne**, interdiction de supprimer une écriture validée, horodatage auto. Invisibles depuis le code PHP → **facile de les perdre** en migrant. Le plafond n'a d'ailleurs aucun contrôle côté formulaire : dépassé, il plante en erreur SQL brute (`www/lib/db.php:143`) au lieu d'un message clair.

2. **Numérotation des pièces** — `www/lib/utils.php:256-274`
   L'année vient de **la date du jour** (pas de la date d'écriture) ; l'incrément est **non transactionnel** (risque de doublon en concurrence). Valeur légale/traçabilité → ne pas « améliorer » sans décision métier explicite.

3. **Montants en flottants + tolérance 0,01** — `www/lib/utils.php:279-282`, colonnes `REAL`
   Passer en décimal exact est souhaitable mais **change la sémantique** de l'équilibre. Migration flottant → décimal = changement de comportement silencieux à faire consciemment.

4. **Parsing « à la française »** — `www/lib/utils.php:88-124`
   Décimale à virgule, dates JJ/MM/AAAA ou AAAA-MM-JJ, et une saisie invalide devient **0 en silence** (pas une erreur). Un parseur « standard » casserait ces comportements.

5. **Fonctionnalités documentées mais absentes** — `legacy/CLAUDE.md`, `www/assets/js/app.js`, `company.fiscal_year_closed`
   Rôles/permissions, TVA, lettrage, rapprochement bancaire, clôture d'exercice : **évoqués mais non implémentés côté serveur**. Double piège : croire qu'une règle existe et la répliquer à tort, ou « implémenter utilement » une fonction qui n'a jamais existé.

**Règle de sécurité pour la migration :** traiter le **code exécuté** comme seule vérité (pas la doc ni le JS d'ébauche), et **faire valider chaque bizarrerie par le métier** avant de décider si on la conserve ou la corrige — jamais « nettoyer » en silence.

### Décisions métier à trancher
- **Contrôle d'accès / rôles** : à introduire (proposé : Admin / Comptable / Lecteur). Décidé : le capturer comme exigence du **système cible**, pas patcher le legacy.
- **Verrouillage d'exercice clôturé** : attendu ? Aujourd'hui absent → saisie possible à n'importe quelle date.
- **Plafond ~1 M€ par ligne** : garde-fou volontaire ou vestige arbitraire ?
- **TVA** : à implémenter dans la cible ou hors périmètre ?
