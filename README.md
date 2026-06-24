# PixelReveal

Un canvas pixel art **collaboratif** en temps réel. Tout le monde démarre face à un écran noir.
Chaque clic révèle la vraie couleur cachée d'un pixel ; collectivement les joueurs reconstituent
l'image. À 100%, on passe à l'artwork suivant. En boucle. Pas de compte, juste un pseudo.

Ce n'est pas un jeu gagner/perdre : c'est une expérience de progression partagée, façon
*One Million Checkboxes* / *r/place*.

## Stack
- **Front** : Cloudflare Pages, vanilla JS + Canvas 2D
- **Backend temps réel** : Cloudflare Workers + Durable Objects (un DO par artwork)
- **Persistance** : Durable Object Storage
- **Génération d'assets** : Python + Pillow

## Statut
Phase d'initialisation — aucun code applicatif pour l'instant. Voir [CLAUDE.md](CLAUDE.md) pour
l'architecture complète et le backlog. Le développement suit le MVP décrit au §11.

## Structure
```
/worker     Durable Objects + routeur Worker (TypeScript)
/public     front statique (Canvas, WS)
/assets     artworks générés + pipeline.json
/tools      pixelize.py (génération d'assets PIL)
```
