# État de reprise — version 0.2

## Livré et vérifié

Le cœur sans Cursor dispose maintenant d’un daemon à worker propriétaire de SQLite.
Une capture de 128 Mio est exercée pendant des demandes de statut et de backpressure.
Le statut expose sa fraîcheur et l’opération en cours ; les opérations restent sérialisées.

Ajouts de cette tranche : pièces jointes de 2 Mio, références vérifiées, recherche dans
les textes et inclusion bornée dans le contexte, projections persistées des actions,
parents en attente, événements tardifs/conflits explicites, liens de provenance immuables,
reçus idempotents de checkpoint, pagination sessions/actions/history, exports v2 et
migration transactionnelle du schéma v1. Les événements v1 et exports v1 restent lisibles.
Les backups/exports publient un fichier complet sans remplacer de cible existante.

Commandes de reproduction :

```sh
npm ci --ignore-scripts --cache /workspace/.npm-cache
npm test
npm run demo
npm run pack:check
npm run benchmark
```

43 tests passent, sans skipped/expected-failure. Ils comprennent SIGKILL aux frontières
d’ingestion, checkpoint, migration et réservation d’outbox, crash après commit avant
retrait de l’outbox, ainsi que quatre producteurs concurrents. Les tests de non-réseau et
frontières d’import restent présents. La démonstration passe par de vrais processus CLI,
le worker, les actions, une pièce jointe volumineuse, provenance et reçus, puis export/import.

`pack:check` vérifie une installation hors ligne du tarball dans un dossier vierge,
le binaire CLI, son daemon/worker, un checkpoint et sa matérialisation. Aucune publication
npm, aucun commit/push et aucune installation de hooks Cursor n’ont été effectués.
Les résultats de benchmark sont consignés dans docs/benchmark-results.json.

## Limites restantes

- L’ingestion attend encore la fin d’une capture dans la file du worker. Le transport,
  le statut et la backpressure restent réactifs ; l’outbox absorbe les événements.
  Pas d’exécution parallèle de captures ni d’annulation d’une capture active.
- Les reçus couvrent createCheckpoint, en plus de l’idempotence native appendEvents et
  putAttachment. Pas encore toutes les écritures, notamment matérialisation/timelines.
- Le SDK ne prépare pas automatiquement les pièces jointes hors connexion : le producteur
  doit les conserver puis les déposer avant livraison des événements référents.
- Le modèle d’action persiste une projection explicite et ses conflits ; il ne prouve pas
  l’attribution exacte de changements concurrents et ne contrôle aucun processus externe.
- Import/export JSON toujours borné à 128 Mio de payload, sans streaming. Pas de fusion
  d’archives, de garbage collector ou d’export de partage expurgé.
- Tests filesystem à élargir : changements d’inventaire multiprocessus, permissions,
  courses sur le parent de matérialisation, SIGKILL durant publication de fichiers et
  nettoyage guidé des répertoires temporaires. Pas de garantie de snapshot global.
- Paquet npm unique avec API core/protocol/adapter-sdk exportée. Modules encore regroupés
  dans un build ; adaptateur Cursor non implémenté. Pas de CI distante exécutée.
- Linux seulement. Pas de MCP, watcher, restauration en place, worktree Git automatique,
  synchronisation réseau ou CRDT.

## Cursor et suite

Lors de la vérification précédente, la documentation https://cursor.com/docs/hooks
était refusée par le proxy (CONNECT 403) et les exécutables Cursor étaient absents.
Ce constat ne vaut pas nouveau test d’accès. Le contrat public et la version réelle
doivent être vérifiés avant d’écrire l’adaptateur et ses fixtures. Les fonctions du
cœur n’ont pas besoin de cet accès.

Prochaine tranche : file durable des pièces jointes côté SDK, reçus d’opération pour
les autres écritures, export streaming et tests de publication/récupération filesystem.
Puis intégration Cursor dès que ses contrats publics sont accessibles.

## Reprise dans le cloud

Utiliser `/workspace/HyperWeave`, sans worktree supplémentaire sauf demande explicite :
chaque tâche cloud est déjà isolée. Le daemon doit être relancé après restauration de
l’environnement. Ne pas supprimer un verrou occupé ; voir docs/recovery.md.
Les 0.1 existantes migrent en 0.2 à l’ouverture ; sauvegarder avant de changer de version.
Ne jamais committer archives, sorties de démonstration ou secrets.
