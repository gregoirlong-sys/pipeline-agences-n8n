// ──────────────────────────────────────────────────────────────
// Bilan des exécutions, lu depuis le journal
//
//   DATABASE_URL=postgres://... node scripts/voir-runs.mjs
//   DATABASE_URL=postgres://... node scripts/voir-runs.mjs --echecs
//
// C'est la vue qui compte après un run : ce qui est passé, ce qui a été
// écarté, ce qui a cassé et pourquoi. Sans elle, un pipeline est une boîte
// noire dont on ne sait dire ni ce qu'il a fait, ni ce qu'il a coûté.
// ──────────────────────────────────────────────────────────────

import pg from "pg";

const URL_BDD = process.env.DATABASE_URL;
if (!URL_BDD) {
  console.error("DATABASE_URL manquante.");
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: URL_BDD,
  ssl: { rejectUnauthorized: false },
  max: 2,
});

const detailEchecs = process.argv.includes("--echecs");

try {
  const { rows: runs } = await pool.query(`
    SELECT id, demarre_le, termine_le, declencheur, statut,
           nb_entrees, nb_retenus, nb_rejetes, nb_sautes, nb_echecs, cout_usd
    FROM pipeline_runs
    ORDER BY demarre_le DESC
    LIMIT 10
  `);

  if (runs.length === 0) {
    console.log("Aucune exécution enregistrée.");
    process.exit(0);
  }

  for (const r of runs) {
    const duree = r.termine_le
      ? `${Math.round((new Date(r.termine_le) - new Date(r.demarre_le)) / 1000)} s`
      : "en cours";
    console.log(`\n━━━ ${new Date(r.demarre_le).toLocaleString("fr-FR")} · ${r.declencheur} · ${duree} ━━━`);
    console.log(`  ${r.nb_entrees} entrée(s) : ${r.nb_retenus} retenue(s), ${r.nb_rejetes} rejetée(s), ${r.nb_sautes} sautée(s), ${r.nb_echecs} échec(s)`);
    console.log(`  Coût : ${Number(r.cout_usd).toFixed(4)} $  ·  statut : ${r.statut}`);

    const { rows: items } = await pool.query(
      `SELECT domaine, statut, score, entreprise, score_pourquoi, ligne_perso,
              etape_echec, erreur, duree_ms
       FROM pipeline_items WHERE run_id = $1 ORDER BY traite_le`,
      [r.id]
    );

    for (const i of items) {
      const marque = { ok: "✅", rejete: "➖", saute: "⏭️", echec: "❌" }[i.statut] ?? "??";
      const tete = `  ${marque} ${i.domaine.padEnd(26)}`;
      if (i.statut === "echec") {
        console.log(`${tete} [${i.etape_echec}] ${String(i.erreur).split("\n")[0].slice(0, 110)}`);
      } else if (i.statut === "saute") {
        console.log(`${tete} déjà traité lors d'un run précédent`);
      } else {
        console.log(`${tete} ${String(i.score).padStart(3)}/100  ${i.entreprise ?? ""}`);
        if (i.score_pourquoi) console.log(`       ${i.score_pourquoi}`);
        if (i.ligne_perso) console.log(`       « ${i.ligne_perso} »`);
      }
    }
  }

  if (detailEchecs) {
    const { rows } = await pool.query(
      `SELECT domaine, etape_echec, erreur, traite_le
       FROM pipeline_items WHERE statut = 'echec'
       ORDER BY traite_le DESC LIMIT 30`
    );
    console.log(`\n\n━━━ Dead letter (${rows.length}) ━━━`);
    for (const e of rows) {
      console.log(`  ${e.domaine} [${e.etape_echec}]`);
      console.log(`     ${String(e.erreur).split("\n")[0]}`);
    }
  }
} finally {
  await pool.end();
}
