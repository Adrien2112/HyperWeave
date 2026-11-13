# Capture, couverture et restitution

`coverage --workspace ID` permet l’inspection préalable. En Git, le workspace doit
être la racine : `git ls-files --cached --others --exclude-standard -z` inclut les
fichiers suivis même devenus ignorés et les non suivis non ignorés. Aucun index, HEAD
ou branche n’est modifié. Les submodules ne sont pas capturés récursivement. Sans Git,
la politique est l’arborescence des fichiers réguliers. Les répertoires vides ne font
pas partie du manifeste. Aucun watcher pour l’instant : chaque capture réconcilie
entièrement le disque et ne prétend pas observer les buffers non sauvegardés.

Exclusions par défaut : `.git`, stockage de l’archive, `.env`, `.env.local`,
`.hyperweave`. Les exclusions configurables sont des chemins relatifs exacts ou des
préfixes de répertoire, pas des globs. Un fichier de politique passé à
`workspace add --policy FILE` contient `exclude`, `max_file`, `max_total`.
Par défaut 32 Mio/fichier et 512 Mio/capture ; ces plafonds peuvent être abaissés.
Leur empreinte SHA-256 et les exclusions observées sont dans chaque manifeste.
Les chemins Git ignorés sont hors périmètre ; ils ne sont pas listés individuellement.

Mode strict : anomalie de type ou de taille = échec sans checkpoint. Mode partial :
ces fichiers sont omis avec raison et `metadata.partial=true`. Les exclusions de
politique ne sont pas des anomalies ; toute restauration reste limitée à la couverture.
Aucune troncature d’octets. Le scan contrôle inode, taille, mtime/ctime, inventaire et
hashes au cours de deux passes complètes ; au maximum trois tentatives. Une instabilité
persistante retourne CAPTURE_UNSTABLE sans dégrader silencieusement la qualité.

Qualités : observed décrit une fenêtre d’observation ; quiescent ajoute l’affirmation
explicite du demandeur qu’il a arrêté les écrivains connus. Même avec deux hashes
identiques, ce n’est pas un snapshot atomique et cela ne protège pas contre un écrivain
externe non coopératif. event_cut est pris avant capture et ne prouve pas que tous les
événements externes antérieurs ont été livrés.

Les entrées sont triées par chemin selon l’ordre UTF-16 JavaScript. UTF-8 seulement ;
chemins absolus, `..`, NUL, antislash, deux-points et collisions NFC/casse refusés.
Le rejet des collisions de casse est conservateur même sur Linux. Les liens symboliques
ne sont jamais suivis pour lire un contenu. Les lectures ancrent chaque parent par un
descripteur Linux. Les limites couvrent le nombre de fichiers (100 000) et une profondeur de
128 niveaux pour l’inventaire hors Git. L’arbre doit rester contrôlé par l’utilisateur local.

Matérialisation : vérifier intégrité et noms, staging privé dans le parent, écrire et
fsync les fichiers, vérifier les hashes, réserver la cible absente, renommer le staging.
Un échec nettoie le staging sans toucher à la source ; un SIGKILL peut laisser un dossier
`.hyperweave-staging-*` ou une réservation vide à inspecter. Cette publication n’est
pas un protocole de reprise après panne électrique ; les répertoires parents ne sont
pas fsync. Aucun remplacement d’une cible préexistante, même vide. Permissions
conservées : exécutable ou non (0755/0644), pas ACL, propriétaire ou timestamps.
