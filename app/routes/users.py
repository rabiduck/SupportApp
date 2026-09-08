from fastapi import APIRouter, Depends, Form, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy.orm import Session, joinedload

from app.auth.dependencies import get_permission_names, require_permission
from app.database import get_db
from app.models.user import Role, User
from app.services.user_service import create_user, reset_password, set_user_roles, update_user

router = APIRouter(prefix="/admin/users", tags=["users"])
templates = Jinja2Templates(directory="app/templates")


def context(request: Request, user: User, **kwargs):
    return {"request": request, "current_user": user, "permissions": get_permission_names(user), **kwargs}


@router.get("", response_class=HTMLResponse)
def list_users(request: Request, q: str = "", db: Session = Depends(get_db), user: User = Depends(require_permission("MANAGE_USERS"))):
    query = db.query(User).options(joinedload(User.roles)).order_by(User.display_name)
    if q:
        query = query.filter((User.username.ilike(f"%{q}%")) | (User.display_name.ilike(f"%{q}%")))
    return templates.TemplateResponse("users/list.html", context(request, user, users=query.all(), q=q))


@router.get("/create", response_class=HTMLResponse)
def create_form(request: Request, user: User = Depends(require_permission("MANAGE_USERS"))):
    return templates.TemplateResponse("users/create.html", context(request, user, error=None))


@router.post("/create")
def create_post(request: Request, username: str = Form(...), display_name: str = Form(...), email: str = Form(""), password: str = Form(...), db: Session = Depends(get_db), user: User = Depends(require_permission("MANAGE_USERS"))):
    try:
        new_user = create_user(db, username, display_name, password, email or None)
        return RedirectResponse(url=f"/admin/users/{new_user.id}", status_code=303)
    except ValueError as exc:
        return templates.TemplateResponse("users/create.html", context(request, user, error=str(exc)), status_code=400)


@router.get("/{user_id}", response_class=HTMLResponse)
def detail(user_id: int, request: Request, db: Session = Depends(get_db), user: User = Depends(require_permission("MANAGE_USERS"))):
    target = db.query(User).options(joinedload(User.roles)).filter(User.id == user_id).first()
    if not target:
        return RedirectResponse(url="/admin/users", status_code=303)
    return templates.TemplateResponse("users/detail.html", context(request, user, target=target))


@router.get("/{user_id}/edit", response_class=HTMLResponse)
def edit_form(user_id: int, request: Request, db: Session = Depends(get_db), user: User = Depends(require_permission("MANAGE_USERS"))):
    target = db.query(User).filter(User.id == user_id).first()
    roles = db.query(Role).order_by(Role.name).all()
    if not target:
        return RedirectResponse(url="/admin/users", status_code=303)
    return templates.TemplateResponse("users/edit.html", context(request, user, target=target, roles=roles, error=None))


@router.post("/{user_id}/edit")
def edit_post(user_id: int, request: Request, display_name: str = Form(...), email: str = Form(""), is_active: bool = Form(False), role_ids: list[int] = Form([]), db: Session = Depends(get_db), user: User = Depends(require_permission("MANAGE_USERS"))):
    try:
        update_user(db, user_id, display_name, email or None, is_active)
        set_user_roles(db, user_id, role_ids)
        return RedirectResponse(url=f"/admin/users/{user_id}", status_code=303)
    except ValueError as exc:
        target = db.query(User).filter(User.id == user_id).first()
        roles = db.query(Role).order_by(Role.name).all()
        return templates.TemplateResponse("users/edit.html", context(request, user, target=target, roles=roles, error=str(exc)), status_code=400)


@router.post("/{user_id}/reset-password")
def reset_password_post(user_id: int, password: str = Form(...), db: Session = Depends(get_db), _: User = Depends(require_permission("MANAGE_USERS"))):
    reset_password(db, user_id, password)
    return RedirectResponse(url=f"/admin/users/{user_id}", status_code=303)
