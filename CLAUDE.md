# CLAUDE.md

Guide projet pour Claude Code. **Source de vérité unique** pour construire PixelReveal.
Lis ce fichier en entier avant d'écrire la moindre ligne.

> État actuel : projet en phase d'initialisation. Repo et structure posés, **aucun code applicatif** écrit pour le moment. Démarrer par le MVP (§11), dans l'ordre du backlog Trello (§14).

---

## 1. Pitch

Un canvas pixel partagé. Tout le monde démarre face à un écran noir découpé en pixels.
Chaque clic révèle la vraie couleur cachée d'un pixel. Collectivement, les joueurs
reconstituent un artwork pixel art. Une fois l'image complète, on passe à la suivante. En boucle.

Pas de compte. Juste un pseudo.

## 2. Nature du projet (à garder en tête en permanence)

Ce n'est **pas** un jeu gagner/perdre. C'est une **expérience collaborative de progression**,
proche d'un One Million Checkboxes ou d'un r/place coloriage. Le seul paramètre que le joueur
contrôle, c'est *où* il clique. L'intérêt vient de deux choses : la satisfaction de voir l'image
émerger, et la présence sociale.

Implications de design **non négociables** :
- Cliquer **révèle** une couleur prédéterminée ; le joueur ne choisit jamais la couleur.
- Aucun état "faux", aucune erreur possible, aucun échec.
- Progression **monotone** : le pourcentage ne fait que monter.
- Un pixel révélé est **figé**, non re-modifiable. Zéro grief possible.

## 3. Stack technique

Tout sur **Cloudflare**. Une seule plateforme, zéro galère de cross-origin WebSocket.

| Couche | Choix | Raison |
|---|---|---|
| Front | Cloudflare Pages, vanilla JS + Canvas 2D | Léger, pas de framework, rendu canvas obligatoire |
| Backend temps réel | Cloudflare Workers + Durable Objects | État autoritaire persistant, WS longue durée, mono-thread = pas de race |
| Persistance | Durable Object Storage | Survit aux redémarrages et à l'hibernation |
| Langage backend | TypeScript | Imposé par le runtime Workers |
| Génération d'assets | Python + Pillow (PIL) | Pixellise l'image et produit l'asset serveur |

Backend en TypeScript (pas Python) : c'est le bon fit pour Durable Objects, choix d'architecture
assumé. Pas Vercel : serverless sans état, pas de WS longue durée, pas d'autorité unique. Inadapté.

## 4. Architecture

### 4.1 Pipeline de rooms
Le jeu est une **séquence ordonnée d'artworks**. Chaque artwork est un canvas partagé.
- **Un Durable Object par artwork = une room.** Le DO tient la grille en mémoire, la persiste,
  termine les WebSockets de la room, sérialise les écritures (mono-thread). Cooldown et
  progression monotone sans race condition.
- **Un DO coordinateur** (singleton) garde l'ordre du pipeline, l'index de la frontière
  (l'artwork le plus avancé déjà ouvert), et le compteur global de joueurs en ligne.

### 4.2 État autoritaire serveur, client = vue
Le serveur est seule source de vérité. Toute désynchro se résout en faveur du serveur.

### 4.3 Image secrète
Le client **ne connaît jamais l'image complète à l'avance**. Le DO détient la clé de réponse
(`answer`). Au clic, le serveur lit la vraie couleur du pixel et ne renvoie **que celle-là**.
Protège la magie du reveal et ferme la porte au cheat client. Un joueur en cours de partie reçoit
l'état des pixels **déjà révélés**, rien d'autre.

### 4.4 Cooldown
2 secondes par joueur, **arbitré côté serveur**. Le DO maintient `sessionId -> timestamp du
dernier clic accepté`. Un clic trop tôt est rejeté. De fait global (un joueur = une room à la
fois). Pièce maîtresse du collaboratif et de l'anti-bot.

### 4.5 Persistance
Chaque DO d'artwork persiste son tableau `revealed`. Survit aux redémarrages et à l'hibernation.
`answer` et la palette sont chargés depuis l'asset statique au démarrage de la room.

### 4.6 Identité, sans auth
Identité = `pseudo` saisi + `sessionId` généré côté client et stocké en `localStorage`. Le
`sessionId` porte le cooldown et suit le joueur de room en room. Le `pseudo` sert au classement.

### 4.7 Flow de complétion
Quand la frontière atteint 100% :
1. La room diffuse `completed`.
2. Côté client, une **popup** marque un temps : beat de célébration + classement des pseudos.
3. Après le beat, tout le monde bascule **ensemble** sur l'artwork suivant. Le serveur avance la
   frontière (crée la room suivante si besoin) et pousse un nouveau `welcome`.

Un seul artwork vivant à la fois, partagé par tous. Pas de divergence.

### 4.8 Connexion d'un nouveau joueur
Rejoint **toujours l'artwork en cours** (la frontière), jamais le départ ni une œuvre archivée.
Le coordinateur route vers la bonne room. Cas limite : si la room ciblée vient d'atteindre 100%,
lui envoyer `completed` immédiatement pour qu'il prenne le beat puis bascule avec les autres.

### 4.9 Boucle infinie
Pipeline épuisé → on **cycle** (retour au premier artwork, canvas vierge). Paramétrable
(cycle / reshuffle / stop), défaut = cycle.

## 5. Assets : format et génération

### 5.1 Format d'un artwork
```json
{
  "id": "artwork-001",
  "width": 300,
  "height": 300,
  "palette": ["#0d0d0d", "#e8c39e", "#a33b2a", "..."],
  "answer": [/* width*height index de couleur, un par pixel, row-major */]
}
```
- Palette indexée par image, taille variable. Index sur 1 octet → jusqu'à 255 couleurs + 1
  sentinelle (`0xFF`) pour "non révélé". Image trop riche → réduire la palette à la génération.
- Dimensions cibles : 250x250 à 500x500. Variables d'un artwork à l'autre.

### 5.2 Script PIL
`tools/pixelize.py` prend une image source et sort l'asset complet. Pipeline :
`resize((W,H), Image.NEAREST)` → `.quantize(colors=N)` → extraction index + palette. Produit
directement le format §5.1. Déterministe et reproductible.

### 5.3 Pipeline initial
- **Premier artwork imposé** (`artwork-001`, image de lancement fixe).
- Les suivants rangés dans `assets/pipeline.json` (liste ordonnée d'ids).

## 6. Protocole WebSocket

Messages compacts. Snapshot initial en binaire, deltas minuscules. Types partagés dans
`worker/protocol.ts`.

### Client → Serveur
- `hello { pseudo, sessionId }` : rejoint l'artwork en cours.
- `paint { i }` : tente de révéler le pixel d'index `i`.

### Serveur → Client
- `welcome { artworkId, width, height, palette, snapshot, progress, online }` : `snapshot` =
  `Uint8Array` de longueur `width*height`, octet = index couleur ou `0xFF`. Frame binaire.
- `painted { i, c }` : delta diffusé à la room. Optionnellement `pseudo`.
- `progress { revealed, total }` : peut être piggybacké sur `painted`.
- `completed {}` : 100% atteint → beat. Le serveur enchaîne un nouveau `welcome`.
- `online { count }` : compteur de joueurs en ligne.
- `cooldown { until }` : ack/rejet d'un `paint`.

### État détenu par chaque DO d'artwork
- `answer: Uint8Array` (jamais envoyé en bloc), `revealed: Uint8Array` (persisté),
  `palette: string[]`, `width`, `height`, `revealedCount: number`,
  `cooldowns: Map<sessionId, ts>`, `tally: Map<pseudo, number>`, sockets connectés.

## 7. Boucle de gameplay
```
saisir pseudo
  → rejoindre l'artwork en cours / frontière (welcome + snapshot)
  → cliquer un pixel non révélé
       → cooldown ok ? → révélé, broadcast painted, +1 au tally
       → cooldown ko ? → rejet
  → attendre 2s, recommencer
  → artwork à 100% → popup beat (image + classement)
       → beat terminé (clic/timeout) → bascule partagée vers l'artwork suivant
  → boucle
```

## 8. Front
- **Rendu Canvas 2D obligatoire.** Jamais une grille de divs DOM.
- Au `welcome`, peindre le snapshot d'un coup (non révélés en noir/fond).
- Au `painted`, ne repeindre que le pixel concerné.
- Barre de progression live (`revealed / total`) + compteur de joueurs en ligne.
- Écran pseudo : 1 champ, `localStorage`, `sessionId` généré au premier lancement.
- Popup de complétion : beat de transition, ferme au clic ou court timeout.
- Feedback sensoriel léger au dépôt du pixel, flash à 100%. Le hook émotionnel.

## 9. Anti-bot
- **Cooldown serveur 2s** par session (fait 80% du boulot).
- **Rate-limit** complémentaire par IP / session côté Worker.
- **Jamais** envoyer l'image complète ni la palette comme clé de triche.

## 10. Conventions de code
- TypeScript strict côté backend. Vanilla JS lisible côté front.
- Pas de framework front au MVP. Pas de dépendance superflue.
- Deltas, pas de full state à chaque message.
- Commenter le *pourquoi*, pas le *quoi*. Nommage clair, fonctions courtes.
- Commits atomiques, un sujet par commit.

## 11. Découpage

### MVP
- Écran pseudo + sessionId.
- Une room (DO d'artwork) : snapshot, paint, broadcast, cooldown, persistance.
- Front canvas + barre de progression + compteur en ligne.
- Détection de complétion + beat + transition partagée.
- Coordinateur de pipeline + cycle.
- Script PIL + premier artwork imposé.

### Post-MVP
- Curseurs live, contribution perso, classement, galerie, spectateur, partage social.

## 12. Structure de fichiers
```
/
  CLAUDE.md
  wrangler.toml
  /worker
    index.ts            # routeur Worker, dispatch vers les DO
    artwork-room.ts     # Durable Object : une room d'artwork
    coordinator.ts      # Durable Object : pipeline + frontière + online global
    protocol.ts         # types des messages WS partagés
  /public               # front statique (Cloudflare Pages)
    index.html
    main.js             # canvas, WS, popup, pseudo
    style.css
  /assets
    pipeline.json       # ordre des artworks
    artwork-001.json    # asset généré (imposé au lancement)
  /tools
    pixelize.py         # génération d'assets via PIL
```

## 13. Commandes
```bash
# Backend (Workers + Durable Objects)
npm install
npx wrangler dev          # dev local
npx wrangler deploy       # déploiement

# Front (Cloudflare Pages) : wrangler pages deploy ./public

# Génération d'un asset
python tools/pixelize.py source.png --size 300 --colors 32 --out assets/artwork-002.json
```
Vérifier les exigences exactes (Node, wrangler) au moment du build, ne pas se fier à la mémoire.

## 14. Backlog Trello

Board "PixelReveal". Colonnes Kanban : `Backlog` / `To Do` / `In Progress` / `Review` / `Done`.
Cartes (regroupées par epic) :

**Epic Setup** — Init repo + wrangler.toml + structure · Configurer Pages + Workers + binding DO ·
Définir les types du protocole WS (protocol.ts)

**Epic Assets** — Script PIL pixelize.py · Générer/figer artwork-001 · Définir pipeline.json

**Epic Room (DO)** — Chargement asset au boot · Connexions WS + welcome + snapshot binaire ·
paint (cooldown + révélation + persistance) · Broadcast painted + progress · Détection 100% +
completed · Persistance revealed + reprise · tally par pseudo

**Epic Coordinateur** — Ordre pipeline + index frontière · Router connexions vers la frontière ·
Création à la demande room suivante + transition (push welcome) · Compteur global online · Cycle

**Epic Front** — Écran pseudo + sessionId · Connexion WS + rendu snapshot · Clic → paint +
cooldown visuel · painted → repeindre · Barre progression + compteur · Popup de complétion ·
Bascule partagée vers l'artwork suivant · Feedback sensoriel

**Epic Anti-bot** — Rate-limit IP/session côté Worker · Tests : un script ne dépasse pas le cooldown

**Epic Polish (post-MVP)** — Curseurs live · Contribution perso · Galerie · Mode spectateur ·
Partage social

---

## Rappels finaux
- Source de vérité = serveur. Client = vue.
- Image secrète, couleur révélée au clic seulement.
- Cooldown serveur 2s, progression monotone, pixel figé.
- Canvas, jamais de grille DOM.
- Un Durable Object par artwork. Pipeline en boucle.
- Commencer par le MVP (§11), dans l'ordre du backlog.
