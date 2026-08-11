// ──────────────────────────────────────────────────────────────
// Remet des domaines dans la file, pour qu'un prochain run les retraite
//
//   node scripts/rejouer.mjs devflows.eu flowt.fr
//   node scripts/rejouer.mjs --echecs          # tous ceux en dead letter
//   node scripts/rejouer.mjs devflows.eu --dry-run
//
// L'idempotence est une bonne chose jusqu'au jour où l'on veut justement
// retraiter quelque chose : prompt corrigé, seuil déplacé, site qui était en
// panne. C'est le pendant nécessaire de la clé d'idempotence.
//
// Deux effets :
//   1. la fiche Notion créée pour ce domaine est ARCHIVÉE (corbeille Notion,
//      réversible) — sinon le prochain run crée un doublon
//   2. les lignes du journal pour ce domaine sont effacées, ce qui lève
//      l'idempotence
//
// Requiert DATABASE_URL et NOTION_TOKEN.
// ──────────────────────────────────────────────────────────────

import pg from "pg";

const URL_BDD = process.env.DATABASE_URL;
const NOTION = process.env.NOTION_TOKEN;

if (!URL_BDD) {
  console.error("DATABASE_URL manquante.");
  process.exit(1);
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const tousLesEchecs = args.includes("--echecs");
const domaines = args.filter((a) => !a.startsWith("--")).map((d) =>
  d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "")
);

if (domaines.length === 0 && !tousLesEchecs) {
  console.error("Usage : node scripts/rejouer.mjs [--dry-run] domaine1.fr [domaine2.com ...]");
  console.error("        node scripts/rejouer.mjs --echecs");
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: URL_BDD,
  ssl: { rejectUnauthorized: false },
  max: 2,
});

try {
  const { rows: cibles } = tousLesEchecs
    ? await pool.query(
        `SELECT DISTINCT domaine, notion_page_id, statut FROM pipeline_items WHERE statut = 'echec'`
      )
    : await pool.query(
        `SELECT domaine, notion_page_id, statut FROM pipeline_items WHERE domaine = ANY($1::text[])`,
        [domaines]
      );

  if (cibles.length === 0) {
    console.log("Aucune trace en journal pour ces domaines : ils seront traités au prochain run.");
    process.exit(0);
  }

  const aArchiver = cibles.filter((c) => c.notion_page_id);
  const listeDomaines = [...new Set(cibles.map((c) => c.domaine))];

  console.log(`${listeDomaines.length} domaine(s) : ${listeDomaines.join(", ")}`);
  console.log(`${cibles.length} ligne(s) de journal, ${aArchiver.length} fiche(s) Notion à archiver.`);

  if (dryRun) {
    console.log("\n--dry-run : rien n'a été modifié.");
    process.exit(0);
  }

  // Notion d'abord : si l'archivage échoue, on garde la trace en journal et
  // l'idempotence continue de protéger contre le doublon. L'inverse laisserait
  // une fiche orpheline que le prochain run dupliquerait.
  for (const c of aArchiver) {
    if (!NOTION) {
      console.warn(`⚠️  NOTION_TOKEN absent : fiche de ${c.domaine} NON archivée (risque de doublon).`);
      continue;
    }
    const r = await fetch(`https://api.notion.com/v1/pages/${c.notion_page_id}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${NOTION}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ archived: true }),
    });
    if (r.ok) console.log(`  🗑️  ${c.domaine} : fiche archivée (récupérable dans la corbeille Notion)`);
    else {
      const d = await r.json().catch(() => ({}));
      console.error(`  ❌ ${c.domaine} : archivage refusé (${d.message ?? r.status}) — ligne conservée`);
      const i = listeDomaines.indexOf(c.domaine);
      if (i !== -1) listeDomaines.splice(i, 1);
    }
  }

  if (listeDomaines.length === 0) {
    console.log("\nRien à effacer : aucun domaine n'a pu être remis en file.");
    process.exit(1);
  }

  const { rowCount } = await pool.query(
    `DELETE FROM pipeline_items WHERE domaine = ANY($1::text[])`,
    [listeDomaines]
  );
  console.log(`\n✅ ${rowCount} ligne(s) effacée(s). Ces domaines seront retraités au prochain run.`);
} finally {
  await pool.end();
}
