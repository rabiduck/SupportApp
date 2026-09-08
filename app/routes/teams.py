from fastapi import APIRouter, Depends, Form, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy.orm import Session, joinedload

from app.auth.dependencies import get_permission_names, require_permission
from app.database import get_db
from app.models.department import Department
from app.models.team import Team
from app.models.user import User
from app.services.team_service import create_team, set_team_active, update_team

router = APIRouter(prefix="/admin/teams", tags=["teams"])
templates = Jinja2Templates(directory="app/templates")


def context(request: Request, user: User, **kwargs):
    return {
        "request": request,
        "current_user": user,
        "permissions": get_permission_names(user),
        **kwargs,
    }


@router.get("", response_class=HTMLResponse)
def list_teams(
    request: Request,
    q: str = "",
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("MANAGE_TEAMS")),
):
    query = (
        db.query(Team)
        .options(joinedload(Team.department), joinedload(Team.employees))
        .order_by(Team.name)
    )
    if q:
        query = query.filter(Team.name.ilike(f"%{q}%"))
    return templates.TemplateResponse(
        "teams/list.html",
        context(request, user, teams=query.all(), q=q),
    )


@router.get("/create", response_class=HTMLResponse)
def create_team_form(
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("MANAGE_TEAMS")),
):
    departments = db.query(Department).filter(Department.is_active.is_(True)).order_by(Department.name).all()
    return templates.TemplateResponse(
        "teams/create.html",
        context(request, user, departments=departments, error=None),
    )


@router.post("/create")
def create_team_post(
    request: Request,
    name: str = Form(...),
    department_id: int = Form(...),
    description: str = Form(""),
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("MANAGE_TEAMS")),
):
    try:
        team = create_team(db, department_id, name, description)
        return RedirectResponse(url=f"/admin/teams/{team.id}", status_code=303)
    except ValueError as exc:
        departments = db.query(Department).filter(Department.is_active.is_(True)).order_by(Department.name).all()
        return templates.TemplateResponse(
            "teams/create.html",
            context(request, user, departments=departments, error=str(exc), form={"name": name, "department_id": department_id, "description": description}),
            status_code=400,
        )


@router.get("/{team_id}", response_class=HTMLResponse)
def team_detail(
    team_id: int,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("MANAGE_TEAMS")),
):
    team = (
        db.query(Team)
        .options(joinedload(Team.department), joinedload(Team.employees))
        .filter(Team.id == team_id)
        .first()
    )
    if not team:
        return RedirectResponse(url="/admin/teams", status_code=303)
    return templates.TemplateResponse("teams/detail.html", context(request, user, team=team))


@router.get("/{team_id}/edit", response_class=HTMLResponse)
def edit_team_form(
    team_id: int,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("MANAGE_TEAMS")),
):
    team = db.query(Team).filter(Team.id == team_id).first()
    if not team:
        return RedirectResponse(url="/admin/teams", status_code=303)
    departments = db.query(Department).filter(Department.is_active.is_(True)).order_by(Department.name).all()
    return templates.TemplateResponse(
        "teams/edit.html",
        context(request, user, team=team, departments=departments, error=None),
    )


@router.post("/{team_id}/edit")
def edit_team_post(
    team_id: int,
    request: Request,
    name: str = Form(...),
    department_id: int = Form(...),
    description: str = Form(""),
    is_active: bool = Form(False),
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("MANAGE_TEAMS")),
):
    try:
        update_team(db, team_id, department_id, name, description, is_active)
        return RedirectResponse(url=f"/admin/teams/{team_id}", status_code=303)
    except ValueError as exc:
        team = db.query(Team).filter(Team.id == team_id).first()
        departments = db.query(Department).filter(Department.is_active.is_(True)).order_by(Department.name).all()
        return templates.TemplateResponse(
            "teams/edit.html",
            context(request, user, team=team, departments=departments, error=str(exc)),
            status_code=400,
        )


@router.post("/{team_id}/deactivate")
def deactivate_team(
    team_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("MANAGE_TEAMS")),
):
    set_team_active(db, team_id, False)
    return RedirectResponse(url=f"/admin/teams/{team_id}", status_code=303)


@router.post("/{team_id}/activate")
def activate_team(
    team_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("MANAGE_TEAMS")),
):
    set_team_active(db, team_id, True)
    return RedirectResponse(url=f"/admin/teams/{team_id}", status_code=303)
