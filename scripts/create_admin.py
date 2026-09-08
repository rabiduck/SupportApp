from getpass import getpass

from app.auth.security import hash_password
from app.database import SessionLocal
from app.models.user import Role, User


def main():
    db = SessionLocal()
    try:
        username = input("Admin username [sa]: ").strip().lower() or "sa"
        display_name = input("Display name [System Administrator]: ").strip() or "System Administrator"
        password = getpass("Password: ")
        confirm = getpass("Confirm password: ")
        if password != confirm:
            raise SystemExit("Passwords do not match.")
        if not password:
            raise SystemExit("Password cannot be empty.")

        user = db.query(User).filter(User.username == username).first()
        if user:
            user.display_name = display_name
            user.password_hash = hash_password(password)
            user.is_active = True
        else:
            user = User(
                username=username,
                display_name=display_name,
                password_hash=hash_password(password),
                is_active=True,
            )
            db.add(user)
            db.flush()

        system_admin = db.query(Role).filter(Role.name == "SystemAdmin").first()
        if not system_admin:
            raise SystemExit("SystemAdmin role not found. Run python -m scripts.seed_rbac first.")
        if system_admin not in user.roles:
            user.roles.append(system_admin)

        db.commit()
        print(f"Administrator '{username}' ready.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
