from fastapi import APIRouter, Depends, Form, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy.orm import Session, joinedload

from app.auth.dependencies import get_permission_names, require_permission
from app.database import get_db
from app.models.employee import Employee
from app.models.team import Team
from app.models.user import User
from app.services.employee_service import activate_employee, create_employee, deactivate_employee, update_employee

router = APIRouter(prefix="/admin/employees", tags=["employees"])
templates = Jinja2Templates(directory="app/templates")


def context(request: Request, user: User, **kwargs):
    return {"request": request, "current_user": user, "permissions": get_permission_names(user), **kwargs}


def options(db: Session):
    teams = db.query(Team).filter(Team.is_active.is_(True)).order_by(Team.name).all()
    users = db.query(User).filter(User.is_active.is_(True)).order_by(User.display_name).all()
    return teams, users


@router.get("", response_class=HTMLResponse)
def list_employees(request: Request, q: str = "", db: Session = Depends(get_db), user: User = Depends(require_permission("MANAGE_EMPLOYEES"))):
    query = db.query(Employee).options(joinedload(Employee.team), joinedload(Employee.user)).order_by(Employee.display_name)
    if q:
        query = query.filter(Employee.display_name.ilike(f"%{q}%"))
    return templates.TemplateResponse("employees/list.html", context(request, user, employees=query.all(), q=q))


@router.get("/create", response_class=HTMLResponse)
def create_form(request: Request, db: Session = Depends(get_db), user: User = Depends(require_permission("MANAGE_EMPLOYEES"))):
    teams, users = options(db)
    return templates.TemplateResponse("employees/create.html", context(request, user, teams=teams, users=users, error=None))


@router.post("/create")
def create_post(request: Request, display_name: str = Form(...), team_id: int = Form(...), user_id: str = Form(""), job_title: str = Form(""), phone: str = Form(""), db: Session = Depends(get_db), user: User = Depends(require_permission("MANAGE_EMPLOYEES"))):
    try:
        employee = create_employee(db, display_name, int(user_id) if user_id else None, team_id, job_title or None, phone or None)
        return RedirectResponse(url=f"/admin/employees/{employee.id}", status_code=303)
    except ValueError as exc:
        teams, users = options(db)
        return templates.TemplateResponse("employees/create.html", context(request, user, teams=teams, users=users, error=str(exc)), status_code=400)


@router.get("/{employee_id}", response_class=HTMLResponse)
def detail(employee_id: int, request: Request, db: Session = Depends(get_db), user: User = Depends(require_permission("MANAGE_EMPLOYEES"))):
    employee = db.query(Employee).options(joinedload(Employee.team), joinedload(Employee.user)).filter(Employee.id == employee_id).first()
    if not employee:
        return RedirectResponse(url="/admin/employees", status_code=303)
    return templates.TemplateResponse("employees/detail.html", context(request, user, employee=employee))


@router.get("/{employee_id}/edit", response_class=HTMLResponse)
def edit_form(employee_id: int, request: Request, db: Session = Depends(get_db), user: User = Depends(require_permission("MANAGE_EMPLOYEES"))):
    employee = db.query(Employee).filter(Employee.id == employee_id).first()
    if not employee:
        return RedirectResponse(url="/admin/employees", status_code=303)
    teams, users = options(db)
    return templates.TemplateResponse("employees/edit.html", context(request, user, employee=employee, teams=teams, users=users, error=None))


@router.post("/{employee_id}/edit")
def edit_post(employee_id: int, request: Request, display_name: str = Form(...), team_id: int = Form(...), user_id: str = Form(""), job_title: str = Form(""), phone: str = Form(""), is_active: bool = Form(False), db: Session = Depends(get_db), user: User = Depends(require_permission("MANAGE_EMPLOYEES"))):
    try:
        update_employee(db, employee_id, display_name, int(user_id) if user_id else None, team_id, job_title or None, phone or None, is_active)
        return RedirectResponse(url=f"/admin/employees/{employee_id}", status_code=303)
    except ValueError as exc:
        employee = db.query(Employee).filter(Employee.id == employee_id).first()
        teams, users = options(db)
        return templates.TemplateResponse("employees/edit.html", context(request, user, employee=employee, teams=teams, users=users, error=str(exc)), status_code=400)


@router.post("/{employee_id}/deactivate")
def deactivate(employee_id: int, db: Session = Depends(get_db), _: User = Depends(require_permission("MANAGE_EMPLOYEES"))):
    deactivate_employee(db, employee_id)
    return RedirectResponse(url=f"/admin/employees/{employee_id}", status_code=303)


@router.post("/{employee_id}/activate")
def activate(employee_id: int, db: Session = Depends(get_db), _: User = Depends(require_permission("MANAGE_EMPLOYEES"))):
    activate_employee(db, employee_id)
    return RedirectResponse(url=f"/admin/employees/{employee_id}", status_code=303)
