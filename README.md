# STUDY OS

STUDY OS est un espace scolaire personnel pour centraliser et organiser les cours d'un lycéen. La hiérarchie centrale est volontairement stricte : **Matière → Thème → Chapitre → Cours**.

## Version actuelle

Cette première version fournit un dashboard responsive, une bibliothèque navigable avec fil d'Ariane, le CRUD complet des matières, thèmes, chapitres et cours, une base SQLite persistante, un thème clair/sombre et des vues placeholders pour les prochaines briques.

Le champ `original_content` est conservé séparément de `content` afin de préserver les données utilisateur avant toute future transformation IA. Les données de démonstration sont identifiables par `source_type=demo`.

## Architecture

```text
STUDY-OS/
├── frontend/              # React + TypeScript + Vite + Tailwind CSS
│   └── src/               # App, client HTTP, types et styles
├── backend/               # FastAPI + SQLAlchemy
│   └── app/               # API, modèles, schémas, base et seed
└── README.md
```

## Installation

Prérequis : Node.js 20+ et Python 3.11+.

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
cd frontend
npm install
```

## Lancement

Terminal 1 :

```bash
source .venv/bin/activate
PYTHONPATH=. uvicorn app.main:app --app-dir backend --reload --port 8000
```

Terminal 2 :

```bash
cd frontend
npm run dev
```

L'interface est disponible sur `http://localhost:5173` et la documentation interactive de l'API sur `http://localhost:8000/docs`.

## API disponible

Chaque ressource expose `GET`, `POST`, `GET /{id}`, `PUT /{id}` et `DELETE /{id}` :

- `/api/subjects`
- `/api/themes`
- `/api/chapters`
- `/api/courses`

Les thèmes exigent une matière existante, les chapitres un thème existant et les cours un chapitre existant. Les suppressions suppriment les descendants associés, après confirmation côté interface.

## Étape 2

La bibliothèque permet maintenant de créer et modifier un cours avec des sélecteurs dépendants Matière → Thème → Chapitre, un éditeur riche, des favoris, une page de détail, le déplacement vers un autre chapitre, la recherche globale et l'import TXT/PDF/DOCX sans analyse IA. `content` et `original_content` restent séparés ; le contenu affiché est nettoyé côté frontend avant rendu.

Les fiches, quiz, OCR, progression et assistant IA restent des modules indépendants pour les prochaines étapes.