from typing import Optional

from sqlalchemy.orm import Session

from app.models.team import Team


def create_team(
    db: Session,
    department_id: int,
    name: str,
    description: Optional[str] = None,
) -> Team:
    name = name.strip()
    existing = (
        db.query(Team)
        .filter(Team.department_id == department_id, Team.name == name)
        .first()
    )
    if existing:
        raise ValueError(f"Team '{name}' already exists in this department.")

    team = Team(
        department_id=department_id,
        name=name,
        description=description.strip() if description else None,
        is_active=True,
    )
    db.add(team)
    db.commit()
    db.refresh(team)
    return team


def update_team(
    db: Session,
    team_id: int,
    department_id: int,
    name: str,
    description: Optional[str],
    is_active: bool,
) -> Team:
    team = db.query(Team).filter(Team.id == team_id).first()
    if not team:
        raise ValueError("Team not found.")

    name = name.strip()
    existing = (
        db.query(Team)
        .filter(
            Team.department_id == department_id,
            Team.name == name,
            Team.id != team_id,
        )
        .first()
    )
    if existing:
        raise ValueError(f"Team '{name}' already exists in this department.")

    team.department_id = department_id
    team.name = name
    team.description = description.strip() if description else None
    team.is_active = is_active
    db.commit()
    db.refresh(team)
    return team


def set_team_active(db: Session, team_id: int, is_active: bool) -> Team:
    team = db.query(Team).filter(Team.id == team_id).first()
    if not team:
        raise ValueError("Team not found.")
    team.is_active = is_active
    db.commit()
    db.refresh(team)
    return team
