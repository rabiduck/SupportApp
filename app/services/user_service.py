from typing import Optional

from sqlalchemy.orm import Session

from app.auth.security import hash_password
from app.models.user import Role, User


def create_user(
    db: Session,
    username: str,
    display_name: str,
    password: str,
    email: Optional[str] = None,
) -> User:
    username = username.strip().lower()
    if db.query(User).filter(User.username == username).first():
        raise ValueError(f"Username '{username}' already exists.")

    if email:
        email = email.strip().lower()
        if db.query(User).filter(User.email == email).first():
            raise ValueError(f"Email address '{email}' already exists.")

    engineer_role = db.query(Role).filter(Role.name == "Engineer").first()
    user = User(
        username=username,
        display_name=display_name.strip(),
        email=email or None,
        password_hash=hash_password(password),
        is_active=True,
    )
    if engineer_role:
        user.roles.append(engineer_role)

    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def update_user(
    db: Session,
    user_id: int,
    display_name: str,
    email: Optional[str],
    is_active: bool,
) -> User:
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise ValueError("User not found.")

    if email:
        email = email.strip().lower()
        existing = db.query(User).filter(User.email == email, User.id != user_id).first()
        if existing:
            raise ValueError(f"Email address '{email}' already exists.")

    if user.is_active and not is_active and any(role.name == "SystemAdmin" for role in user.roles):
        active_admins = (
            db.query(User)
            .join(User.roles)
            .filter(Role.name == "SystemAdmin", User.is_active.is_(True))
            .all()
        )
        if len(active_admins) <= 1:
            raise ValueError("The only active SystemAdmin account cannot be deactivated.")

    user.display_name = display_name.strip()
    user.email = email or None
    user.is_active = is_active
    db.commit()
    db.refresh(user)
    return user


def set_user_roles(db: Session, user_id: int, role_ids: list[int]) -> User:
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise ValueError("User not found.")

    roles = db.query(Role).filter(Role.id.in_(role_ids)).all() if role_ids else []
    removing_system_admin = any(r.name == "SystemAdmin" for r in user.roles) and not any(
        r.name == "SystemAdmin" for r in roles
    )
    if removing_system_admin and user.is_active:
        active_admins = (
            db.query(User)
            .join(User.roles)
            .filter(Role.name == "SystemAdmin", User.is_active.is_(True))
            .all()
        )
        if len(active_admins) <= 1:
            raise ValueError("The only active SystemAdmin cannot lose that role.")

    user.roles = roles
    db.commit()
    db.refresh(user)
    return user


def reset_password(db: Session, user_id: int, password: str) -> User:
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise ValueError("User not found.")
    user.password_hash = hash_password(password)
    db.commit()
    db.refresh(user)
    return user
