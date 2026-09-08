from app.database import SessionLocal
from app.models.user import Permission, Role, User

PERMISSIONS = {
    "MANAGE_USERS": "Create, edit and administer portal users.",
    "MANAGE_TEAMS": "Create, edit and administer teams.",
    "MANAGE_EMPLOYEES": "Create, edit and administer employees.",
}

ROLE_PERMISSIONS = {
    "Engineer": [],
    "SystemAdmin": list(PERMISSIONS),
}


def main():
    db = SessionLocal()
    try:
        permissions = {}
        for name, description in PERMISSIONS.items():
            permission = db.query(Permission).filter(Permission.name == name).first()
            if not permission:
                permission = Permission(name=name, description=description)
                db.add(permission)
                db.flush()
            else:
                permission.description = description
            permissions[name] = permission

        for role_name, permission_names in ROLE_PERMISSIONS.items():
            role = db.query(Role).filter(Role.name == role_name).first()
            if not role:
                role = Role(name=role_name)
                db.add(role)
                db.flush()
            role.permissions = [permissions[name] for name in permission_names]

        # Re-running the seed after an administrator account exists restores
        # SystemAdmin membership if a development database was rebuilt.
        admin_user = db.query(User).filter(User.username == "sa").first()
        system_admin = db.query(Role).filter(Role.name == "SystemAdmin").first()
        if admin_user and system_admin and system_admin not in admin_user.roles:
            admin_user.roles.append(system_admin)

        db.commit()
        print("RBAC seed complete.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
