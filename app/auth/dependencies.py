from fastapi import Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User


def get_current_user(request: Request, db: Session = Depends(get_db)) -> User:
    user_id = request.session.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)

    user = db.query(User).filter(User.id == user_id, User.is_active.is_(True)).first()
    if not user:
        request.session.clear()
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)
    return user


def get_permission_names(user: User) -> set[str]:
    return {
        permission.name
        for role in user.roles
        for permission in role.permissions
    }


def require_permission(permission_name: str):
    def dependency(user: User = Depends(get_current_user)) -> User:
        if permission_name not in get_permission_names(user):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN)
        return user

    return dependency
