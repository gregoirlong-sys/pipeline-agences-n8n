// ──────────────────────────────────────────────────────────────
// Rejoue la logique du pipeline sur un domaine, hors n8n
//
//   ANTHROPIC_API_KEY=sk-... node scripts/tester-analyse.mjs exemple.fr
//
// Même extraction, même prompt, même schéma que le workflow. Sert à deux
// choses : vérifier une modification du prompt sans relancer n8n, et
// diagnostiquer un domaine qui part en dead letter.
// ──────────────────────────────────────────────────────────────

const MODELE = process.env.MODELE ?? "claude-haiku-4-5";
const CLE = process.env.ANTHROPIC_API_KEY;

const args = process.argv.slice(2);
// --extraction-seule : scrape et nettoie sans appeler l'API. Sert à vérifier
// qu'un domaine est exploitable avant de dépenser, et à diagnostiquer les
// échecs d'extraction sans clé sous la main.
const extractionSeule = args.includes("--extraction-seule") || !CLE;
const domaines = args.filter((a) => !a.startsWith("--"));

if (domaines.length === 0) {
  console.error("Usage : node scripts/tester-analyse.mjs [--extraction-seule] domaine1.fr [domaine2.com ...]");
  process.exit(1);
}

if (extractionSeule && !CLE) {
  console.log("ℹ️  ANTHROPIC_API_KEY absente — mode extraction seule.\n");
}

const ICP = `CIBLE IDÉALE (ICP)
- Agence d'automatisation, de no-code ou d'IA, entre 2 et 15 personnes, dirigée par son fondateur.
- Vend de la prestation à des clients finaux (elle a donc du flux à absorber), en n8n, Make, Zapier, agents IA, intégrations API, chatbots.
- Signaux de charge : blog ou contenu récent, offres d'emploi ouvertes, mention de délais ou de capacité, page « nous recrutons ».
- Bonus : francophone (France, Suisse, Belgique), équipe distribuée ou remote-friendly.

HORS CIBLE (score bas)
- Structure de plus de 25 personnes avec un process achat formalisé.
- Agence purement SEO, rédaction, design ou publicité, sans automatisation ni IA.
- Éditeur de SaaS qui vend son produit et ne fait pas de prestation.
- Site vitrine sans activité visible, page en construction, société manifestement dormante.`;

const SCHEMA = {
  type: "object",
  properties: {
    entreprise: { type: "string" },
    ville: { type: "string" },
    resume: { type: "string" },
    signaux: { type: "array", items: { type: "string" } },
    score: { type: "integer" },
    score_pourquoi: { type: "string" },
    ligne_perso: { type: "string" },
  },
  required: ["entreprise", "ville", "resume", "signaux", "score", "score_pourquoi", "ligne_perso"],
  additionalProperties: false,
};

const SYSTEM = `Tu qualifies des agences pour une campagne de sous-traitance B2B. On vend de la capacité de livraison technique à des agences en surcharge — pas une prestation à des clients finaux.

${ICP}

RÈGLES DE NOTATION (0 à 100)
- 80-100 : correspond à la cible idéale sur tous les points, avec des signaux de charge visibles.
- 60-79  : agence pertinente, mais un critère manque ou reste incertain.
- 30-59  : activité voisine, sans automatisation ni IA au cœur de l'offre.
- 0-29   : hors cible.

RÈGLES DE RÉDACTION DE ligne_perso
- Une à deux phrases, vouvoiement, écrites pour ouvrir un email à froid.
- Elles doivent citer un élément CONCRET et VÉRIFIABLE lu sur le site : une offre nommée, un secteur servi, un outil mentionné, un parti pris affiché.
- Interdit : la flatterie ("j'adore votre travail"), les généralités applicables à n'importe quelle agence, et toute invention. Si le site ne dit rien de précis, écris une phrase neutre et baisse le score.

RÈGLE ABSOLUE : tu ne décris que ce qui est présent dans le texte fourni. Aucune donnée venue d'ailleurs, aucune supposition. Si l'information manque, mets une chaîne vide.`;

function normaliser(entree) {
  return String(entree)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "");
}

// Les entites doivent etre decodees partout, titre et meta compris : sans ca
// le modele lit "C&#x27;est quoi un agent IA" et peut recopier la sequence
// telle quelle dans la ligne de personnalisation envoyee au prospect.
function decoderEntites(s) {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&"); // en dernier, sinon on decode deux fois
}

function extraireTexte(html) {
  return decoderEntites(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

async function analyser(domaineBrut) {
  const domaine = normaliser(domaineBrut);
  const t0 = Date.now();

  const reponse = await fetch(`https://${domaine}`, {
    headers: {
      // Un header HTTP doit rester en ASCII pur : un tiret cadratin ici fait
      // echouer la requete cote client, avant meme le reseau.
      "User-Agent":
        "NoriaxPipeline/1.0 (+https://noriax.fr; qualification B2B; contact gregoire@noriax.fr)",
      Accept: "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!reponse.ok) throw new Error(`HTTP ${reponse.status}`);

  const html = await reponse.text();
  const titre = decoderEntites(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim();
  const description = decoderEntites(
    html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i)?.[1] ?? ""
  ).trim();
  const texte = extraireTexte(html).slice(0, 6000);

  if (texte.length < 200) {
    throw new Error(`Contenu insuffisant (${texte.length} caractères) — rendu JS ou mur anti-bot.`);
  }

  if (extractionSeule) {
    return {
      domaine,
      extraction_seule: true,
      titre,
      description,
      texte_extrait: texte.length,
      html_brut: html.length,
      apercu: texte.slice(0, 220),
      cout_usd: 0,
      duree_ms: Date.now() - t0,
    };
  }

  const api = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": CLE,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODELE,
      max_tokens: 1024,
      system: SYSTEM,
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
      messages: [
        {
          role: "user",
          content: `Domaine : ${domaine}\nTitre de la page : ${titre}\nMeta description : ${description}\n\nTexte du site :\n${texte}`,
        },
      ],
    }),
  });

  const data = await api.json();
  if (!api.ok) throw new Error(`API ${api.status} : ${data.error?.message ?? JSON.stringify(data)}`);

  const a = JSON.parse(data.content[0].text);
  const { input_tokens: tin = 0, output_tokens: tout = 0 } = data.usage ?? {};

  return {
    ...a,
    domaine,
    tokens: `${tin} in / ${tout} out`,
    cout_usd: Number(((tin / 1e6) * 1 + (tout / 1e6) * 5).toFixed(5)),
    duree_ms: Date.now() - t0,
    texte_extrait: texte.length,
  };
}

let coutTotal = 0;
for (const d of domaines) {
  try {
    const r = await analyser(d);
    coutTotal += r.cout_usd;
    console.log(`\n━━━ ${r.domaine} ━━━`);
    if (r.extraction_seule) {
      const ratio = ((r.texte_extrait / r.html_brut) * 100).toFixed(1);
      console.log(`  Titre   : ${r.titre || "(absent)"}`);
      console.log(`  Meta    : ${r.description || "(absente)"}`);
      console.log(`  Extrait : ${r.texte_extrait} car. utiles sur ${r.html_brut} de HTML (${ratio} %)`);
      console.log(`  Aperçu  : ${r.apercu}…`);
      console.log(`  [${r.duree_ms} ms]`);
      continue;
    }
    console.log(`  ${r.entreprise}${r.ville ? ` — ${r.ville}` : ""}`);
    console.log(`  Score      : ${r.score}/100 — ${r.score_pourquoi}`);
    console.log(`  Résumé     : ${r.resume}`);
    console.log(`  Signaux    : ${r.signaux.join(" · ") || "aucun"}`);
    console.log(`  Ligne perso: ${r.ligne_perso}`);
    console.log(
      `  [${r.texte_extrait} car. extraits · ${r.tokens} · ${r.cout_usd} $ · ${r.duree_ms} ms]`
    );
  } catch (e) {
    console.log(`\n━━━ ${normaliser(d)} ━━━`);
    console.log(`  ❌ ÉCHEC — ${e.message}`);
  }
}
console.log(`\nCoût total du test : ${coutTotal.toFixed(5)} $`);
