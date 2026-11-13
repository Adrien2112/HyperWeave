# Adaptateur Cursor — non implémenté dans cet incrément

Le cœur et la démonstration fonctionnent sans ce dossier. Aucun hook n’a été installé,
aucune base privée de Cursor n’a été lue, aucun agent externe n’a été lancé.

| Surface | Observation dans cet environnement | Validation |
| --- | --- | --- |
| IDE Cursor | exécutable `cursor` absent du PATH | non testée |
| CLI Cursor | exécutable `agent` absent du PATH | non testée |
| Documentation hooks officielle | tentative HTTPS vers https://cursor.com/docs/hooks refusée par le proxy (CONNECT 403), le 2026-11-13 | contrat non vérifié |
| SDK / ACP / stream-json | non utilisés | non testés |

La prochaine étape exige l’accès à la documentation officielle et ses contrats de
version. Une installation réelle de Cursor est nécessaire pour le test réel ; des
fixtures validées peuvent ensuite couvrir la traduction indépendamment de l’éditeur.
Ne pas inventer des noms de hooks ou annoncer une compatibilité sur cette base.

Prévoir un paquet séparé, un installateur dry-run avec sauvegarde, préservation des
hooks existants, idempotence et désinstallation ciblée. Les événements incomplets
restent non corrélés. Aucun rattachement automatique à la dernière conversation.
La reprise matérialisera un nouveau workspace et un contexte explicite ; elle ne
rembobinera pas une conversation Cursor active. Le traitement LLM de Cursor restera
soumis à ses propres modalités, distinctes du stockage local HyperWeave.
