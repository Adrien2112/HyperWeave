# Mesures reproductibles

`npm run benchmark` construit puis mesure deux dossiers hors Git : 1 000 puis
10 000 fichiers texte d’environ 1 Kio, un binaire de 1 Mio, un message d’environ 128 Kio.
Dix fichiers sont remplacés par de petits contenus distincts pour le deuxième checkpoint.
Les fixtures sont créées avant les mesures et supprimées ensuite. Le script consigne
versions, CPU, mémoire et volumes exacts dans sa sortie JSON.

Résultat de référence : [benchmark-results.json](benchmark-results.json), Linux x64,
HyperWeave 0.2.0, Node 24.22.1, Xeon Platinum 8573C, 5 CPU logiques visibles, environ 33 Gio de RAM visibles.
Une seule répétition dans un conteneur partagé, sans purge du cache ; ce n’est ni une
moyenne ni une promesse de latence. Les limites CPU effectives peuvent différer du matériel
visible et les mesures suivantes peuvent varier.

| Opération (ms) | 1 000 textes + binaire | 10 000 textes + binaire |
| --- | ---: | ---: |
| Initialisation | 17,70 | 13,42 |
| Checkpoint initial | 363,76 | 2805,51 |
| Checkpoint après 10 changements | 266,69 | 1990,74 |
| Diff | 6,22 | 51,29 |
| Matérialisation, fsync inclus | 1811,40 | 12109,15 |
| Recherche, 1 événement | 0,84 | 0,63 |

Les blobs augmentent de 100 octets dans les deux cas : seuls les dix nouveaux contenus
s’ajoutent. Le stockage SQLite complet atteint environ 3,88 Mo / 43,89 Mo, WAL et manifests
compris, avant fermeture/checkpoint WAL. Chaque manifeste et index d’entrées est complet :
la déduplication du contenu n’élimine pas leur coût O(nombre de fichiers).
Chaque capture effectue deux inventaires et deux lectures/hachages complets. Il n’y a
aucune revendication d’incrémentalité garantie. La recherche ici ne mesure pas un gros
historique. Un export/import volumineux, des archives nombreuses et des timings p95 restent
à mesurer avant d’établir des objectifs de performance.
