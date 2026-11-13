# HyperWeave

HyperWeave archive localement le contexte d’un développement : événements, messages,
actions observées et versions de fichiers. Il permet de comparer des checkpoints,
de reconstruire leurs fichiers dans un nouveau dossier et de préparer un contexte
de reprise déterministe. Son cœur fonctionne sans Cursor, sans LLM, sans compte
et sans accès réseau après installation.

La version 0.2 est un **incrément fonctionnel consolidé**, pas le MVP complet décrit
dans [la spécification](docs/SPECIFICATION.fr.md). L’extension Cursor reste à réaliser.

## Démarrage sans Cursor

Prérequis validés : Linux x64, Node.js **24.22.1**, npm 11.9.0. SQLite intégré à Node
(3.53.4 sur la machine de validation). TypeScript et ses types sont uniquement des
dépendances de développement ; leurs versions exactes et intégrités sont verrouillées.

```sh
npm ci
npm test
npm run demo
npm run pack:check
```

Dans l’environnement cloud où le cache utilisateur n’est pas accessible :
`npm ci --cache /workspace/.npm-cache`.

La démonstration passe par la vraie CLI et le daemon. Elle crée V0, ingère un prompt
synthétique, modifie deux fichiers, ingère un résultat synthétique avec pièce jointe, suit son action, crée V1, compare,
matérialise V0, crée une variante et son contexte, puis exporte, importe, restaure et
sauvegarde. Elle affiche le dossier temporaire conservé pour inspection.

## Utilisation manuelle

```sh
npm run build
# Terminal 1 : un propriétaire unique de cette archive
node dist/packages/cli/src/index.js daemon --archive /tmp/hyperweave-data

# Terminal 2
node dist/packages/cli/src/index.js init --archive /tmp/hyperweave-data \
  --name MonProjet --root /chemin/du/projet --json
node dist/packages/cli/src/index.js workspace add --archive /tmp/hyperweave-data \
  --project ID_PROJET --root /chemin/du/projet --json
node dist/packages/cli/src/index.js coverage --archive /tmp/hyperweave-data --workspace ID_WORKSPACE
node dist/packages/cli/src/index.js checkpoint create --archive /tmp/hyperweave-data \
  --workspace ID_WORKSPACE --mode strict --json
node dist/packages/cli/src/index.js materialize --archive /tmp/hyperweave-data \
  --checkpoint ID_CHECKPOINT --target /chemin/nouveau-dossier
node dist/packages/cli/src/index.js --help
```

Sans daemon, ajouter `--offline` à chaque commande : chaque invocation prend le même
verrou exclusif. Arrêter le daemon avant de passer à ce mode. Les identifiants affichés
sont à réutiliser dans les commandes suivantes. La cible de matérialisation doit être
absente ; aucun fichier existant n’est écrasé. Les sorties `--json` sont versionnées.
Codes de sortie : 0 succès, 2 requête/conflit/intégrité, 3 verrou occupé/daemon absent.

## Fonctions livrées

- Événements immuables, lots atomiques, déduplication par producteur/epoch/séquence,
  parents causaux en attente et rejet des cycles lorsqu’ils deviennent résolus.
- Checkpoints avec blobs SQLite dédupliqués SHA-256, publication transactionnelle,
  contrôle de stabilité répété, modes strict/partiel et qualité observed/quiescent.
- Capture Git ou dossier simple, binaires/CRLF/Unicode, bit exécutable, exclusions
  explicites ; diff de chemins et hashes, matérialisation dans un nouveau dossier.
- Timelines, contexte historique borné en octets, recherche textuelle paginée,
  export/import autonome dans une archive vide, backup SQLite et vérification.
- Pièces jointes de 2 Mio au maximum, recherche dans leurs textes, actions persistées
  avec événements et checkpoints associés, liens de provenance ajoutés sans modifier les sources.
- Daemon Unix avec worker propriétaire de SQLite, statut accessible pendant les scans,
  file bornée et arrêt propre ; outbox testée avec producteurs concurrents et interruptions.
- Reçus durables de checkpoint via `--operation ID` : une retransmission identique
  retrouve le checkpoint déjà publié, même après redémarrage.
- Migration transactionnelle des archives 0.1, lecture des exports v1 et exports v2.

## Paquet installable

`npm run pack:check` fabrique un paquet temporaire, l’installe hors ligne dans un dossier
vierge sans dépendances de développement, puis vérifie CLI, daemon et restauration.
Pour conserver un paquet : `npm pack --pack-destination /tmp`, puis
`npm install --offline --ignore-scripts /tmp/hyperweave-0.2.0.tgz` dans un projet séparé.
Le binaire installé est `hyperweave`. Aucune publication npm n’est effectuée.

## Événements enrichis

Le transport reste en version 1. Les nouveaux événements utilisent `schema_version:2` ;
les événements v1 restent lisibles et retransmissibles. Pour les résultats volumineux :

```sh
node dist/packages/cli/src/index.js attachment add --archive /tmp/hyperweave-data \
  --input /chemin/resultat.txt --type text/plain --json
```

Réutiliser le hash retourné dans `payload.attachment_hash` d’un message v2 ou dans
`payload.attachments` d’un résultat v2. Les références doivent exister avant ingestion.
`action get --session ID --action ID`, `provenance list --checkpoint ID` et
`operation get --operation ID` exposent les associations et les reçus. Le contexte
inclut les pièces jointes textuelles entières lorsqu’elles tiennent dans son budget,
et indique les omissions autrement. Aucun texte archivé n’est exécuté.

## Limites importantes

La capture n’est pas un snapshot global du filesystem. `quiescent` demande que
l’appelant ait arrêté les écrivains connus (`--cooperating`). Les restaurations ne
rétablissent ni processus, ni dépendances exclues, ni base externe, ni conversation
interne à Cursor. Les transcripts restent des données ; aucun contenu archivé
n’est exécuté ou envoyé automatiquement à un LLM.

Linux est la seule plateforme validée. Symlinks et fichiers spéciaux sont rejetés
ou explicitement omis. Les répertoires vides, ACL, propriétaires et dates de fichiers
ne sont pas archivés. La politique de noms est volontairement conservatrice.
Les règles d’exclusion ne constituent pas une détection exhaustive de secrets.

Voir [architecture](docs/architecture.md), [protocole](docs/protocol.md),
[capture/restauration](docs/capture.md), [récupération](docs/recovery.md),
[adaptateur synthétique](docs/adapters.md), [compatibilité Cursor](extensions/cursor/README.md),
[mesures](docs/benchmark.md) et [état de reprise](docs/STATUS.md).
