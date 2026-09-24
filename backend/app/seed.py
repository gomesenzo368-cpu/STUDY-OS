from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import Chapter, Course, Subject, Theme


def seed_demo_data(db: Session) -> None:
    if db.scalar(select(Subject.id).limit(1)) is not None:
        return

    maths = Subject(name="Mathématiques", description="Fonctions, suites et raisonnement.", color="#1f7a8c", icon="∑")
    eco = Subject(name="Économie", description="Comprendre les mécanismes de l'économie.", color="#e07a5f", icon="◒")
    management = Subject(name="Management", description="Les organisations et leurs décisions.", color="#6c63a8", icon="⌘")
    french = Subject(name="Français", description="Littérature et expression.", color="#d4a72c", icon="Aa")
    db.add_all([maths, eco, management, french])
    db.flush()

    suites = Theme(subject_id=maths.id, name="Suites", description="Suites arithmétiques et géométriques.", order=1)
    fonctions = Theme(subject_id=maths.id, name="Fonctions", description="Fonctions de référence et affines.", order=2)
    eco_theme = Theme(subject_id=eco.id, name="Les agents économiques", description="Les acteurs et leurs échanges.", order=1)
    management_theme = Theme(subject_id=management.id, name="Les organisations", description="Finalités et ressources.", order=1)
    db.add_all([suites, fonctions, eco_theme, management_theme])
    db.flush()

    arithmetic = Chapter(theme_id=suites.id, name="Suites arithmétiques", description="Définition et propriétés.", order=1)
    geometric = Chapter(theme_id=suites.id, name="Suites géométriques", description="Reconnaître et calculer.", order=2)
    affine = Chapter(theme_id=fonctions.id, name="Fonctions affines", description="Variations et représentations.", order=1)
    agents = Chapter(theme_id=eco_theme.id, name="Ménages et entreprises", description="Rôles et décisions.", order=1)
    db.add_all([arithmetic, geometric, affine, agents])
    db.flush()

    db.add_all([
        Course(chapter_id=arithmetic.id, title="Définition et propriétés", content="Une suite arithmétique est une suite dont la différence entre deux termes consécutifs est constante.", original_content="Une suite arithmétique est une suite dont la différence entre deux termes consécutifs est constante.", source_type="demo", order=1),
        Course(chapter_id=arithmetic.id, title="Calcul du terme général", content="Pour une suite arithmétique de premier terme u₀ et de raison r : uₙ = u₀ + nr.", original_content="Pour une suite arithmétique de premier terme u₀ et de raison r : uₙ = u₀ + nr.", source_type="demo", order=2),
        Course(chapter_id=geometric.id, title="Reconnaître une suite géométrique", content="Une suite géométrique s'obtient en multipliant chaque terme par une même raison.", original_content="Une suite géométrique s'obtient en multipliant chaque terme par une même raison.", source_type="demo", order=1),
        Course(chapter_id=affine.id, title="Lire une fonction affine", content="Une fonction affine s'écrit f(x) = ax + b.", original_content="Une fonction affine s'écrit f(x) = ax + b.", source_type="demo", order=1),
        Course(chapter_id=agents.id, title="Les acteurs économiques", content="Les ménages consomment et offrent leur travail ; les entreprises produisent des biens et services.", original_content="Les ménages consomment et offrent leur travail ; les entreprises produisent des biens et services.", source_type="demo", order=1),
    ])
    db.commit()
