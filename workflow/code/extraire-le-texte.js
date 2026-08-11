// n8n:node Extraire le texte
// Fichier généré — édité librement, puis « node scripts/code-workflow.mjs injecter ».

// ── Extraction du texte utile ─────────────────────────────────
//
// Un site d'agence, c'est 200 à 400 ko de HTML dont 2 % de texte. On envoie à
// Claude uniquement ce qui porte du sens : sans ce nettoyage, on paierait
// 50 fois le prix pour un résultat moins bon (le modèle se noie dans le CSS).
//
// On construit ici la requête HTTP complète, schéma JSON compris : le nœud
// suivant ne fait que l'envoyer. Ça évite le cauchemar d'échappement des
// expressions imbriquées et garde le prompt lisible et versionnable.

const config  = $('Configuration').first().json;
const source  = $('Boucle par domaine').item.json;
const html    = String($json.data ?? $json.body ?? '');

// Les entités doivent être décodées partout, titre et meta compris. Sans ça
// le modèle lit « C&#x27;est quoi un agent IA » et peut recopier la séquence
// telle quelle dans la ligne de personnalisation envoyée au prospect.
function decoderEntites(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&'); // en dernier, sinon on décode deux fois
}

function extraireTexte(html) {
  return decoderEntites(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim();
}

const titre       = decoderEntites(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim();
const description = decoderEntites(html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i)?.[1] ?? '').trim();
const texte       = extraireTexte(html).slice(0, 6000);

// Garde-fou : une page vide (JS-only, mur anti-bot, 200 sur une page blanche)
// ne doit pas partir à l'analyse — on facturerait un appel pour rien et le
// modèle inventerait une entreprise à partir de trois mots.
if (texte.length < 200) {
  throw new Error(`Contenu exploitable insuffisant (${texte.length} caractères) — page probablement rendue en JavaScript ou protégée.`);
}

const schema = {
  type: 'object',
  properties: {
    entreprise:     { type: 'string' },
    ville:          { type: 'string' },
    resume:         { type: 'string' },
    signaux:        { type: 'array', items: { type: 'string' } },
    score:          { type: 'integer' },
    score_pourquoi: { type: 'string' },
    ligne_perso:    { type: 'string' },
  },
  required: ['entreprise', 'ville', 'resume', 'signaux', 'score', 'score_pourquoi', 'ligne_perso'],
  additionalProperties: false,
};

const system = `Tu qualifies des agences pour une campagne de sous-traitance B2B. On vend de la capacité de livraison technique à des agences en surcharge — pas une prestation à des clients finaux.

${config.icp}

RÈGLES DE NOTATION (0 à 100)
- 80-100 : correspond à la cible idéale sur tous les points, avec des signaux de charge visibles.
- 60-79  : agence pertinente, mais un critère manque ou reste incertain.
- 30-59  : activité voisine, sans automatisation ni IA au cœur de l'offre.
- 0-29   : hors cible.

RÈGLES DE RÉDACTION DE ligne_perso

Cette phrase a UN SEUL travail : prouver que le site a été lu. Elle ne vend rien. Le reste de l'email s'en charge.

- Une phrase, deux au maximum. Vouvoiement.
- Elle cite un élément CONCRET et VÉRIFIABLE lu sur le site : une offre nommée, un secteur servi, un outil mentionné, un parti pris affiché.
- Écris à la première personne du SINGULIER, ou sans sujet du tout. JAMAIS "nous", "notre équipe", "nos experts" : l'expéditeur est un freelance seul, et une agence qui lit "nous" chez un indépendant le remarque aussitôt.
- INTERDIT : toute proposition commerciale ("nous pourrions discuter", "je peux absorber votre surcharge", "voici ce que je propose"), la flatterie ("j'adore votre travail"), les généralités valables pour n'importe quelle agence, et toute invention.
- Si le site ne dit rien de précis, écris une phrase neutre et baisse le score.
- Ponctuation : jamais de tiret cadratin ni de flèche. Ce sont des signatures d'écriture automatique, immédiatement reconnues par des fondateurs techniques. Utilise les deux-points, la virgule, le point ou la parenthèse.

EXEMPLES
- BON   : "Vous intervenez sur du n8n et du Make pour des PME industrielles, avec un audit gratuit en entrée."
- MAUVAIS : "Nous pourrions discuter de la façon dont nous absorbons vos surcharges." (dit "nous", et vend)
- MAUVAIS : "J'admire beaucoup la qualité de votre travail sur l'automatisation." (flatte, ne prouve aucune lecture)

RÈGLE POUR score_pourquoi
- Une seule phrase, 30 mots maximum. C'est un repère de tri, pas une note d'analyse.

RÈGLE ABSOLUE : tu ne décris que ce qui est présent dans le texte fourni. Aucune donnée venue d'ailleurs, aucune supposition. Si l'information manque, mets une chaîne vide.`;

const contenu = `Domaine : ${source.domaine}\nTitre de la page : ${titre}\nMeta description : ${description}\n\nTexte du site :\n${texte}`;

return [{
  json: {
    run_id:  source.run_id,
    domaine: source.domaine,
    demarre_a: Date.now(),
    corps_requete: {
      model: config.modele,
      max_tokens: 1024,
      system,
      // Sortie structurée : le schéma est appliqué côté API, donc le JSON reçu
      // est valide par construction. Pas de parsing défensif, pas de retry
      // sur JSON malformé — toute une classe de bugs disparaît.
      output_config: { format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content: contenu }],
    },
  },
}];
