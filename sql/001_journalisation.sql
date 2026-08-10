-- ──────────────────────────────────────────────────────────────
-- Journalisation du pipeline d'enrichissement & scoring
--
-- Deux tables, trois usages :
--   1. journal d'exécution   → on sait ce qui s'est passé, et quand
--   2. dead letter           → les lignes en échec sont conservées avec leur
--                              erreur, donc rejouables sans relancer le run entier
--   3. source d'idempotence  → un domaine déjà traité avec succès n'est jamais
--                              re-scrapé ni re-facturé à l'API
--
-- À jouer une fois sur la base Postgres (Supabase) :
--   psql "$DATABASE_URL" -f sql/001_journalisation.sql
-- ──────────────────────────────────────────────────────────────

-- ── Un run = une exécution du workflow ────────────────────────

CREATE TABLE IF NOT EXISTS pipeline_runs (
  id             TEXT PRIMARY KEY,              -- uuid généré par n8n au démarrage
  demarre_le     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  termine_le     TIMESTAMPTZ,
  declencheur    TEXT NOT NULL DEFAULT 'manuel', -- manuel | webhook | planifie
  nb_entrees     INTEGER NOT NULL DEFAULT 0,     -- domaines soumis
  nb_retenus     INTEGER NOT NULL DEFAULT 0,     -- score >= seuil, écrits dans Notion
  nb_rejetes     INTEGER NOT NULL DEFAULT 0,     -- score < seuil, hors cible
  nb_sautes      INTEGER NOT NULL DEFAULT 0,     -- déjà traités (idempotence)
  nb_echecs      INTEGER NOT NULL DEFAULT 0,     -- dead letter
  cout_usd       NUMERIC(10, 4) NOT NULL DEFAULT 0,
  statut         TEXT NOT NULL DEFAULT 'en_cours' -- en_cours | termine | interrompu
);

-- ── Un item = un domaine passé dans le pipeline ───────────────

CREATE TABLE IF NOT EXISTS pipeline_items (
  id             BIGSERIAL PRIMARY KEY,
  run_id         TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  domaine        TEXT NOT NULL,                 -- clé d'idempotence, normalisée (sans www, minuscules)
  traite_le      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- ok       : retenu et écrit dans Notion
  -- rejete   : analysé mais score sous le seuil
  -- saute    : déjà traité lors d'un run précédent
  -- echec    : dead letter, voir etape_echec + erreur
  statut         TEXT NOT NULL,
  etape_echec    TEXT,                          -- scrape | analyse | validation | notion
  erreur         TEXT,

  -- Résultat de l'analyse (NULL si l'item n'est jamais arrivé jusque-là)
  entreprise     TEXT,
  score          INTEGER,                       -- 0-100
  score_pourquoi TEXT,
  resume         TEXT,
  ligne_perso    TEXT,
  ville          TEXT,
  notion_page_id TEXT,

  duree_ms       INTEGER,
  tokens_in      INTEGER,
  tokens_out     INTEGER
);

-- ── Index ─────────────────────────────────────────────────────

-- L'idempotence interroge ce couple à chaque item : sans index, le pipeline
-- ralentit linéairement à mesure que l'historique grossit.
CREATE INDEX IF NOT EXISTS idx_items_domaine_statut
  ON pipeline_items (domaine, statut);

CREATE INDEX IF NOT EXISTS idx_items_run
  ON pipeline_items (run_id, traite_le DESC);

-- Rejouer la dead letter d'un run : SELECT ... WHERE statut = 'echec'
CREATE INDEX IF NOT EXISTS idx_items_echecs
  ON pipeline_items (statut, traite_le DESC)
  WHERE statut = 'echec';

CREATE INDEX IF NOT EXISTS idx_runs_demarre
  ON pipeline_runs (demarre_le DESC);
